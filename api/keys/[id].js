const { sb, setCors, getAdminFromToken } = require('../_lib/utils');

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const admin = getAdminFromToken(req);
  if (!admin) return res.status(403).json({ error: 'Admin only' });

  // Extract id and action from URL
  // URL pattern: /api/keys/[id] or /api/keys/[id]/toggle or /api/keys/[id]/reset
  const parts = req.url.split('/').filter(Boolean);
  const id = parts[2]; // api/keys/[id]
  const action = parts[3]; // toggle or reset (optional)

  if (!id) return res.status(400).json({ error: 'Key ID required' });

  // DELETE /api/keys/[id]
  if (req.method === 'DELETE' && !action) {
    try {
      await sb.from('api_keys').delete().eq('id', id);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST /api/keys/[id]/toggle
  if (req.method === 'POST' && action === 'toggle') {
    const { status } = req.body || {};
    if (!['active', 'inactive'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    try {
      await sb.from('api_keys').update({ status }).eq('id', id);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST /api/keys/[id]/reset
  if (req.method === 'POST' && action === 'reset') {
    try {
      await sb.from('api_keys').update({ usage_count: 0 }).eq('id', id);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}
