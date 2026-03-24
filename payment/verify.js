const { sb, auth, campayToken, cors, parseBody } = require('../_shared');
module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const user = await auth(req);
    const body = await parseBody(req);
    const { reference } = body;
    if (!reference) return res.status(400).json({ error: 'Référence manquante.' });
    const { token, base } = await campayToken();
    const r = await fetch(`${base}/transaction/${reference}/`, { headers:{ 'Authorization':`Token ${token}` } });
    const d = await r.json();
    if (d.status === 'SUCCESSFUL') {
      await sb.from('profiles').update({ plan:'pro' }).eq('id', user.id);
      await sb.from('payments').update({ status:'success' }).eq('reference', reference);
      return res.json({ success:true, status:'SUCCESSFUL', message:'Paiement confirmé ! Vous êtes Pro.' });
    }
    if (d.status === 'FAILED') {
      await sb.from('payments').update({ status:'failed' }).eq('reference', reference);
      return res.json({ success:false, status:'FAILED', message:'Paiement échoué.' });
    }
    res.json({ success:false, status:'PENDING', message:'En attente...' });
  } catch(e) { res.status(401).json({ error: e.message }); }
};
