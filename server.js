
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const crypto     = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Env check ──────────────────────────────────────────
const REQUIRED = ['ADMIN_EMAIL','ADMIN_PASS','JWT_SECRET','SUPABASE_URL','SUPABASE_SERVICE_KEY'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if(missing.length){ console.error('❌ Missing env vars:', missing.join(', ')); process.exit(1); }

// ── Middleware ─────────────────────────────────────────
app.use(helmet());
app.use(express.json({ limit: '20kb' }));
app.use(cors({
  origin: (origin, cb) => {
    // Allow all origins for now — restrict to your Vercel URL in production
    cb(null, true);
  },
  credentials: true,
}));

// ── Rate limiting ──────────────────────────────────────
app.use('/api/ai/',   rateLimit({ windowMs: 60*1000, max: 60,  message: { error: 'AI rate limit. 1 min baad try karo.' } }));
app.use('/api/auth/', rateLimit({ windowMs: 15*60*1000, max: 20, message: { error: 'Too many attempts.' } }));

// ── JWT helpers ────────────────────────────────────────
const SECRET = process.env.JWT_SECRET;
function signToken(payload){
  const h = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const b = Buffer.from(JSON.stringify({...payload, iat:Date.now(), exp:Date.now()+8*60*60*1000})).toString('base64url');
  const s = crypto.createHmac('sha256',SECRET).update(`${h}.${b}`).digest('base64url');
  return `${h}.${b}.${s}`;
}
function verifyToken(token){
  try{
    const [h,b,s] = token.split('.');
    const exp = crypto.createHmac('sha256',SECRET).update(`${h}.${b}`).digest('base64url');
    if(s!==exp) return null;
    const p = JSON.parse(Buffer.from(b,'base64url').toString());
    return p.exp < Date.now() ? null : p;
  }catch{ return null; }
}
function requireAdmin(req,res,next){
  const token = req.headers.authorization?.replace('Bearer ','');
  if(!token) return res.status(401).json({error:'Token required'});
  const p = verifyToken(token);
  if(!p || p.role !== 'admin') return res.status(403).json({error:'Admin only'});
  req.user = p;
  next();
}

// ── Supabase (service role — never exposed to frontend) ─
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
console.log('✅ Supabase connected');

// ── In-memory key cache (fast access) ──────────────────
let cachedKey = process.env.GEMINI_API_KEY || null;

async function getGeminiKey(){
  // 1. Memory cache
  if(cachedKey) return cachedKey;
  // 2. Supabase settings table
  try{
    const { data } = await sb.from('settings').select('value').eq('key','api_key').limit(1);
    if(data?.[0]?.value){ cachedKey = data[0].value; return cachedKey; }
  }catch(e){ console.warn('Supabase key fetch failed:', e.message); }
  return null;
}

// ── AI ENGINE — 3-model fallback ───────────────────────
const MODELS = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-exp',
  'gemini-2.5-flash-preview-05-20',
];

async function callGemini(model, apiKey, system, messages){
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  if(!contents.length) contents.push({ role:'user', parts:[{text:'Hello'}] });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { maxOutputTokens: 2048, temperature: 0.75 },
    }),
  });
  const d = await res.json();
  if(d.error){
    const code = d.error.code || 0;
    const status = d.error.status || '';
    // Quota/overload → try next model
    if(code===429||code===503||status==='RESOURCE_EXHAUSTED'||status==='UNAVAILABLE'){
      throw new Error('QUOTA:' + d.error.message);
    }
    throw new Error(d.error.message);
  }
  const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
  if(!text) throw new Error('Empty response');
  return { text, model };
}

async function callAI(system, messages){
  const apiKey = await getGeminiKey();
  if(!apiKey) throw new Error('API key set nahi hai — Admin Panel mein key save karo');

  let lastErr;
  for(const model of MODELS){
    try{
      console.log(`[AI] Trying ${model}...`);
      const r = await callGemini(model, apiKey, system, messages);
      console.log(`[AI] ✅ ${model}`);
      return r;
    }catch(e){
      console.warn(`[AI] ❌ ${model}: ${e.message}`);
      lastErr = e;
      // Only continue to next model on quota errors
      if(!e.message.startsWith('QUOTA:')) throw e;
    }
  }
  throw lastErr || new Error('Teeno models fail ho gaye');
}

// ═══════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════

// ── Health check ───────────────────────────────────────
app.get('/api/health', (req,res) => res.json({
  status: 'ok',
  models: MODELS,
  keyLoaded: !!cachedKey,
  time: new Date().toISOString(),
}));

