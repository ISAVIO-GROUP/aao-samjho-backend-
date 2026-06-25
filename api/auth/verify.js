const { handleCors, verifyToken } = require('../_lib/helpers');

module.exports = function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ valid: false });
  const p = verifyToken(token);
  if (!p) return res.status(401).json({ valid: false });
  res.json({ valid: true, user: { email: p.email, role: p.role, name: p.name } });
};
