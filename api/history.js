const { sb, auth, cors } = require('./_shared');
module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const user = await auth(req);
    const { data, error } = await sb.from('generations').select('id,platform,tone,topic,content,created_at').eq('user_id', user.id).order('created_at', { ascending: false }).limit(10);
    if (error) return res.status(500).json({ error: 'Erreur.' });
    res.json({ history: data || [] });
  } catch(e) { res.status(401).json({ error: e.message }); }
};