// ── Get key (frontend getKey fallback) ─────────────────
// Returns key only if valid admin token — NOT exposed to students
app.get('/api/key', requireAdmin, async (req,res) => {
  const key = await getGeminiKey();
  if(!key) return res.status(404).json({error:'Key set nahi hai'});
  res.json({ key });
});

// ── Admin: Save new API key ────────────────────────────
app.post('/api/admin/key', requireAdmin, async (req,res) => {
  const { key } = req.body;
  if(!key) return res.status(400).json({error:'Key required'});

  // Update memory cache immediately
  cachedKey = key;

  // Save to Supabase
  try{
    const { data } = await sb.from('settings').select('id').eq('key','api_key').limit(1);
    if(data?.length){
      await sb.from('settings').update({value:key}).eq('key','api_key');
    }else{
      await sb.from('settings').insert({key:'api_key', value:key});
    }
    console.log('[Admin] API key updated ✅');
    res.json({success:true, message:'Key saved aur turant active ho gayi!'});
  }catch(e){
    res.status(500).json({error: e.message});
  }
});

// ── Auth: Admin Login ──────────────────────────────────
app.post('/api/auth/login', async (req,res) => {
  const { email, password } = req.body;
  if(!email||!password) return res.status(400).json({error:'Email aur password chahiye'});

  if(email===process.env.ADMIN_EMAIL && password===process.env.ADMIN_PASS){
    return res.json({
      token: signToken({email, role:'admin', name:'Avi Jaiswal'}),
      user: {name:'Avi Jaiswal', email, role:'admin', avatar:'AJ'},
    });
  }

  // Check Supabase students
  try{
    const { data } = await sb.from('students').select('*').or(`email.eq.${email},phone.eq.${email}`).limit(1);
    const u = data?.[0];
    if(u && u.pass===password){
      return res.json({
        token: signToken({email:u.email||u.phone, role:u.role||'student', name:u.name}),
        user: {name:u.name, email:u.email, phone:u.phone, role:u.role||'student', avatar:(u.name||'S')[0].toUpperCase(), class:u.class, board:u.board},
      });
    }
  }catch(e){ console.error('Login error:', e.message); }

  res.status(401).json({error:'Email/Password galat hai'});
});

// ── AI: Chat ───────────────────────────────────────────
app.post('/api/ai/chat', async (req,res) => {
  // Auth optional — if no token, still works (key fetched server-side)
  const { messages, system } = req.body;
  if(!messages?.length) return res.status(400).json({error:'Messages required'});
  try{
    const r = await callAI(system || 'Tu helpful AI tutor hai.', messages);
    res.json({ reply: r.text, model: r.model });
  }catch(e){
    res.status(503).json({error: e.message});
  }
});

// ── AI: Generate Notes ─────────────────────────────────
app.post('/api/ai/notes', async (req,res) => {
  const { subject, chapter, classNum, board } = req.body;
  if(!subject||!chapter) return res.status(400).json({error:'Subject aur chapter required'});
  const sys = `Tu expert ${subject} teacher hai. Class ${classNum||10} ${board||'CBSE'} ke liye Hinglish mein comprehensive notes banao. Markdown use karo.`;
  const msgs = [{role:'user', content:`"${chapter}" ke detailed notes banao.`}];
  try{
    const r = await callAI(sys, msgs);
    res.json({ content: r.text, model: r.model });
  }catch(e){
    res.status(503).json({error: e.message});
  }
});

// ── AI: Generate Test ──────────────────────────────────
app.post('/api/ai/test', async (req,res) => {
  const { subject, chapter, classNum, board, count=10 } = req.body;
  if(!subject||!chapter) return res.status(400).json({error:'Subject aur chapter required'});
  const sys = `Generate exactly ${count} MCQ questions for Class ${classNum||10} ${board||'CBSE'} ${subject} — "${chapter}". Reply ONLY with valid JSON array: [{"q":"?","options":["A) ","B) ","C) ","D) "],"answer":"A","explanation":"Hinglish mein"}]`;
  const msgs = [{role:'user', content:'Generate questions now.'}];
  try{
    const r = await callAI(sys, msgs);
    const match = r.text.match(/\[[\s\S]*\]/);
    if(!match) throw new Error('Invalid JSON from AI');
    res.json({ questions: JSON.parse(match[0]), model: r.model });
  }catch(e){
    res.status(503).json({error: e.message});
  }
});

// ── 404 ────────────────────────────────────────────────
app.use('/api/*', (req,res) => res.status(404).json({error:'Route not found'}));

// ── Start ───────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   🎓 Aao Samjho AI — Backend            ║
║   Port   : ${PORT}                          ║
║   Models : 2.0-flash → 2.0-exp → 2.5   ║
║   Admin  : ${process.env.ADMIN_EMAIL}  ║
╚══════════════════════════════════════════╝`);
});
