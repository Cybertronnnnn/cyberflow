const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function auth(req) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) throw new Error('Token manquant.');
  const { data: { user }, error } = await sb.auth.getUser(h.split(' ')[1]);
  if (error || !user) throw new Error('Token invalide ou expiré.');
  return user;
}

async function groq(system, userMsg) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 1024,
      messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }]
    })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(d));
  return d.choices[0]?.message?.content;
}

async function campayToken() {
  const base = process.env.CAMPAY_ENV === 'live' ? 'https://campay.net/api' : 'https://demo.campay.net/api';
  const r = await fetch(`${base}/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.CAMPAY_USERNAME, password: process.env.CAMPAY_PASSWORD })
  });
  const d = await r.json();
  if (!r.ok) throw new Error('CamPay token error');
  return { token: d.token, base };
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = { sb, auth, groq, campayToken, cors };
