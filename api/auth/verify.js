const { setCors, verifyToken } = require('../_lib/utils');

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ valid: false });

  const p = verifyToken(token);
  if (!p) return res.status(401).json({ valid: false });

  res.json({ valid: true, user: { email: p.email, role: p.role, name: p.name } });
}
