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
app.use(cors({ origin: '*', credentials: true }));

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

// ── Supabase ───────────────────────────────────────────
const { createClient } = require('@supabase/supabase-js');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
console.log('✅ Supabase connected');

// ── 8 Gemini 2.0 Models (rotation ready) ──────────────
const MODELS = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-exp',
  'gemini-2.0-pro',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-1.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
];

// ── Get active keys — Least-used first (round robin) ──
async function getActiveKeys(){
  try{
    const { data } = await sb
      .from('api_keys')
      .select('*')
      .eq('status', 'active')
      .order('usage_count', { ascending: true });
    return data || [];
  }catch(e){
    console.error('Failed to fetch keys:', e.message);
    return [];
  }
}

// ── Call Gemini with fallback ──────────────────────────
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
    // Quota/overload → try next
    if(code===429||code===503||status==='RESOURCE_EXHAUSTED'||status==='UNAVAILABLE'){
      throw new Error('QUOTA:' + d.error.message);
    }
    throw new Error(d.error.message);
  }
  const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
  if(!text) throw new Error('Empty response');
  return { text, model };
}

// ── Smart AI Call with key rotation ────────────────────
async function callAI(system, messages){
  const keys = await getActiveKeys();
  if(!keys.length) throw new Error('Koi bhi API key active nahi hai — Admin Panel mein key add karo');

  let lastErr;

  // Try each key × each model
  for(const key of keys){
    for(const model of MODELS){
      try{
        console.log(`[AI] Trying ${key.id.substring(0,8)}... with ${model}...`);
        const r = await callGemini(model, key.api_key, system, messages);
        
        // Success — increment usage
        await sb.from('api_keys')
          .update({ usage_count: (key.usage_count || 0) + 1 })
          .eq('id', key.id);
        
        console.log(`[AI] ✅ Success with ${model}`);
        return r;
      }catch(e){
        console.warn(`[AI] ❌ ${model}: ${e.message}`);
        lastErr = e;
        // Only continue to next key on quota errors
        if(!e.message.startsWith('QUOTA:')) break;
      }
    }
  }
  throw lastErr || new Error('Sab keys fail ho gaye');
}

// ─────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req,res) => res.json({
  status: 'ok',
  models: MODELS.length,
  time: new Date().toISOString(),
}));

// Get keys (admin only)
app.get('/api/keys', requireAdmin, async (req,res) => {
  const keys = await getActiveKeys();
  const masked = keys.map(k => ({
    ...k,
    api_key: k.api_key.substring(0,6) + '••••••••' + k.api_key.slice(-4)
  }));
  res.json({ keys: masked });
});

// Add key (admin only)
app.post('/api/keys', requireAdmin, async (req,res) => {
  const { model, api_key } = req.body;
  if(!model || !api_key) return res.status(400).json({error:'Model aur key chahiye'});
  if(!MODELS.includes(model)) return res.status(400).json({error:'Invalid model'});

  try{
    const { data, error } = await sb
      .from('api_keys')
      .insert([{ provider:'gemini', model, api_key, status:'active' }])
      .select();
    if(error) throw error;
    res.status(201).json({ success:true, key:data[0] });
  }catch(e){
    res.status(500).json({error: e.message});
  }
});

// Toggle key status (admin only)
app.post('/api/keys/:id/toggle', requireAdmin, async (req,res) => {
  const { id } = req.params;
  const { status } = req.body;
  if(!['active','inactive'].includes(status)) return res.status(400).json({error:'Invalid status'});

  try{
    await sb.from('api_keys').update({ status }).eq('id', id);
    res.json({ success:true });
  }catch(e){
    res.status(500).json({error: e.message});
  }
});

// Reset key usage (admin only)
app.post('/api/keys/:id/reset', requireAdmin, async (req,res) => {
  const { id } = req.params;
  try{
    await sb.from('api_keys').update({ usage_count:0 }).eq('id', id);
    res.json({ success:true });
  }catch(e){
    res.status(500).json({error: e.message});
  }
});

// Delete key (admin only)
app.delete('/api/keys/:id', requireAdmin, async (req,res) => {
  const { id } = req.params;
  try{
    await sb.from('api_keys').delete().eq('id', id);
    res.json({ success:true });
  }catch(e){
    res.status(500).json({error: e.message});
  }
});

// Admin Login
app.post('/api/auth/login', async (req,res) => {
  const { email, password } = req.body;
  if(!email||!password) return res.status(400).json({error:'Email aur password chahiye'});

  if(email===process.env.ADMIN_EMAIL && password===process.env.ADMIN_PASS){
    return res.json({
      token: signToken({email, role:'admin', name:'Admin'}),
      user: {name:'Admin', email, role:'admin'},
    });
  }

  // Check Supabase students
  try{
    const { data } = await sb.from('students').select('*').or(`email.eq.${email},phone.eq.${email}`).limit(1);
    const u = data?.[0];
    if(u && u.pass===password){
      return res.json({
        token: signToken({email:u.email||u.phone, role:u.role||'student', name:u.name}),
        user: {name:u.name, email:u.email, phone:u.phone, role:u.role||'student', class:u.class},
      });
    }
  }catch(e){ console.error('Login error:', e.message); }

  res.status(401).json({error:'Email/Password galat hai'});
});

// Chat
app.post('/api/ai/chat', async (req,res) => {
  const { messages, system } = req.body;
  if(!messages?.length) return res.status(400).json({error:'Messages required'});
  try{
    const r = await callAI(system || 'Tu helpful AI tutor hai.', messages);
    res.json({ reply: r.text, model: r.model });
  }catch(e){
    res.status(503).json({error: e.message});
  }
});

// Generate Notes
app.post('/api/ai/notes', async (req,res) => {
  const { subject, chapter, classNum, board } = req.body;
  if(!subject||!chapter) return res.status(400).json({error:'Subject aur chapter required'});
  const sys = `Tu expert ${subject} teacher hai. Class ${classNum||10} ${board||'CBSE'} ke liye Hinglish mein comprehensive notes banao.`;
  const msgs = [{role:'user', content:`"${chapter}" ke detailed notes banao.`}];
  try{
    const r = await callAI(sys, msgs);
    res.json({ content: r.text, model: r.model });
  }catch(e){
    res.status(503).json({error: e.message});
  }
});

// Generate Test
app.post('/api/ai/test', async (req,res) => {
  const { subject, chapter, classNum, board, count=10 } = req.body;
  if(!subject||!chapter) return res.status(400).json({error:'Subject aur chapter required'});
  const sys = `Generate exactly ${count} MCQ questions for Class ${classNum||10} ${board||'CBSE'} ${subject} — "${chapter}". Reply ONLY with valid JSON: [{"q":"?","options":["A) ","B) ","C) ","D) "],"answer":"A"}]`;
  const msgs = [{role:'user', content:'Generate now.'}];
  try{
    const r = await callAI(sys, msgs);
    const match = r.text.match(/\[[\s\S]*\]/);
    if(!match) throw new Error('Invalid JSON');
    res.json({ questions: JSON.parse(match[0]), model: r.model });
  }catch(e){
    res.status(503).json({error: e.message});
  }
});

// 404
app.use('/api/*', (req,res) => res.status(404).json({error:'Route not found'}));

// Start
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║ 🎓 Aao Samjho AI — Backend v2         ║
║ Port     : ${PORT}                       ║
║ Models   : 8 Gemini versions           ║
║ Rotation : Least-used first            ║
║ Admin    : ${process.env.ADMIN_EMAIL}   ║
╚════════════════════════════════════════╝`);
});
