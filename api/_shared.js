const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Auth middleware
async function auth(req) {
  const h = req.headers['authorization'] || req.headers['Authorization'];
  if (!h || !h.startsWith('Bearer ')) throw new Error('Token manquant.');
  const token = h.replace('Bearer ', '').trim();
  if (!token || token === 'null' || token === 'undefined') throw new Error('Token invalide.');
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) throw new Error('Token invalide ou expiré.');
  return user;
}

// Body parser — fonctionne sur Vercel serverless
async function parseBody(req) {
  // Vercel parse automatiquement si Content-Type: application/json
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  // Fallback: lire le stream
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => { data += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
    setTimeout(() => resolve({}), 3000);
  });
}

// Groq AI
async function groq(system, userMsg) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1024,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMsg }
      ]
    })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(d));
  return d.choices[0]?.message?.content;
}

// CamPay token
async function campayToken() {
  const base = process.env.CAMPAY_ENV === 'live'
    ? 'https://campay.net/api'
    : 'https://demo.campay.net/api';
  const r = await fetch(`${base}/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.CAMPAY_USERNAME,
      password: process.env.CAMPAY_PASSWORD
    })
  });
  const d = await r.json();
  if (!r.ok) throw new Error('CamPay token error: ' + JSON.stringify(d));
  return { token: d.token, base };
}

// CORS headers
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = { sb, auth, groq, campayToken, cors, parseBody };
