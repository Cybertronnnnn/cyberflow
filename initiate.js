const { sb, auth, campayToken, cors } = require('../_shared');
module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const user = await auth(req);
    const { phone, operator } = req.body;
    if (!phone || !operator) return res.status(400).json({ error: 'Numéro et opérateur requis.' });
    if (!['MTN','ORANGE'].includes(operator)) return res.status(400).json({ error: 'Opérateur invalide.' });
    const { token, base } = await campayToken();
    const r = await fetch(`${base}/collect/`, { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Token ${token}`}, body: JSON.stringify({ amount:'500', currency:'XAF', from:phone, description:'CyberFlow Pro', external_reference:user.id }) });
    const d = await r.json();
    if (!r.ok) return res.status(400).json({ error: d.message || 'Erreur paiement.' });
    await sb.from('payments').insert({ user_id:user.id, reference:d.reference, operator, phone, amount:500, status:'pending', created_at:new Date().toISOString() });
    res.json({ success:true, reference:d.reference });
  } catch(e) { res.status(401).json({ error: e.message }); }
};
