require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// GROQ API (gratuit)
// ============================================================
async function callGroq(systemPrompt, userPrompt) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1024,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data.choices[0]?.message?.content;
}

// ============================================================
// SUPABASE
// ============================================================
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ============================================================
// MIDDLEWARES
// ============================================================
app.set('trust proxy', 1);

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.static(__dirname + '/public'));
app.use(express.json());

// Rate limiting global
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Trop de requêtes. Réessayez dans une minute.' }
});

// Rate limiting génération
const generateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Trop de générations. Attendez un moment.' }
});

app.use(globalLimiter);

// ============================================================
// MIDDLEWARE AUTH
// ============================================================
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token manquant. Connectez-vous.' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const { data: { user }, error } = await sb.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: 'Token invalide ou expiré.' });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Erreur d\'authentification.' });
  }
}

// ============================================================
// MIDDLEWARE QUOTA
// ============================================================
async function checkQuota(req, res, next) {
  try {
    const { data: profile, error } = await sb
      .from('profiles')
      .select('plan, generations_today, last_generation_date')
      .eq('id', req.user.id)
      .single();

    if (error || !profile) {
      return res.status(404).json({ error: 'Profil introuvable.' });
    }

    const today = new Date().toISOString().split('T')[0];
    if (profile.last_generation_date !== today) {
      await sb.from('profiles').update({
        generations_today: 0,
        last_generation_date: today
      }).eq('id', req.user.id);
      profile.generations_today = 0;
    }

    const FREE_LIMIT = parseInt(process.env.FREE_DAILY_LIMIT) || 3;
    if (profile.plan === 'free' && profile.generations_today >= FREE_LIMIT) {
      return res.status(403).json({
        error: 'Limite quotidienne atteinte.',
        code: 'QUOTA_EXCEEDED',
        plan: 'free',
        limit: FREE_LIMIT,
        used: profile.generations_today
      });
    }

    req.profile = profile;
    next();
  } catch (err) {
    return res.status(500).json({ error: 'Erreur serveur.' });
  }
}

// ============================================================
// ROUTE : POST /api/profile/create
// ============================================================
app.post('/api/profile/create', requireAuth, async (req, res) => {
  const { username, email } = req.body;
  if (!username || !email) return res.status(400).json({ error: 'Données manquantes.' });

  const { error } = await sb.from('profiles').upsert({
    id: req.user.id,
    username,
    email,
    plan: 'free',
    generations_today: 0,
    last_generation_date: new Date().toISOString().split('T')[0],
    created_at: new Date().toISOString()
  });

  if (error) return res.status(500).json({ error: 'Erreur création profil.' });
  res.json({ success: true });
});

