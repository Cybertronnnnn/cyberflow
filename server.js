require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// CLIENTS
// ============================================================
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Client Supabase avec la clé SERVICE_ROLE (accès admin complet)
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ============================================================
// MIDDLEWARES
// ============================================================
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Sert le frontend depuis le dossier /public
app.use(express.static(__dirname + '/public'));

app.use(express.json());

// Rate limiting global : 60 requêtes/minute par IP
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Trop de requêtes. Réessayez dans une minute.' }
});

// Rate limiting sur la génération : 10 requêtes/minute par IP
const generateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Trop de générations. Attendez un moment.' }
});

app.use(globalLimiter);

// ============================================================
// MIDDLEWARE AUTH — Vérifie le token Supabase
// ============================================================
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token manquant. Connectez-vous.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    // Vérifie le JWT avec Supabase
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
// MIDDLEWARE QUOTA — Vérifie le plan et les générations
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

    // Reset si nouveau jour
    const today = new Date().toISOString().split('T')[0];
    if (profile.last_generation_date !== today) {
      await sb.from('profiles').update({
        generations_today: 0,
        last_generation_date: today
      }).eq('id', req.user.id);
      profile.generations_today = 0;
    }

    // Vérifie le quota Free
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
    return res.status(500).json({ error: 'Erreur serveur lors de la vérification du quota.' });
  }
}

// ============================================================
// ROUTE : POST /api/profile/create — Créer profil après inscription
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
// ROUTE : GET /api/me — Infos du profil
// ============================================================
app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const { data: profile, error } = await sb
      .from('profiles')
      .select('username, email, plan, generations_today, last_generation_date, created_at')
      .eq('id', req.user.id)
      .single();

    if (error) return res.status(404).json({ error: 'Profil introuvable.' });

    // Reset si nouveau jour
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
// ROUTE : GET /api/history — Historique des générations
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
// ROUTE : POST /api/generate — Génération de contenu IA
// ============================================================
app.post('/api/generate', generateLimiter, requireAuth, checkQuota, async (req, res) => {
  const { topic, platform, tone } = req.body;

  // Validation
  if (!topic || typeof topic !== 'string' || topic.trim().length < 2) {
    return res.status(400).json({ error: 'Sujet invalide ou trop court.' });
  }
  if (!['facebook', 'tiktok', 'instagram'].includes(platform)) {
    return res.status(400).json({ error: 'Plateforme invalide.' });
  }
  if (!['viral', 'persuasif', 'mysterieux', 'agressif'].includes(tone)) {
    return res.status(400).json({ error: 'Ton invalide.' });
  }

  // Bloquer Instagram pour les users Free
  if (platform === 'instagram' && req.profile.plan === 'free') {
    return res.status(403).json({
      error: 'Instagram est réservé aux membres Pro.',
      code: 'PRO_FEATURE'
    });
  }

  // Bloquer certains tons pour les users Free
  if (['mysterieux', 'agressif'].includes(tone) && req.profile.plan === 'free') {
    return res.status(403).json({
      error: 'Ce ton est réservé aux membres Pro.',
      code: 'PRO_FEATURE'
    });
  }

  const prompt = buildPrompt(topic.trim(), platform, tone);

  try {
    // Appel Anthropic — clé sécurisée côté serveur
    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      system: `Tu es un expert en création de contenu viral pour le Shadow Marketing. Tu génères du contenu percutant, authentique et conçu pour maximiser l'engagement sur les réseaux sociaux. Tu réponds UNIQUEMENT avec le contenu demandé, sans introduction ni explication.`,
      messages: [{ role: 'user', content: prompt }]
    });

    const content = message.content[0]?.text;
    if (!content) throw new Error('Réponse vide de l\'IA.');

    // Incrémenter le compteur
    const newCount = (req.profile.generations_today || 0) + 1;
    await sb.from('profiles').update({
      generations_today: newCount,
      last_generation_date: new Date().toISOString().split('T')[0]
    }).eq('id', req.user.id);

    // Sauvegarder dans l'historique
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
    if (err.status === 429) {
      return res.status(429).json({ error: 'Service IA surchargé. Réessayez dans quelques secondes.' });
    }
    res.status(500).json({ error: 'Erreur lors de la génération. Réessayez.' });
  }
});

// ============================================================
// ROUTE : GET /api/health — Santé du serveur
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    service: 'CyberFlow API',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
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

  return `Génère ${platformMap[platform]} sur le sujet : "${topic}".

Ton : ${toneMap[tone]}.
Style : Shadow Marketing — influence, impact, authenticité sombre, psychologie de persuasion.
Langue : Français.

Génère directement le contenu prêt à publier, sans introduction.`;
}

// ============================================================
// CATCH-ALL — Sert index.html pour toutes les routes non-API
// ============================================================
app.get('*', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`\n⚡ CyberFlow — En ligne sur le port ${PORT}`);
  console.log(`🌐 Frontend : http://localhost:${PORT}`);
  console.log(`🔑 Anthropic API : ${process.env.ANTHROPIC_API_KEY ? '✅ Configurée' : '❌ MANQUANTE'}`);
  console.log(`🗄️  Supabase URL : ${process.env.SUPABASE_URL ? '✅ Configurée' : '❌ MANQUANTE'}\n`);
});
