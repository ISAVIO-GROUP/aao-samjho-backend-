const { handleCors, callAI } = require('../_lib/helpers');

module.exports = async function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, system } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'Messages required' });

  try {
    const r = await callAI(system || 'Tu helpful AI tutor hai. Hinglish mein samjhao.', messages);
    res.json({ reply: r.text, model: r.model });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
};
