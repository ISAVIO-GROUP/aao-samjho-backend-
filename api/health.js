const { setCors, getAdmins, MODELS } = require('./_lib/utils');

export default function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  res.json({
    status: 'ok',
    models: MODELS.length,
    admins: getAdmins().length,
    time: new Date().toISOString(),
  });
}
