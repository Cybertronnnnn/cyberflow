const { cors } = require('./_shared');
module.exports = (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  res.json({ status: 'online', service: 'CyberFlow' });
};
