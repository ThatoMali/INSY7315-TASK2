const express = require('express');
const router = express.Router();        // authenticated (mounted behind JWT)
const notifyRouter = express.Router();  // PayFast ITN (public; trusted only after signature + source + amount + server confirmation)
const { getDb } = require('../db');
const { authorize, validate } = require('../middleware');
const { audit } = require('../audit');
const { scopeSql } = require('../scope');
const pf = require('../payfast');

const FINE_SELECT = `
  SELECT f.*, i.reference AS incident_reference, i.reported_by, i.section_id
  FROM fines f JOIN incidents i ON i.id = f.incident_id
`;
const rand = (cents) => (cents / 100).toFixed(2);

// Only non-sensitive fields ever leave the server.
function publicFine(f) {
  return { reference: f.reference, incident_reference: f.incident_reference, amount: rand(f.amount_cents),
           currency: f.currency, status: f.status, paid_at: f.paid_at };
}

function canView(user, f) {
  if (user.role === 'field_ranger')   return f.reported_by === user.sub;
  if (user.role === 'section_ranger') return f.section_id === user.section_id;
  return true; // ecologist / admin
}

// ---------- fines for the current user's scope (used by "Pay Outstanding Fine") ----------
router.get('/mine', (req, res) => {
  const params = [];
  const rows = getDb().prepare(`${FINE_SELECT} WHERE f.status IN ('Unpaid','Pending')` + scopeSql(req.user, params) + ' ORDER BY f.created_at ASC, f.id ASC').all(...params);
  res.json({ fines: rows.map(publicFine), sandbox: pf.cfg().sandbox, configured: pf.isConfigured() });
});

// ---------- fine attached to an incident ----------
router.get('/incident/:id', (req, res) => {
  const f = getDb().prepare(`${FINE_SELECT} WHERE f.incident_id = ? AND f.status != 'Cancelled' ORDER BY f.id DESC LIMIT 1`).get(parseInt(req.params.id, 10) || 0);
  if (!f || !canView(req.user, f)) return res.json({ fine: null });
  res.json({ fine: publicFine(f), can_pay: req.user.role === 'field_ranger' && f.status !== 'Paid', sandbox: pf.cfg().sandbox, configured: pf.isConfigured() });
});

// ---------- issue a fine (amount is set server-side by a manager; never by the paying user) ----------
router.post('/fines',
  authorize('section_ranger', 'admin'),
  validate({ incident_id: { required: true, type: 'number', min: 1 }, amount: { required: true, type: 'number', min: 1, max: 50000 } }),
  (req, res) => {
    const db = getDb();
    const inc = db.prepare('SELECT * FROM incidents WHERE id = ?').get(parseInt(req.body.incident_id, 10));
    if (!inc) return res.status(404).json({ error: 'Incident not found' });
    if (req.user.role === 'section_ranger' && inc.section_id !== req.user.section_id) return res.status(403).json({ error: 'Access denied' });
    if (db.prepare("SELECT 1 FROM fines WHERE incident_id = ? AND status != 'Cancelled'").get(inc.id)) {
      return res.status(409).json({ error: 'A fine already exists for this incident' });
    }
    const cents = Math.round(Number(req.body.amount) * 100);
    const fine = db.transaction(() => {
      const last = db.prepare('SELECT MAX(id) AS n FROM fines').get().n || 0;
      const info = db.prepare('INSERT INTO fines (reference, incident_id, amount_cents, issued_by) VALUES (?, ?, ?, ?)')
        .run('FINE-' + String(last + 1).padStart(4, '0'), inc.id, cents, req.user.sub);
      const row = db.prepare('SELECT * FROM fines WHERE id = ?').get(info.lastInsertRowid);
      audit('fine', row.id, 'issued', req.user.sub, null, row);
      return row;
    })();
    res.status(201).json({ fine: publicFine({ ...fine, incident_reference: inc.reference }) });
  }
);

