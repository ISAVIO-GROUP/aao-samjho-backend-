const { sb, setCors, getAdminFromToken, MODELS } = require('../../lib/utils');

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // All key routes require admin
  const admin = getAdminFromToken(req);
  if (!admin) return res.status(403).json({ error: 'Admin only' });

  // GET /api/keys — list all keys
  if (req.method === 'GET') {
    try {
      const { data } = await sb
        .from('api_keys')
        .select('*')
        .order('usage_count', { ascending: true });
      const masked = (data || []).map(k => ({
        ...k,
        api_key: k.api_key.substring(0, 6) + '••••••' + k.api_key.slice(-4),
      }));
      return res.json({ keys: masked });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST /api/keys — add new key
  if (req.method === 'POST') {
    const { model, api_key } = req.body || {};
    if (!model || !api_key) return res.status(400).json({ error: 'Model aur key chahiye' });
    if (!MODELS.includes(model)) return res.status(400).json({ error: 'Invalid model: ' + model });
    try {
      const { data, error } = await sb
        .from('api_keys')
        .insert([{ provider: 'gemini', model, api_key, status: 'active', usage_count: 0 }])
        .select();
      if (error) throw error;
      return res.status(201).json({ success: true, key: data[0] });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}

