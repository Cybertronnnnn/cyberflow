const { sb, auth, cors } = require('./_shared');
module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const user = await auth(req);
    let { data: p, error } = await sb.from('profiles').select('*').eq('id', user.id).single();
    
    // Créer le profil automatiquement s'il n'existe pas
    if (error || !p) {
      const { data: newP, error: createErr } = await sb.from('profiles').upsert({
        id: user.id,
        username: user.user_metadata?.username || user.email?.split('@')[0] || 'User',
        email: user.email,
        plan: 'free',
        generations_today: 0,
        last_generation_date: new Date().toISOString().split('T')[0],
        created_at: new Date().toISOString()
      }).select('*').single();
      if (createErr || !newP) return res.status(500).json({ error: 'Impossible de créer le profil.' });
      p = newP;
    }
    const today = new Date().toISOString().split('T')[0];
    if (p.last_generation_date !== today) {
      await sb.from('profiles').update({ generations_today: 0, last_generation_date: today }).eq('id', user.id);
      p.generations_today = 0;
    }
    const LIMIT = parseInt(process.env.FREE_DAILY_LIMIT) || 3;
    res.json({
      username: p.username, email: p.email, plan: p.plan,
      quota: { used: p.generations_today, limit: p.plan === 'pro' ? null : LIMIT, remaining: p.plan === 'pro' ? null : Math.max(0, LIMIT - p.generations_today) }
    });
  } catch(e) { res.status(401).json({ error: e.message }); }
};
