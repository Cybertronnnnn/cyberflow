const { sb, auth, groq, cors } = require('./_shared');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée.' });

  try {
    const user = await auth(req);
    const { topic, platform, tone } = req.body;

    if (!topic || topic.trim().length < 2) return res.status(400).json({ error: 'Sujet invalide.' });
    if (!['facebook','tiktok','instagram'].includes(platform)) return res.status(400).json({ error: 'Plateforme invalide.' });
    if (!['viral','persuasif','mysterieux','agressif'].includes(tone)) return res.status(400).json({ error: 'Ton invalide.' });

    const { data: p, error: pe } = await sb.from('profiles').select('plan,generations_today,last_generation_date').eq('id', user.id).single();
    if (pe || !p) return res.status(404).json({ error: 'Profil introuvable.' });

    const today = new Date().toISOString().split('T')[0];
    if (p.last_generation_date !== today) {
      await sb.from('profiles').update({ generations_today: 0, last_generation_date: today }).eq('id', user.id);
      p.generations_today = 0;
    }

    const LIMIT = parseInt(process.env.FREE_DAILY_LIMIT) || 3;
    if (p.plan === 'free' && p.generations_today >= LIMIT)
      return res.status(403).json({ error: 'Limite atteinte.', code: 'QUOTA_EXCEEDED' });
    if (platform === 'instagram' && p.plan !== 'pro')
      return res.status(403).json({ error: 'Instagram réservé aux Pro.', code: 'PRO_FEATURE' });
    if (['mysterieux','agressif'].includes(tone) && p.plan !== 'pro')
      return res.status(403).json({ error: 'Ton réservé aux Pro.', code: 'PRO_FEATURE' });

    const tones = { viral:'viral et accrocheur, formules chocs', persuasif:'persuasif, orienté vente', mysterieux:'mystérieux, crée de la curiosité', agressif:'agressif, direct' };
    const plats = {
      facebook: 'un post Facebook viral (accroche, emojis, hashtags, CTA)',
      tiktok: 'un script TikTok:\n[HOOK - 3 secondes]\n[CONTENU - 30-60 secondes]\n[CALL TO ACTION]',
      instagram: 'une caption Instagram (accroche, storytelling, 20 hashtags, CTA)'
    };

    const content = await groq(
      'Tu es un expert en contenu viral Shadow Marketing. Réponds UNIQUEMENT avec le contenu, sans intro.',
      `Génère ${plats[platform]} sur: "${topic.trim()}".\nTon: ${tones[tone]}.\nStyle: Shadow Marketing.\nLangue: Français.\nSans introduction.`
    );
    if (!content) throw new Error('Réponse vide.');

    const newCount = (p.generations_today || 0) + 1;
    await sb.from('profiles').update({ generations_today: newCount, last_generation_date: today }).eq('id', user.id);
    const { data: saved } = await sb.from('generations').insert({ user_id: user.id, platform, tone, topic: topic.trim(), content, created_at: new Date().toISOString() }).select('id').single();

    res.json({ content, generation_id: saved?.id, quota: { used: newCount, limit: p.plan === 'pro' ? null : LIMIT, remaining: p.plan === 'pro' ? null : Math.max(0, LIMIT - newCount) } });
  } catch(e) {
    console.error('Generate error:', e.message);
    res.status(e.message.includes('Token') ? 401 : 500).json({ error: e.message });
  }
};
