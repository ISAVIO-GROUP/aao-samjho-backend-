const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// ── Supabase ───────────────────────────────────────────
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── CORS helper ────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://aao-samjho-app.vercel.app',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

function setCors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

// ── JWT helpers ────────────────────────────────────────
const SECRET = process.env.JWT_SECRET;

function signToken(payload) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify({
    ...payload,
    iat: Date.now(),
    exp: Date.now() + 8 * 60 * 60 * 1000, // 8 hours
  })).toString('base64url');
  const s = crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url');
  return `${h}.${b}.${s}`;
}

function verifyToken(token) {
  try {
    const [h, b, s] = token.split('.');
    const expected = crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url');
    if (s !== expected) return null;
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    return p.exp < Date.now() ? null : p;
  } catch { return null; }
}

function getAdminFromToken(req) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return null;
  const p = verifyToken(token);
  if (!p || p.role !== 'admin') return null;
  return p;
}

// ── Admin list from env ────────────────────────────────
function getAdmins() {
  const admins = [];
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASS) {
    admins.push({ email: process.env.ADMIN_EMAIL, pass: process.env.ADMIN_PASS, name: process.env.ADMIN_NAME || 'Admin', role: 'admin' });
  }
  if (process.env.ADMIN2_EMAIL && process.env.ADMIN2_PASS) {
    admins.push({ email: process.env.ADMIN2_EMAIL, pass: process.env.ADMIN2_PASS, name: process.env.ADMIN2_NAME || 'Admin 2', role: 'admin' });
  }
  if (process.env.ADMIN3_EMAIL && process.env.ADMIN3_PASS) {
    admins.push({ email: process.env.ADMIN3_EMAIL, pass: process.env.ADMIN3_PASS, name: process.env.ADMIN3_NAME || 'Admin 3', role: 'admin' });
  }
  return admins;
}

// ── Gemini Models ──────────────────────────────────────
const MODELS = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-exp',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-1.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
];

async function getActiveKeys() {
  try {
    const { data } = await sb
      .from('api_keys')
      .select('*')
      .eq('status', 'active')
      .order('usage_count', { ascending: true });
    return data || [];
  } catch (e) {
    console.error('Failed to fetch keys:', e.message);
    return [];
  }
}

async function callGemini(model, apiKey, system, messages) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: 'Hello' }] });

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
  if (d.error) {
    const code = d.error.code || 0;
    const status = d.error.status || '';
    if (code === 429 || code === 503 || status === 'RESOURCE_EXHAUSTED' || status === 'UNAVAILABLE') {
      throw new Error('QUOTA:' + d.error.message);
    }
    throw new Error(d.error.message);
  }
  const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from Gemini');
  return { text, model };
}

async function callAI(system, messages) {
  const keys = await getActiveKeys();
  if (!keys.length) throw new Error('Koi bhi API key active nahi — Admin Panel mein key add karo');
  let lastErr;
  for (const key of keys) {
    for (const model of MODELS) {
      try {
        const r = await callGemini(model, key.api_key, system, messages);
        await sb.from('api_keys').update({ usage_count: (key.usage_count || 0) + 1 }).eq('id', key.id);
        return r;
      } catch (e) {
        lastErr = e;
        if (!e.message.startsWith('QUOTA:')) break;
      }
    }
  }
  throw lastErr || new Error('Sab keys fail ho gaye');
}

module.exports = { sb, setCors, signToken, verifyToken, getAdminFromToken, getAdmins, callAI, MODELS };
