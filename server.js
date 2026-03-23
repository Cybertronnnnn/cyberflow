require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// GROQ
// ============================================================
async function groq(system, user) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1024,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
    })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(d));
  return d.choices[0]?.message?.content;
}

// ============================================================
// SUPABASE
// ============================================================
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ============================================================
// MIDDLEWARES
// ============================================================
app.set('trust proxy', 1);
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.static(__dirname + '/public'));
app.use(express.json());

const limiter = rateLimit({ windowMs: 60000, max: 60, message: { error: 'Trop de requêtes.' } });
const genLimiter = rateLimit({ windowMs: 60000, max: 15, message: { error: 'Trop de générations.' } });
app.use(limiter);

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
async function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token manquant.' });
  try {
    const { data: { user }, error } = await sb.auth.getUser(h.split(' ')[1]);
    if (error || !user) return res.status(401).json({ error: 'Token invalide ou expiré.' });
    req.user = user;
    next();
  } catch { res.status(401).json({ error: 'Erreur auth.' }); }
}

// ============================================================
// QUOTA MIDDLEWARE
// ============================================================
async function quota(req, res, next) {
  try {
    const { data: p, error } = await sb.from('profiles').select('plan,generations_today,last_generation_date').eq('id', req.user.id).single();
    if (error || !p) return res.status(404).json({ error: 'Profil introuvable.' });
    const today = new Date().toISOString().split('T')[0];
    if (p.last_generation_date !== today) {
      await sb.from('profiles').update({ generations_today: 0, last_generation_date: today }).eq('id', req.user.id);
      p.generations_today = 0;
    }
    const LIMIT = parseInt(process.env.FREE_DAILY_LIMIT) || 3;
    if (p.plan === 'free' && p.generations_today >= LIMIT)
      return res.status(403).json({ error: 'Limite atteinte.', code: 'QUOTA_EXCEEDED', limit: LIMIT, used: p.generations_today });
    req.profile = p;
    next();
  } catch { res.status(500).json({ error: 'Erreur serveur.' }); }
}

// ============================================================
// ROUTES
// ============================================================

// Health
app.get('/api/health', (req, res) => res.json({ status: 'online', service: 'CyberFlow' }));

// Profile
app.get('/api/me', auth, async (req, res) => {
  try {
    const { data: p, error } = await sb.from('profiles').select('*').eq('id', req.user.id).single();
    if (error || !p) return res.status(404).json({ error: 'Profil introuvable.' });
    const today = new Date().toISOString().split('T')[0];
    if (p.last_generation_date !== today) {
      await sb.from('profiles').update({ generations_today: 0, last_generation_date: today }).eq('id', req.user.id);
      p.generations_today = 0;
    }
    const LIMIT = parseInt(process.env.FREE_DAILY_LIMIT) || 3;
    res.json({
      username: p.username, email: p.email, plan: p.plan,
      quota: { used: p.generations_today, limit: p.plan === 'pro' ? null : LIMIT, remaining: p.plan === 'pro' ? null : Math.max(0, LIMIT - p.generations_today) }
    });
  } catch { res.status(500).json({ error: 'Erreur serveur.' }); }
});

// History
app.get('/api/history', auth, async (req, res) => {
  try {
    const { data, error } = await sb.from('generations').select('id,platform,tone,topic,content,created_at').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(10);
    if (error) return res.status(500).json({ error: 'Erreur.' });
    res.json({ history: data || [] });
  } catch { res.status(500).json({ error: 'Erreur serveur.' }); }
});

// Generate
app.post('/api/generate', genLimiter, auth, quota, async (req, res) => {
  const { topic, platform, tone } = req.body;
  if (!topic || topic.trim().length < 2) return res.status(400).json({ error: 'Sujet invalide.' });
  if (!['facebook','tiktok','instagram'].includes(platform)) return res.status(400).json({ error: 'Plateforme invalide.' });
  if (!['viral','persuasif','mysterieux','agressif'].includes(tone)) return res.status(400).json({ error: 'Ton invalide.' });
  if (platform === 'instagram' && req.profile.plan !== 'pro') return res.status(403).json({ error: 'Instagram réservé aux Pro.', code: 'PRO_FEATURE' });
  if (['mysterieux','agressif'].includes(tone) && req.profile.plan !== 'pro') return res.status(403).json({ error: 'Ton réservé aux Pro.', code: 'PRO_FEATURE' });

  try {
    const tones = { viral:'viral et accrocheur, formules chocs', persuasif:'persuasif, orienté vente', mysterieux:'mystérieux, crée de la curiosité', agressif:'agressif, direct, secoue le lecteur' };
    const plats = {
      facebook: 'un post Facebook viral (accroche puissante, emojis, hashtags, CTA)',
      tiktok: 'un script TikTok:\n[HOOK - 3 secondes]\n[CONTENU - 30-60 secondes]\n[CALL TO ACTION]',
      instagram: 'une caption Instagram (accroche, storytelling, 20 hashtags, CTA)'
    };
    const prompt = `Génère ${plats[platform]} sur: "${topic.trim()}".\nTon: ${tones[tone]}.\nStyle: Shadow Marketing.\nLangue: Français.\nSans introduction.`;
    const content = await groq('Tu es un expert en contenu viral Shadow Marketing. Réponds UNIQUEMENT avec le contenu, sans intro.', prompt);
    if (!content) throw new Error('Vide');

    const newCount = (req.profile.generations_today || 0) + 1;
    await sb.from('profiles').update({ generations_today: newCount, last_generation_date: new Date().toISOString().split('T')[0] }).eq('id', req.user.id);
    const { data: saved } = await sb.from('generations').insert({ user_id: req.user.id, platform, tone, topic: topic.trim(), content, created_at: new Date().toISOString() }).select('id').single();

    const LIMIT = parseInt(process.env.FREE_DAILY_LIMIT) || 3;
    res.json({ content, generation_id: saved?.id, quota: { used: newCount, limit: req.profile.plan === 'pro' ? null : LIMIT, remaining: req.profile.plan === 'pro' ? null : Math.max(0, LIMIT - newCount) } });
  } catch(e) {
    console.error('Generate error:', e.message);
    res.status(500).json({ error: 'Erreur génération.' });
  }
});

