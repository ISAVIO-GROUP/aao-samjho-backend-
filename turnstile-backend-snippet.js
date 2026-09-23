// ══════════════════════════════════════════════════════════════
// Cloudflare Turnstile — SERVER-SIDE verification
// Add this to your backend (aao-samjho-backend on Vercel).
//
// 1. Set the env var  TURNSTILE_SECRET_KEY  (Cloudflare dashboard →
//    Turnstile → your widget → Secret key). On Vercel: Project → Settings →
//    Environment Variables, then redeploy.
// 2. Call verifyTurnstile() at the TOP of POST /api/auth/login, before you
//    look at the email/password.
//
// Requires Node 18+ (built-in fetch). The frontend sends the token in the
// JSON body as `turnstileToken`.
// ══════════════════════════════════════════════════════════════

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

async function verifyTurnstile(token, remoteIp) {
  // Missing / junk token → reject. (Cloudflare tokens are at most 2048 chars.)
  if (!token || typeof token !== 'string' || token.length > 2048) return false;

  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    console.error('[Turnstile] TURNSTILE_SECRET_KEY is not set — rejecting login');
    return false; // fail CLOSED so a missing env var is noticed immediately
  }

  const form = new URLSearchParams({ secret, response: token });
  if (remoteIp) form.append('remoteip', remoteIp); // optional, improves accuracy

  try {
    const r = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(8000),
    });
    const data = await r.json();
    if (!data.success) console.warn('[Turnstile] rejected:', data['error-codes']);
    return data.success === true;
  } catch (e) {
    console.error('[Turnstile] verify request failed:', e.message);
    return false; // fail closed
  }
}

// ── Example: Express-style route ──────────────────────────────
// app.post('/api/auth/login', async (req, res) => {
//   const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;
//   const human = await verifyTurnstile(req.body.turnstileToken, ip);
//   if (!human) {
//     return res.status(400).json({ error: '🤖 Captcha verify nahi hua — dobara try karo' });
//   }
//
//   // ...your existing email/password check continues here...
// });

// ── Example: Vercel serverless function (api/auth/login.js) ───
// export default async function handler(req, res) {
//   if (req.method !== 'POST') return res.status(405).end();
//   const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
//   if (!(await verifyTurnstile(req.body?.turnstileToken, ip))) {
//     return res.status(400).json({ error: '🤖 Captcha verify nahi hua — dobara try karo' });
//   }
//   // ...existing login logic...
// }

module.exports = { verifyTurnstile };
