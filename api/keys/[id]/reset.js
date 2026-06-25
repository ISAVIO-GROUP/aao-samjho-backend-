const { handleCors, getAdminFromToken, getSb } = require('../../_lib/helpers');

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const admin = getAdminFromToken(req);
  if (!admin) return res.status(403).json({ error: 'Admin only' });

  const { id } = req.query;
  try {
    await getSb().from('api_keys').update({ usage_count: 0 }).eq('id', id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
