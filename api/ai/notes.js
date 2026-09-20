const { setCors, callAI } = require('../_lib/utils');

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { subject, chapter, classNum, board } = req.body || {};
  if (!subject || !chapter) return res.status(400).json({ error: 'Subject aur chapter required' });

  const sys = `Tu expert ${subject} teacher hai. Class ${classNum || 10} ${board || 'CBSE'} ke liye Hinglish mein comprehensive notes banao.`;
  const msgs = [{ role: 'user', content: `"${chapter}" ke detailed notes banao. HTML format use karo (<h3>, <p>, <ul><li>).` }];

  try {
    const r = await callAI(sys, msgs);
    res.json({ content: r.text, model: r.model });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
}

