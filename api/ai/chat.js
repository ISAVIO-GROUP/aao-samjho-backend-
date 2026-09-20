const { setCors, callAI } = require('../_lib/utils');

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, system } = req.body || {};
  if (!messages?.length) return res.status(400).json({ error: 'Messages required' });

  try {
    const r = await callAI(system || 'Tu helpful AI tutor hai. Hinglish mein samjhao.', messages);
    res.json({ reply: r.text, model: r.model });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
}
