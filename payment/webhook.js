const { sb, cors } = require('../_shared');
module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { reference, status, external_reference } = req.body;
  try {
    if (status === 'SUCCESSFUL' && external_reference) {
      await sb.from('profiles').update({ plan:'pro' }).eq('id', external_reference);
      await sb.from('payments').update({ status:'success' }).eq('reference', reference);
    }
    res.json({ received:true });
  } catch(e) { res.status(500).json({ error: 'Webhook error.' }); }
};
