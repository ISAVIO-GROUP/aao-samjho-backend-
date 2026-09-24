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

// ── 8-slot env-var fallback keys ────────────────────────
// These are NOT a replacement for the Admin Panel's API Keys tab — that
// stays the primary, recommended way to manage keys (dynamic, trackable,
// no redeploy needed to add/remove one). This is a second, fixed-size
// safety net that only gets used if every key from the Admin Panel fails
// or none exist yet — e.g. Supabase is briefly unreachable, or nobody's
// added a key there yet. Same pattern as getAdmins() above: set as many
// or as few of GEMINI_KEY_1 .. GEMINI_KEY_8 as you want in Vercel's env
// vars — unset ones are just skipped.
function getEnvFallbackKeys() {
  const keys = [];
  for (let i = 1; i <= 8; i++) {
    const envVar = i === 1 ? 'GEMINI_KEY_1' : `GEMINI_KEY_${i}`;
    const val = process.env[envVar];
    if (val) keys.push({ id: `env_${i}`, api_key: val, usage_count: 0, source: 'env' });
  }
  return keys;
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
    // Key is rate-limited / out of quota — temporary, likely resets later.
    if (code === 429 || code === 503 || status === 'RESOURCE_EXHAUSTED' || status === 'UNAVAILABLE') {
      throw new Error('QUOTA:' + d.error.message);
    }
    // This specific model name doesn't exist / isn't available — the KEY
    // itself may still be fine, it's just this model. Worth trying other
    // models with the same key before giving up on it.
    if (code === 404 || code === 400 || status === 'NOT_FOUND' || status === 'INVALID_ARGUMENT') {
      throw new Error('MODEL_UNAVAILABLE:' + d.error.message);
    }
    // Anything else (401/403, PERMISSION_DENIED, UNAUTHENTICATED, etc.) —
    // almost always means the key itself is invalid/revoked/blocked, not a
    // per-model problem. No point trying other models with it.
    throw new Error('KEY_BAD:' + d.error.message);
  }
  const text = d.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from Gemini');
  return { text, model };
}

// FIX: previously, on a QUOTA error the loop kept cycling through all 7
// MODELS on the SAME exhausted key before ever moving to the next key —
// wasting calls and time, since a key that's hit its quota will fail on
// every model too. Now: QUOTA or KEY_BAD (auth/revoked) → abandon this key
// immediately and move to the next one. Only MODEL_UNAVAILABLE (a specific
// model name being deprecated/wrong) still tries the other models on the
// same key, since that's a model problem, not a key problem.
async function callAI(system, messages) {
  const dbKeys = await getActiveKeys();
  let lastErr;

  // 1. Primary — Admin Panel's Supabase-managed, usage-tracked keys
  for (const key of dbKeys) {
    for (const model of MODELS) {
      try {
        const r = await callGemini(model, key.api_key, system, messages);
        await sb.from('api_keys').update({ usage_count: (key.usage_count || 0) + 1 }).eq('id', key.id);
        return r;
      } catch (e) {
        lastErr = e;
        if (e.message.startsWith('MODEL_UNAVAILABLE:')) continue; // same key, next model
        if (e.message.startsWith('KEY_BAD:')) {
          // Permanently broken (revoked/invalid) — flip it inactive in the
          // Admin Panel so it's visibly flagged and future requests don't
          // waste a call retrying it. (QUOTA errors are left alone — those
          // are usually temporary and reset on their own.)
          console.warn(`[AI] Key ${key.id} looks invalid/revoked — marking inactive`);
          sb.from('api_keys').update({ status: 'inactive' }).eq('id', key.id).then(() => {}, () => {});
        }
        break; // QUOTA or KEY_BAD — move to next key immediately
      }
    }
  }

  // 2. Fallback — fixed env-var keys, only reached if every DB key above
  // failed (or there weren't any). No usage_count/status tracking since
  // these aren't Supabase rows — check your Vercel logs if one goes bad.
  const envKeys = getEnvFallbackKeys();
  if (envKeys.length) console.warn(`[AI] All ${dbKeys.length} Admin Panel key(s) failed — trying ${envKeys.length} env fallback key(s)`);
  for (const key of envKeys) {
    for (const model of MODELS) {
      try {
        return await callGemini(model, key.api_key, system, messages);
      } catch (e) {
        lastErr = e;
        if (e.message.startsWith('MODEL_UNAVAILABLE:')) continue; // same key, next model
        break; // QUOTA or KEY_BAD — move to next key immediately
      }
    }
  }

  if (!dbKeys.length && !envKeys.length) {
    throw new Error('Koi bhi API key active nahi — Admin Panel mein key add karo ya GEMINI_KEY_1..8 env vars set karo');
  }
  throw lastErr || new Error('Sab keys fail ho gaye');
}

module.exports = { sb, setCors, signToken, verifyToken, getAdminFromToken, getAdmins, callAI, MODELS };
