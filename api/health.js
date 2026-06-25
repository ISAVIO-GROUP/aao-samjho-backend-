const { handleCors, getAdmins, MODELS } = require('./_lib/helpers');

module.exports = function handler(req, res) {
  if (handleCors(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  res.json({
    status: 'ok',
    models: MODELS.length,
    admins: getAdmins().length,
    time:   new Date().toISOString(),
  });
};
