const { sb, setCors, signToken, getAdmins } = require('../../lib/utils');

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email aur password chahiye' });

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

