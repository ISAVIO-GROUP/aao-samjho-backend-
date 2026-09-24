const { sb, setCors, signToken, getAdmins } = require('../_lib/utils');

// Verifies a Cloudflare Turnstile token server-side. This is the part that
// actually matters — the widget in the browser is just UI; without this
// check, anyone could skip it entirely and POST straight to this endpoint.
async function verifyTurnstile(token, remoteip) {
  if (!process.env.TURNSTILE_SECRET_KEY) {
    // Not configured yet — warn instead of hard-failing every login, so the
    // app doesn't break before you've added the env var. Once
    // TURNSTILE_SECRET_KEY is set in Vercel, this becomes enforced.
    console.warn('[Turnstile] TURNSTILE_SECRET_KEY not set — CAPTCHA check skipped');
    return true;
  }
  if (!token) return false;
  try {
    const params = new URLSearchParams();
    params.append('secret', process.env.TURNSTILE_SECRET_KEY);
    params.append('response', token);
    if (remoteip) params.append('remoteip', remoteip);
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: params });
    const d = await r.json();
    return !!d.success;
  } catch (e) {
    console.error('[Turnstile] verify request failed:', e.message);
    return false;
  }
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, password, turnstileToken, panel, adminCode } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email aur password chahiye' });

  // ── CAPTCHA — applies to every login (student, teacher, admin) ──
  const isHuman = await verifyTurnstile(turnstileToken, req.headers['x-forwarded-for']);
  if (!isHuman) return res.status(403).json({ error: '❌ CAPTCHA verify nahi hua — page reload karke dobara try karo' });

  // ── Admin panel extra gate: a separate shared access code, checked before
  // any credential lookup even happens. Only applies when the login request
  // is flagged panel:'admin' (i.e. came from admin.html, not the student app) ──
  if (panel === 'admin') {
    if (!process.env.ADMIN_ACCESS_CODE) {
      console.warn('[Admin] ADMIN_ACCESS_CODE not set — special code check skipped');
    } else if (adminCode !== process.env.ADMIN_ACCESS_CODE) {
      return res.status(403).json({ error: '❌ Galat access code' });
    }
  }

  // 1. Check admins from env
  const admins = getAdmins();
  const adminMatch = admins.find(a => a.email === email && a.pass === password);
  if (adminMatch) {
    return res.json({
      token: signToken({ email, role: 'admin', name: adminMatch.name }),
      user: { name: adminMatch.name, email, role: 'admin' },
    });
  }

  // 2. Check Supabase students
  try {
    const { data } = await sb
      .from('students')
      .select('*')
      .or(`email.eq.${email},phone.eq.${email}`)
      .limit(1);
    const u = data?.[0];
    if (u && u.pass === password) {
      // Extra server-side guard (in addition to admin.html's own client-side
      // check): a student account should never get a token back from a
      // request explicitly flagged as coming from the admin panel.
      if (panel === 'admin' && u.role !== 'admin' && u.role !== 'teacher') {
        return res.status(403).json({ error: '❌ Sirf admin/teacher accounts is panel ko access kar sakte hain' });
      }
      return res.json({
        token: signToken({ email: u.email || u.phone, role: u.role || 'student', name: u.name }),
        user: { name: u.name, email: u.email, phone: u.phone, role: u.role || 'student', class: u.class, board: u.board },
      });
    }
  } catch (e) {
    console.error('Supabase error:', e.message);
  }

  res.status(401).json({ error: 'Email ya password galat hai' });
}