// ============================================================
// ROUTE : GET /api/me
// ============================================================
app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const { data: profile, error } = await sb
      .from('profiles')
      .select('username, email, plan, generations_today, last_generation_date, created_at')
      .eq('id', req.user.id)
      .single();

    if (error) return res.status(404).json({ error: 'Profil introuvable.' });

    const today = new Date().toISOString().split('T')[0];
    if (profile.last_generation_date !== today) {
      await sb.from('profiles').update({
        generations_today: 0,
        last_generation_date: today
      }).eq('id', req.user.id);
      profile.generations_today = 0;
    }

    const FREE_LIMIT = parseInt(process.env.FREE_DAILY_LIMIT) || 3;

    res.json({
      username: profile.username,
      email: profile.email,
      plan: profile.plan,
      quota: {
        used: profile.generations_today,
        limit: profile.plan === 'pro' ? null : FREE_LIMIT,
        remaining: profile.plan === 'pro' ? null : Math.max(0, FREE_LIMIT - profile.generations_today)
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ============================================================
// ROUTE : GET /api/history
// ============================================================
app.get('/api/history', requireAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const { data, error } = await sb
      .from('generations')
      .select('id, platform, tone, topic, content, created_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) return res.status(500).json({ error: 'Erreur de chargement.' });
    res.json({ history: data || [] });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ============================================================
// ROUTE : POST /api/generate
// ============================================================
app.post('/api/generate', generateLimiter, requireAuth, checkQuota, async (req, res) => {
  const { topic, platform, tone } = req.body;

  if (!topic || typeof topic !== 'string' || topic.trim().length < 2) {
    return res.status(400).json({ error: 'Sujet invalide ou trop court.' });
  }
  if (!['facebook', 'tiktok', 'instagram'].includes(platform)) {
    return res.status(400).json({ error: 'Plateforme invalide.' });
  }
  if (!['viral', 'persuasif', 'mysterieux', 'agressif'].includes(tone)) {
    return res.status(400).json({ error: 'Ton invalide.' });
  }

  if (platform === 'instagram' && req.profile.plan === 'free') {
    return res.status(403).json({ error: 'Instagram est réservé aux membres Pro.', code: 'PRO_FEATURE' });
  }

  if (['mysterieux', 'agressif'].includes(tone) && req.profile.plan === 'free') {
    return res.status(403).json({ error: 'Ce ton est réservé aux membres Pro.', code: 'PRO_FEATURE' });
  }

  const systemPrompt = `Tu es un expert en création de contenu viral pour le Shadow Marketing. Tu génères du contenu percutant, authentique et conçu pour maximiser l'engagement sur les réseaux sociaux. Tu réponds UNIQUEMENT avec le contenu demandé, sans introduction ni explication.`;
  const userPrompt = buildPrompt(topic.trim(), platform, tone);

  try {
    const content = await callGroq(systemPrompt, userPrompt);
    if (!content) throw new Error('Réponse vide.');

    const newCount = (req.profile.generations_today || 0) + 1;
    await sb.from('profiles').update({
      generations_today: newCount,
      last_generation_date: new Date().toISOString().split('T')[0]
    }).eq('id', req.user.id);

    const { data: saved } = await sb.from('generations').insert({
      user_id: req.user.id,
      platform,
      tone,
      topic: topic.trim(),
      content,
      created_at: new Date().toISOString()
    }).select('id, created_at').single();

    const FREE_LIMIT = parseInt(process.env.FREE_DAILY_LIMIT) || 3;

    res.json({
      content,
      generation_id: saved?.id,
      quota: {
        used: newCount,
        limit: req.profile.plan === 'pro' ? null : FREE_LIMIT,
        remaining: req.profile.plan === 'pro' ? null : Math.max(0, FREE_LIMIT - newCount)
      }
    });

  } catch (err) {
    console.error('Erreur génération:', err.message);
    res.status(500).json({ error: 'Erreur lors de la génération. Réessayez.' });
  }
});

// ============================================================
// ROUTE : GET /api/health
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({ status: 'online', service: 'CyberFlow API', version: '1.0.0' });
});

// ============================================================
// CAMPAY — Token + Paiement
// ============================================================
const CAMPAY_BASE_URL = process.env.CAMPAY_ENV === 'live'
  ? 'https://campay.net/api'
  : 'https://demo.campay.net/api';

async function getCampayToken() {
  const res = await fetch(`${CAMPAY_BASE_URL}/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.CAMPAY_USERNAME,
      password: process.env.CAMPAY_PASSWORD
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Erreur token CamPay');
  return data.token;
}

// ROUTE : POST /api/payment/initiate
app.post('/api/payment/initiate', requireAuth, async (req, res) => {
  const { phone, operator } = req.body;
  if (!phone || !operator) return res.status(400).json({ error: 'Numéro et opérateur requis.' });
  if (!['MTN', 'ORANGE'].includes(operator)) return res.status(400).json({ error: 'Opérateur invalide.' });

  try {
    const token = await getCampayToken();
    const payRes = await fetch(`${CAMPAY_BASE_URL}/collect/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Token ${token}` },
      body: JSON.stringify({
        amount: '500',
        currency: 'XAF',
        from: phone,
        description: 'CyberFlow Pro — Abonnement mensuel',
        external_reference: req.user.id
      })
    });
    const payData = await payRes.json();
    if (!payRes.ok) return res.status(400).json({ error: payData.message || 'Erreur paiement.' });

    await sb.from('payments').insert({
      user_id: req.user.id,
      reference: payData.reference,
      operator, phone,
      amount: 500,
      status: 'pending',
      created_at: new Date().toISOString()
    });

    res.json({ success: true, reference: payData.reference, message: 'Confirmez sur votre téléphone.' });
  } catch (err) {
    console.error('CamPay erreur:', err.message);
    res.status(500).json({ error: 'Erreur paiement. Réessayez.' });
  }
});

// ROUTE : POST /api/payment/verify
app.post('/api/payment/verify', requireAuth, async (req, res) => {
  const { reference } = req.body;
  if (!reference) return res.status(400).json({ error: 'Référence manquante.' });

  try {
    const token = await getCampayToken();
    const verRes = await fetch(`${CAMPAY_BASE_URL}/transaction/${reference}/`, {
      headers: { 'Authorization': `Token ${token}` }
    });
    const data = await verRes.json();

    if (data.status === 'SUCCESSFUL') {
      await sb.from('profiles').update({ plan: 'pro' }).eq('id', req.user.id);
      await sb.from('payments').update({ status: 'success' }).eq('reference', reference);
      return res.json({ success: true, status: 'SUCCESSFUL', message: 'Paiement confirmé ! Vous êtes Pro.' });
    }
    if (data.status === 'FAILED') {
      await sb.from('payments').update({ status: 'failed' }).eq('reference', reference);
      return res.json({ success: false, status: 'FAILED', message: 'Paiement échoué. Réessayez.' });
    }
    res.json({ success: false, status: 'PENDING', message: 'En attente de confirmation...' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur vérification.' });
  }
});

// ROUTE : POST /api/payment/webhook
app.post('/api/payment/webhook', async (req, res) => {
  const { reference, status, external_reference } = req.body;
  try {
    if (status === 'SUCCESSFUL' && external_reference) {
      await sb.from('profiles').update({ plan: 'pro' }).eq('id', external_reference);
      await sb.from('payments').update({ status: 'success' }).eq('reference', reference);
    }
    res.json({ received: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur webhook.' });
  }
});

// ============================================================
// CATCH-ALL
// ============================================================
app.get('*', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// ============================================================
// PROMPT BUILDER
// ============================================================
function buildPrompt(topic, platform, tone) {
  const toneMap = {
    viral:      'viral et accrocheur, avec des formules chocs qui stoppent le scroll',
    persuasif:  'persuasif et convaincant, orienté vente et conversion maximale',
    mysterieux: 'mystérieux et intrigant, qui crée de la curiosité et du suspense',
    agressif:   'agressif et direct, sans fioritures, qui secoue violemment le lecteur'
  };
  const platformMap = {
    facebook:  `un post Facebook viral (accroche puissante 1ère ligne, contenu de valeur, emojis stratégiques, hashtags, call-to-action clair)`,
    tiktok:    `un script TikTok complet structuré ainsi:\n[HOOK - 3 secondes]\n[CONTENU - 30 à 60 secondes]\n[CALL TO ACTION final]`,
    instagram: `une caption Instagram virale (accroche forte, storytelling, emojis, 20 hashtags optimisés, CTA engageant)`
  };
  return `Génère ${platformMap[platform]} sur le sujet : "${topic}".\n\nTon : ${toneMap[tone]}.\nStyle : Shadow Marketing — influence, impact, authenticité sombre.\nLangue : Français.\n\nGénère directement le contenu prêt à publier, sans introduction.`;
}

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`\n⚡ CyberFlow — En ligne sur le port ${PORT}`);
  console.log(`🤖 Groq API : ${process.env.GROQ_API_KEY ? '✅ Configurée' : '❌ MANQUANTE'}`);
  console.log(`💳 CamPay : ${process.env.CAMPAY_USERNAME ? '✅ Configuré' : '❌ MANQUANT'}`);
  console.log(`🗄️  Supabase : ${process.env.SUPABASE_URL ? '✅ Configurée' : '❌ MANQUANTE'}\n`);
});