// ---------- start a payment: returns the PayFast hosted-checkout URL ----------
router.post('/:ref/checkout', authorize('field_ranger'), (req, res) => {
  const db = getDb();
  const f = db.prepare(`${FINE_SELECT} WHERE f.reference = ?`).get(String(req.params.ref));
  if (!f || !canView(req.user, f)) return res.status(404).json({ error: 'Fine not found' });
  if (f.status === 'Paid') return res.status(409).json({ error: 'This fine has already been paid' });
  if (f.status === 'Cancelled') return res.status(409).json({ error: 'This fine has been cancelled' });
  if (!pf.isConfigured()) return res.status(503).json({ error: 'Online payments are not configured on this server' });

  const c = pf.cfg();
  const [first, ...rest] = String(req.user.full_name || 'Ranger').split(' ');
  const url = pf.buildCheckoutUrl({
    merchant_id: c.merchantId, merchant_key: c.merchantKey,
    return_url: `${c.baseUrl}/?payment=return&fine=${f.reference}`,
    cancel_url: `${c.baseUrl}/?payment=cancelled&fine=${f.reference}`,
    notify_url: `${c.baseUrl}/api/payments/notify`,
    name_first: first, name_last: rest.join(' '),
    m_payment_id: f.reference, amount: rand(f.amount_cents),   // amount comes from the database only
    item_name: `Fine ${f.reference}`, item_description: `Incident ${f.incident_reference}`,
  });
  if (f.status === 'Unpaid') {
    db.prepare("UPDATE fines SET status='Pending', provider='payfast', updated_at=datetime('now') WHERE id = ? AND status='Unpaid'").run(f.id);
    audit('fine', f.id, 'checkout_started', req.user.sub, null, null);
  }
  res.json({ url });
});

// ---------- status (the browser return page asks the server; the URL itself is never trusted) ----------
router.get('/:ref/status', (req, res) => {
  const f = getDb().prepare(`${FINE_SELECT} WHERE f.reference = ?`).get(String(req.params.ref));
  if (!f || !canView(req.user, f)) return res.status(404).json({ error: 'Fine not found' });
  res.json({ fine: publicFine(f) });
});

// =====================================================================
// PayFast ITN — the ONLY place a fine can become Paid
// =====================================================================
async function processItn(body, ip) {
  const db = getDb();
  if (!pf.isConfigured()) return { http: 503, msg: 'not configured' };
  const c = pf.cfg();

  if (!pf.signatureValid(body))                    return { http: 400, msg: 'invalid signature' };
  if (!(await pf.sourceValid(ip)))                 return { http: 400, msg: 'invalid source' };

  const f = db.prepare('SELECT * FROM fines WHERE reference = ?').get(String(body.m_payment_id || ''));
  if (!f)                                          return { http: 400, msg: 'unknown payment' };
  if (String(body.merchant_id) !== c.merchantId)   return { http: 400, msg: 'merchant mismatch' };
  const gross = Math.round(parseFloat(body.amount_gross) * 100);
  if (!Number.isFinite(gross) || gross !== f.amount_cents) return { http: 400, msg: 'amount mismatch' };

  let confirmed;
  try { confirmed = await pf.serverConfirms(body); }
  catch { return { http: 500, msg: 'confirmation unavailable' }; }   // non-200 → PayFast retries later
  if (!confirmed)                                  return { http: 400, msg: 'not confirmed by PayFast' };

  const status = String(body.payment_status || '').toUpperCase();
  const pfId = String(body.pf_payment_id || '');
  db.transaction(() => {
    const cur = db.prepare('SELECT * FROM fines WHERE id = ?').get(f.id);
    db.prepare("UPDATE fines SET last_provider_status = ?, updated_at = datetime('now') WHERE id = ?").run(status, cur.id);
    if (cur.status === 'Paid') {                       // duplicate / replayed notification: never changes a paid fine
      if (pfId !== cur.provider_payment_id) audit('fine', cur.id, 'duplicate_payment_notification', null, null, { payment_status: status });
      return;
    }
    if (status === 'COMPLETE') {
      if (!pfId) return;
      try {
        db.prepare("UPDATE fines SET status='Paid', provider='payfast', provider_payment_id=?, paid_at=datetime('now') WHERE id=?").run(pfId, cur.id);
      } catch { return; }                              // pf_payment_id already used on another fine
      audit('fine', cur.id, 'paid', null, cur, db.prepare('SELECT * FROM fines WHERE id = ?').get(cur.id));
    } else if (status === 'PENDING') {
      if (cur.status === 'Unpaid') db.prepare("UPDATE fines SET status='Pending' WHERE id=?").run(cur.id);
    } else if (status === 'FAILED' || status === 'CANCELLED') {
      db.prepare("UPDATE fines SET status='Unpaid' WHERE id=? AND status != 'Paid'").run(cur.id);   // allow a retry
      audit('fine', cur.id, 'payment_' + status.toLowerCase(), null, null, null);
    }
  })();
  return { http: 200, msg: 'OK' };
}

notifyRouter.post('/', express.urlencoded({ extended: false, limit: '20kb' }), async (req, res) => {
  try { const r = await processItn(req.body || {}, req.ip); res.status(r.http).send(r.msg); }
  catch (e) { console.error('[payfast itn]', e.message); res.status(500).send('error'); }
});

module.exports = { router, notifyRouter, processItn };