// ============================================================
// CAMPAY
// ============================================================
const CAMPAY_URL = process.env.CAMPAY_ENV === 'live' ? 'https://campay.net/api' : 'https://demo.campay.net/api';

async function campayToken() {
  const r = await fetch(`${CAMPAY_URL}/token/`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username: process.env.CAMPAY_USERNAME, password: process.env.CAMPAY_PASSWORD }) });
  const d = await r.json();
  if (!r.ok) throw new Error('CamPay token error');
  return d.token;
}

app.post('/api/payment/initiate', auth, async (req, res) => {
  const { phone, operator } = req.body;
  if (!phone || !operator) return res.status(400).json({ error: 'Numéro et opérateur requis.' });
  if (!['MTN','ORANGE'].includes(operator)) return res.status(400).json({ error: 'Opérateur invalide.' });
  try {
    const token = await campayToken();
    const r = await fetch(`${CAMPAY_URL}/collect/`, { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Token ${token}`}, body: JSON.stringify({ amount:'500', currency:'XAF', from:phone, description:'CyberFlow Pro', external_reference:req.user.id }) });
    const d = await r.json();
    if (!r.ok) return res.status(400).json({ error: d.message || 'Erreur paiement.' });
    await sb.from('payments').insert({ user_id:req.user.id, reference:d.reference, operator, phone, amount:500, status:'pending', created_at:new Date().toISOString() });
    res.json({ success:true, reference:d.reference });
  } catch(e) { console.error('CamPay:', e.message); res.status(500).json({ error: 'Erreur paiement.' }); }
});

app.post('/api/payment/verify', auth, async (req, res) => {
  const { reference } = req.body;
  if (!reference) return res.status(400).json({ error: 'Référence manquante.' });
  try {
    const token = await campayToken();
    const r = await fetch(`${CAMPAY_URL}/transaction/${reference}/`, { headers:{'Authorization':`Token ${token}`} });
    const d = await r.json();
    if (d.status === 'SUCCESSFUL') {
      await sb.from('profiles').update({ plan:'pro' }).eq('id', req.user.id);
      await sb.from('payments').update({ status:'success' }).eq('reference', reference);
      return res.json({ success:true, status:'SUCCESSFUL', message:'Paiement confirmé ! Vous êtes Pro.' });
    }
    if (d.status === 'FAILED') {
      await sb.from('payments').update({ status:'failed' }).eq('reference', reference);
      return res.json({ success:false, status:'FAILED', message:'Paiement échoué.' });
    }
    res.json({ success:false, status:'PENDING', message:'En attente...' });
  } catch(e) { res.status(500).json({ error: 'Erreur vérification.' }); }
});

app.post('/api/payment/webhook', async (req, res) => {
  const { reference, status, external_reference } = req.body;
  try {
    if (status === 'SUCCESSFUL' && external_reference) {
      await sb.from('profiles').update({ plan:'pro' }).eq('id', external_reference);
      await sb.from('payments').update({ status:'success' }).eq('reference', reference);
    }
    res.json({ received:true });
  } catch { res.status(500).json({ error: 'Webhook error.' }); }
});

// ============================================================
// CATCH-ALL
// ============================================================
app.get('*', (req, res) => res.sendFile(__dirname + '/public/index.html'));

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`\n⚡ CyberFlow — Port ${PORT}`);
  console.log(`🤖 Groq: ${process.env.GROQ_API_KEY ? '✅' : '❌ MANQUANTE'}`);
  console.log(`💳 CamPay: ${process.env.CAMPAY_USERNAME ? '✅' : '❌ MANQUANT'}`);
  console.log(`🗄️  Supabase: ${process.env.SUPABASE_URL ? '✅' : '❌ MANQUANTE'}\n`);
});
