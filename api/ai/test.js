const { setCors, callAI } = require('../../lib/utils');

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { subject, chapter, classNum, board, count = 10 } = req.body || {};
  if (!subject || !chapter) return res.status(400).json({ error: 'Subject aur chapter required' });

  const sys = `Generate exactly ${count} MCQ questions for Class ${classNum || 10} ${board || 'CBSE'} ${subject} — "${chapter}". Reply ONLY with a valid JSON array, no markdown:
[{"q":"?","options":["A) ","B) ","C) ","D) "],"answer":"A","explanation":"brief Hinglish"}]`;
  const msgs = [{ role: 'user', content: 'Generate the questions now.' }];

  try {
    const r = await callAI(sys, msgs);
    const match = r.text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('AI ne valid JSON nahi diya — dobara try karo');
    res.json({ questions: JSON.parse(match[0]), model: r.model });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
}
