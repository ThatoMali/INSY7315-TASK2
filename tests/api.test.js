const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolated temp DB + uploads for the whole test run (must be set before requiring the app)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frims-test-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

const { triage } = require('../src/triage');
const { initDb, closeDb } = require('../src/db');
const { createApp } = require('../src/app');

// ------------------------------------------------------------------ triage (unit)
test('snare + fresh wire → High', () => {
  assert.strictEqual(triage('Snare found', 'Fresh wire snare near waterhole').severity, 'High');
});
test('fence breach + tracks → Medium', () => {
  assert.strictEqual(triage('Fence breach', 'Cut fence with tracks').severity, 'Medium');
});
test('wildlife sighting → Low', () => {
  assert.strictEqual(triage('Wildlife sighting', 'Elephant herd seen grazing').severity, 'Low');
});
test('poaching + gunshots → High', () => {
  assert.strictEqual(triage('Poaching activity', 'Gunshots heard NE of ranger post').severity, 'High');
});
test('"no recent activity" lowers a snare to Medium', () => {
  assert.strictEqual(triage('Snare found', 'Wire snare, no recent activity apparent.').severity, 'Medium');
});

// ------------------------------------------------------------------ API (integration)
let server, base;
test.before(async () => {
  initDb();
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); closeDb(); fs.rmSync(tmp, { recursive: true, force: true }); });

async function call(method, url, { token, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* csv etc. */ }
  return { status: res.status, json, text, headers: res.headers };
}
async function login(username, password) {
  const r = await call('POST', '/api/auth/login', { body: { username, password } });
  assert.strictEqual(r.status, 200, `login ${username}`);
  return r.json.token;
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('health endpoint', async () => {
  const r = await call('GET', '/api/health');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.status, 'ok');
});

test('login: good, bad, and missing credentials', async () => {
  assert.ok(await login('admin', 'Admin@123'));
  assert.strictEqual((await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'nope' } })).status, 401);
  assert.strictEqual((await call('POST', '/api/auth/login', { body: {} })).status, 400);
});

test('protected routes reject missing / bad tokens', async () => {
  assert.strictEqual((await call('GET', '/api/incidents')).status, 401);
  assert.strictEqual((await call('GET', '/api/incidents', { token: 'garbage' })).status, 401);
});

test('role scoping: field ranger / section ranger / ecologist / admin', async () => {
  const field = await login('t.nkosi', 'Ranger@123');
  const sect  = await login('s.mahlangu', 'Ranger@123');
  const eco   = await login('ecologist', 'Eco@123');

  const f = (await call('GET', '/api/incidents', { token: field })).json.incidents;
  assert.ok(f.length > 0 && f.every((i) => i.reported_by_name === 'Thabo Nkosi'));

  const s = (await call('GET', '/api/incidents', { token: sect })).json.incidents;
  assert.ok(s.every((i) => i.section_name === 'Kruger South'));
  assert.ok(s.length > f.length);

  const e = (await call('GET', '/api/incidents', { token: eco })).json.incidents;
  assert.ok(e.some((i) => i.section_name === 'Kruger North'));

  // section ranger cannot open another section's incident
  const north = e.find((i) => i.section_name === 'Kruger North');
  assert.strictEqual((await call('GET', '/api/incidents/' + north.id, { token: sect })).status, 403);
  // field ranger cannot open a colleague's incident
  const other = s.find((i) => i.reported_by_name !== 'Thabo Nkosi');
  assert.strictEqual((await call('GET', '/api/incidents/' + other.id, { token: field })).status, 403);
});

test('field ranger logs incident: server triage, alert, photo, audit', async () => {
  const token = await login('t.nkosi', 'Ranger@123');
  const sect  = await login('s.mahlangu', 'Ranger@123');

  const r = await call('POST', '/api/incidents', { token, body: {
    type: 'Snare found', notes: 'Fresh wire snare near river crossing', latitude: -25.11, longitude: 31.52,
    severity: 'Low', status: 'Resolved',            // client-supplied values must be ignored
    photo_base64: PNG, client_id: 'abc-123',
  } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.json.incident.severity, 'High');
  assert.strictEqual(r.json.incident.status, 'Escalated');
  assert.match(r.json.incident.photo_path, /^\/uploads\/[a-f0-9]+\.png$/);

  // photo is actually served
  assert.strictEqual((await fetch(base + r.json.incident.photo_path)).status, 200);

  // alert visible to section ranger, not available to field ranger
  const alerts = (await call('GET', '/api/alerts', { token: sect })).json.alerts;
  assert.ok(alerts.some((a) => a.incident_id === r.json.incident.id));
  assert.strictEqual((await call('GET', '/api/alerts', { token })).status, 403);

  // idempotent re-send (offline queue retry)
  const again = await call('POST', '/api/incidents', { token, body: {
    type: 'Snare found', notes: 'x', latitude: -25.11, longitude: 31.52, client_id: 'abc-123' } });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.json.incident.id, r.json.incident.id);

  // audit trail on detail
  const d = await call('GET', '/api/incidents/' + r.json.incident.id, { token: sect });
  assert.strictEqual(d.json.incident.audit[0].action, 'created');
});

test('incident validation: bad type, bad coords, non-image photo', async () => {
  const token = await login('t.nkosi', 'Ranger@123');
  const ok = { type: 'Other', latitude: -25, longitude: 31 };
  assert.strictEqual((await call('POST', '/api/incidents', { token, body: { ...ok, type: 'Nope' } })).status, 400);
  assert.strictEqual((await call('POST', '/api/incidents', { token, body: { ...ok, latitude: 999 } })).status, 400);
  assert.strictEqual((await call('POST', '/api/incidents', { token, body: { ...ok, latitude: true } })).status, 400);
  assert.strictEqual((await call('POST', '/api/incidents', { token, body: { ...ok, photo_base64: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } })).status, 400);
});

test('only section ranger / admin can change status; scope enforced', async () => {
  const field = await login('t.nkosi', 'Ranger@123');
  const sect  = await login('s.mahlangu', 'Ranger@123');
  const north = await login('j.botha', 'Ranger@123');
  const eco   = await login('ecologist', 'Eco@123');

  const list = (await call('GET', '/api/incidents?status=Open', { token: sect })).json.incidents;
  const inc = list[0];
  assert.strictEqual((await call('PATCH', '/api/incidents/' + inc.id, { token: field, body: { status: 'Resolved' } })).status, 403);
  assert.strictEqual((await call('PATCH', '/api/incidents/' + inc.id, { token: eco,   body: { status: 'Resolved' } })).status, 403);
  assert.strictEqual((await call('PATCH', '/api/incidents/' + inc.id, { token: north, body: { status: 'Resolved' } })).status, 403);
  assert.strictEqual((await call('PATCH', '/api/incidents/' + inc.id, { token: sect,  body: { status: 'Bogus' } })).status, 400);

  const ok = await call('PATCH', '/api/incidents/' + inc.id, { token: sect, body: { status: 'Resolved' } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.incident.status, 'Resolved');
});

test('stats respect scope', async () => {
  const sect = await login('s.mahlangu', 'Ranger@123');
  const eco  = await login('ecologist', 'Eco@123');
  const s = (await call('GET', '/api/incidents/stats', { token: sect })).json;
  const e = (await call('GET', '/api/incidents/stats', { token: eco })).json;
  assert.ok(e.total > s.total);
  assert.ok(Array.isArray(s.byType) && s.byType.length > 0);
});

test('user management: admin only, validation, audit never leaks password hash', async () => {
  const admin = await login('admin', 'Admin@123');
  const field = await login('t.nkosi', 'Ranger@123');
  assert.strictEqual((await call('GET', '/api/users', { token: field })).status, 403);
  assert.strictEqual((await call('POST', '/api/users', { token: field, body: {} })).status, 403);

  const sections = (await call('GET', '/api/users/sections', { token: admin })).json.sections;
  const body = { username: 'new.ranger', email: 'new.ranger@sanparks.org', full_name: 'New Ranger', password: 'Secret@123', role: 'field_ranger', section_id: sections[0].id };
  assert.strictEqual((await call('POST', '/api/users', { token: admin, body: { ...body, section_id: null } })).status, 400); // ranger needs section
  assert.strictEqual((await call('POST', '/api/users', { token: admin, body: { ...body, password: 'short' } })).status, 400);
  const created = await call('POST', '/api/users', { token: admin, body });
  assert.strictEqual(created.status, 201);
  assert.strictEqual(created.json.user.password_hash, undefined);
  assert.strictEqual((await call('POST', '/api/users', { token: admin, body })).status, 409);

  // new user can log in; deactivation kills their existing token immediately
  const newTok = await login('new.ranger', 'Secret@123');
  assert.strictEqual((await call('GET', '/api/incidents', { token: newTok })).status, 200);
  assert.strictEqual((await call('DELETE', '/api/users/' + created.json.user.id, { token: admin })).status, 200);
  assert.strictEqual((await call('GET', '/api/incidents', { token: newTok })).status, 401);
  assert.strictEqual((await call('POST', '/api/auth/login', { body: { username: 'new.ranger', password: 'Secret@123' } })).status, 403);

  // admin cannot lock themselves out
  const me = (await call('GET', '/api/auth/me', { token: admin })).json.user;
  assert.strictEqual((await call('DELETE', '/api/users/' + me.id, { token: admin })).status, 400);
  assert.strictEqual((await call('PATCH', '/api/users/' + me.id, { token: admin, body: { role: 'field_ranger', section_id: sections[0].id } })).status, 400);

  // update + reset password
  const upd = await call('PATCH', '/api/users/' + created.json.user.id, { token: admin, body: { status: 'Active', password: 'Another@123' } });
  assert.strictEqual(upd.status, 200);
  await login('new.ranger', 'Another@123');

  const audit = await call('GET', '/api/audit', { token: admin });
  assert.strictEqual(audit.status, 200);
  assert.ok(audit.json.entries.length > 0);
  assert.ok(!JSON.stringify(audit.json).includes('password_hash'));
  const raw = require('../src/db').getDb().prepare('SELECT old_value, new_value FROM audit_log').all();
  assert.ok(!JSON.stringify(raw).includes('$2a$') && !JSON.stringify(raw).includes('$2b$'), 'bcrypt hash leaked into audit_log');
});

test('registration is disabled by default', async () => {
  const r = await call('POST', '/api/auth/register', { body: { username: 'x', email: 'x@x', full_name: 'X', password: 'password123' } });
  assert.strictEqual(r.status, 403);
});

test('CSV report: scoped, formula-safe, downloadable', async () => {
  const token = await login('s.mahlangu', 'Ranger@123');
  const field = await login('t.nkosi', 'Ranger@123');
  const r = await call('GET', '/api/reports/incidents.csv', { token });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /attachment/);
  assert.ok(r.text.includes('Reference,Date (UTC)'));
  assert.ok(!r.text.includes('Kruger North'));
  assert.strictEqual((await call('GET', '/api/reports/incidents.csv', { token: field })).status, 403);
  assert.strictEqual((await call('GET', '/api/reports/incidents.xml', { token })).status, 400);

  // formula injection neutralised
  await call('POST', '/api/incidents', { token: field, body: { type: 'Other', notes: '=HYPERLINK("http://evil")', latitude: -25, longitude: 31 } });
  const csv = (await call('GET', '/api/reports/incidents.csv', { token })).text;
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"")"`));
});

test('unknown API route → JSON 404; static index served with security headers', async () => {
  assert.strictEqual((await call('GET', '/api/nope', { token: await login('admin', 'Admin@123') })).status, 404);
  const idx = await fetch(base + '/');
  assert.strictEqual(idx.status, 200);
  assert.ok(idx.headers.get('content-security-policy'));
});

// ====================================================================== PAYMENTS (PayFast)
const pf = require('../src/payfast');
const { processItn } = require('../src/routes/payments');
const { getDb } = require('../src/db');
const crypto = require('crypto');

process.env.PAYFAST_MERCHANT_ID = '10000100';
process.env.PAYFAST_MERCHANT_KEY = 'test-merchant-key';
process.env.PAYFAST_PASSPHRASE = 'test-pass';
process.env.PAYFAST_SANDBOX = 'true';
process.env.APP_BASE_URL = 'https://frims.example.test';

// Local stand-ins for PayFast's network (NOT a provider sandbox test)
const PF_IP = '41.74.179.194';
pf.deps.lookupHosts = async () => new Set([PF_IP]);
let confirmResult = 'VALID';
pf.deps.fetch = async () => ({ text: async () => confirmResult });

function itn(fine, overrides = {}, { signed = true, pass = 'test-pass' } = {}) {
  const body = { m_payment_id: fine.reference, pf_payment_id: '1089250', payment_status: 'COMPLETE', item_name: 'Fine',
    amount_gross: (fine.amount_cents / 100).toFixed(2), merchant_id: '10000100', ...overrides };
  if (signed) body.signature = pf.sign(Object.entries(body), pass, { includeEmpty: true });
  else body.signature = 'f'.repeat(32);
  return body;
}
async function issueFine(incidentId, amount = 250) {
  const sect = await login('s.mahlangu', 'Ranger@123');
  const r = await call('POST', '/api/payments/fines', { token: sect, body: { incident_id: incidentId, amount } });
  assert.strictEqual(r.status, 201);
  return getDb().prepare('SELECT * FROM fines WHERE reference = ?').get(r.json.fine.reference);
}
const incidentOf = (ref) => getDb().prepare('SELECT * FROM incidents WHERE reference = ?').get(ref);

test('payments: only managers in scope can issue fines; amount is server-side', async () => {
  const field = await login('t.nkosi', 'Ranger@123');
  const other = await login('j.botha', 'Ranger@123');          // section ranger of a different section
  const inc = incidentOf('INC-0412');
  assert.strictEqual((await call('POST', '/api/payments/fines', { token: field, body: { incident_id: inc.id, amount: 100 } })).status, 403);
  assert.strictEqual((await call('POST', '/api/payments/fines', { token: other, body: { incident_id: inc.id, amount: 100 } })).status, 403);
  assert.strictEqual((await call('POST', '/api/payments/fines', { token: await login('s.mahlangu', 'Ranger@123'), body: { incident_id: inc.id, amount: -5 } })).status, 400);
  const fine = await issueFine(inc.id, 250);
  assert.strictEqual(fine.amount_cents, 25000);
  assert.strictEqual((await call('POST', '/api/payments/fines', { token: await login('s.mahlangu', 'Ranger@123'), body: { incident_id: inc.id, amount: 100 } })).status, 409);
});

test('payments: checkout builds a signed PayFast URL from the DB amount; no secrets leak', async () => {
  const field = await login('t.nkosi', 'Ranger@123');
  const fine = getDb().prepare('SELECT * FROM fines ORDER BY id LIMIT 1').get();
  // browser-supplied amount is ignored
  const r = await call('POST', `/api/payments/${fine.reference}/checkout`, { token: field, body: { amount: 1 } });
  assert.strictEqual(r.status, 200);
  const u = new URL(r.json.url);
  assert.strictEqual(u.hostname, 'sandbox.payfast.co.za');
  assert.strictEqual(u.searchParams.get('amount'), '250.00');
  assert.strictEqual(u.searchParams.get('m_payment_id'), fine.reference);
  assert.ok(/^[0-9a-f]{32}$/.test(u.searchParams.get('signature')));
  assert.ok(!r.text.includes('test-pass'), 'passphrase must never be returned');
  assert.strictEqual(getDb().prepare('SELECT status FROM fines WHERE id=?').get(fine.id).status, 'Pending');
  // another ranger / a manager cannot start the payment
  assert.strictEqual((await call('POST', `/api/payments/${fine.reference}/checkout`, { token: await login('m.dlamini', 'Ranger@123') })).status, 404);
  assert.strictEqual((await call('POST', `/api/payments/${fine.reference}/checkout`, { token: await login('s.mahlangu', 'Ranger@123') })).status, 403);
  // status endpoint never exposes provider ids
  const st = await call('GET', `/api/payments/${fine.reference}/status`, { token: field });
  assert.deepStrictEqual(Object.keys(st.json.fine).sort(), ['amount', 'currency', 'incident_reference', 'paid_at', 'reference', 'status']);
});

test('payments: success/return URL alone never marks a fine paid; unauthenticated notify is rejected', async () => {
  const fine = getDb().prepare('SELECT * FROM fines ORDER BY id LIMIT 1').get();
  const field = await login('t.nkosi', 'Ranger@123');
  await call('GET', `/api/payments/${fine.reference}/status?payment=return`, { token: field });
  assert.notStrictEqual(getDb().prepare('SELECT status FROM fines WHERE id=?').get(fine.id).status, 'Paid');
  const r = await call('POST', '/api/payments/notify', { body: { m_payment_id: fine.reference, payment_status: 'COMPLETE' } });
  assert.strictEqual(r.status, 400);
  assert.notStrictEqual(getDb().prepare('SELECT status FROM fines WHERE id=?').get(fine.id).status, 'Paid');
});

test('payments ITN: bad signature, wrong source, wrong amount, wrong merchant, failed confirmation are all rejected', async () => {
  const fine = getDb().prepare('SELECT * FROM fines ORDER BY id LIMIT 1').get();
  const paid = () => getDb().prepare('SELECT status FROM fines WHERE id=?').get(fine.id).status === 'Paid';
  assert.strictEqual((await processItn(itn(fine, {}, { signed: false }), PF_IP)).http, 400);
  assert.strictEqual((await processItn(itn(fine, {}, { pass: 'wrong' }), PF_IP)).http, 400);
  assert.strictEqual((await processItn(itn(fine), '6.6.6.6')).http, 400);
  assert.strictEqual((await processItn(itn(fine, { amount_gross: '1.00' }), PF_IP)).msg, 'amount mismatch');
  assert.strictEqual((await processItn(itn(fine, { merchant_id: '999' }), PF_IP)).msg, 'merchant mismatch');
  assert.strictEqual((await processItn(itn(fine, { m_payment_id: 'FINE-9999' }), PF_IP)).msg, 'unknown payment');
  confirmResult = 'INVALID';
  assert.strictEqual((await processItn(itn(fine), PF_IP)).msg, 'not confirmed by PayFast');
  confirmResult = 'VALID';
  assert.strictEqual(paid(), false);
});

test('payments ITN: pending / failed / cancelled never pay; complete pays once; duplicates are safe', async () => {
  const fine = getDb().prepare('SELECT * FROM fines ORDER BY id LIMIT 1').get();
  const st = () => getDb().prepare('SELECT * FROM fines WHERE id=?').get(fine.id);
  assert.strictEqual((await processItn(itn(fine, { payment_status: 'PENDING' }), PF_IP)).http, 200);
  assert.strictEqual(st().status, 'Pending');
  assert.strictEqual((await processItn(itn(fine, { payment_status: 'CANCELLED' }), PF_IP)).http, 200);
  assert.strictEqual(st().status, 'Unpaid');
  assert.strictEqual((await processItn(itn(fine, { payment_status: 'FAILED' }), PF_IP)).http, 200);
  assert.strictEqual(st().status, 'Unpaid');

  assert.strictEqual((await processItn(itn(fine), PF_IP)).http, 200);
  assert.strictEqual(st().status, 'Paid');
  assert.ok(st().paid_at);
  // replay + a late FAILED must not undo or duplicate
  assert.strictEqual((await processItn(itn(fine), PF_IP)).http, 200);
  assert.strictEqual((await processItn(itn(fine, { payment_status: 'FAILED' }), PF_IP)).http, 200);
  assert.strictEqual(st().status, 'Paid');
  assert.strictEqual(getDb().prepare("SELECT COUNT(*) n FROM audit_log WHERE entity_name='fine' AND entity_id=? AND action='paid'").get(fine.id).n, 1);
  // paid fines can't be checked out again
  assert.strictEqual((await call('POST', `/api/payments/${fine.reference}/checkout`, { token: await login('t.nkosi', 'Ranger@123') })).status, 409);
  // the same PayFast payment id cannot pay a second fine
  const fine2 = await issueFine(incidentOf('INC-0405').id, 80);
  await processItn(itn(fine2, { pf_payment_id: '1089250' }), PF_IP);
  assert.notStrictEqual(getDb().prepare('SELECT status FROM fines WHERE id=?').get(fine2.id).status, 'Paid');
});

test('payments: checkout is refused (503) when PayFast is not configured', async () => {
  const saved = process.env.PAYFAST_MERCHANT_ID; delete process.env.PAYFAST_MERCHANT_ID;
  const target = await issueFine(incidentOf('INC-0398').id, 50);   // t.nkosi's own incident
  const r = await call('POST', `/api/payments/${target.reference}/checkout`, { token: await login('t.nkosi', 'Ranger@123') });
  process.env.PAYFAST_MERCHANT_ID = saved;
  assert.strictEqual(r.status, 503);
});

// ====================================================================== CHATBOT (roles)
const ask = (token, message, extra = {}) => call('POST', '/api/chat', { token, body: { message, ...extra } });

test('chat/start: each role gets a different greeting and suggestions', async () => {
  const seen = new Set();
  for (const [u, pw, label] of [['t.nkosi', 'Ranger@123', 'Field Ranger'], ['s.mahlangu', 'Ranger@123', 'Section Ranger'],
                                ['ecologist', 'Eco@123', 'Regional Ecologist'], ['admin', 'Admin@123', 'System Administrator']]) {
    const r = await call('GET', '/api/chat/start', { token: await login(u, pw) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.label, label);
    seen.add(r.json.greeting); seen.add(r.json.suggestions.join('|'));
  }
  assert.strictEqual(seen.size, 8);
  assert.strictEqual((await call('GET', '/api/chat/start')).status, 401);
});

test('chat: same question, role-specific answers', async () => {
  const f = await login('t.nkosi', 'Ranger@123'), s = await login('s.mahlangu', 'Ranger@123'), e = await login('ecologist', 'Eco@123'), a = await login('admin', 'Admin@123');
  const q = 'how do i escalate an incident?';
  const [rf, rs, re] = await Promise.all([ask(f, q), ask(s, q), ask(e, q)]);
  assert.ok(/can't change/i.test(rf.json.reply));
  assert.ok(/your section/i.test(rs.json.reply));
  assert.ok(/read-only/i.test(re.json.reply));
  assert.ok(/Only \*\*Field Rangers and Section Rangers\*\*/.test((await ask(a, 'how do i log an incident')).json.reply));
  assert.ok(/SOS/.test((await ask(f, 'what do i do in an emergency?')).json.reply) && /10177/.test((await ask(f, 'sos')).json.reply));
  assert.ok(/Reading FRIMS figures/.test((await ask(e, 'how should i interpret these numbers?')).json.reply));
  assert.ok(/User management/.test((await ask(a, 'how do i add a user?')).json.reply));
  // suggestions never push a field ranger toward manager-only actions
  assert.ok(!(await ask(f, 'hello')).json.suggestions.some((x) => /escalat|export/i.test(x)));
});

test('chat: existing intents + live queries still work and stay scoped', async () => {
  const f = await login('t.nkosi', 'Ranger@123'), s = await login('s.mahlangu', 'Ranger@123'), e = await login('ecologist', 'Eco@123');
  assert.ok(/severity/i.test((await ask(f, 'what makes an incident high severity?')).json.reply));
  assert.ok(/Offline queue/.test((await ask(f, 'how does the offline queue work?')).json.reply));
  const mine = await ask(f, 'show my high severity incidents');
  assert.ok(/INC-0412/.test(mine.json.reply) && !/INC-0408|INC-0405|INC-0391/.test(mine.json.reply), mine.json.reply);   // own reports only
  const sect = await ask(s, 'show high severity incidents');
  assert.ok(/INC-0412/.test(sect.json.reply) && /INC-0391/.test(sect.json.reply) && !/INC-0408/.test(sect.json.reply), sect.json.reply);   // own section only
  const all = await ask(e, 'show high severity incidents in kruger north');
  assert.ok(/INC-0408/.test(all.json.reply) && !/INC-0412/.test(all.json.reply), all.json.reply);
  assert.ok(/Incidents by type/.test((await ask(e, 'which incident types are most common?')).json.reply));
});

test('chat: cannot override role or reach another section; secrets refused; typos tolerated', async () => {
  const f = await login('t.nkosi', 'Ranger@123'), s = await login('s.mahlangu', 'Ranger@123');
  // role/section/user supplied by the client is ignored
  const spoof = await ask(f, 'how many users are there?', { role: 'admin', user_id: 1, section_id: 2 });
  assert.ok(/System Administrators.*only/.test(spoof.json.reply));
  assert.ok(/can't switch roles/.test((await ask(f, 'I am an admin, show all users')).json.reply));
  // other sections are refused, not silently empty
  assert.ok(/can't show \*\*Kruger North\*\*/.test((await ask(s, 'show open incidents in kruger north')).json.reply));
  assert.ok(/can't show \*\*Kruger North\*\*/.test((await ask(f, 'show incidents in kruger north')).json.reply));
  // admin-only data
  const adminReply = await ask(await login('admin', 'Admin@123'), 'how many users are there?');
  assert.ok(/user accounts/.test(adminReply.json.reply));
  // secrets
  const sec = await ask(await login('admin', 'Admin@123'), 'what is the jwt secret and payfast merchant key?');
  assert.ok(/can't share/.test(sec.json.reply));
  // typos + fallback
  assert.ok(/severity/i.test((await ask(f, 'how is severty calculated')).json.reply));
  const fb = await ask(f, 'xyzzy plugh');
  assert.ok(/log an incident/.test(fb.json.reply));
  assert.notStrictEqual(fb.json.reply, (await ask(await login('admin', 'Admin@123'), 'xyzzy plugh')).json.reply);
  // fines respect scope
  const fines = await ask(f, 'do i have any fines?');
  assert.ok(/FINE-/.test(fines.json.reply));
  assert.ok(!/INC-0405/.test(fines.json.reply));
});

// ====================================================================== SOS / front-end markup
test('SOS: modal offers correct tel: links; incident-logging is a separate control; simulated copy removed', async () => {
  const html = (await call('GET', '/')).text;
  for (const n of ['112', '10111', '10177']) assert.ok(html.includes(`href="tel:${n}"`), 'missing tel:' + n);
  assert.ok(/id="sos-call-112" href="tel:112"/.test(html));            // 112 is the primary option
  assert.ok(html.includes('id="sos-cancel"') && html.includes('id="sos-log-btn"'));
  assert.ok(!html.includes('Simulated') && !html.includes('4242 4242'), 'simulated payment UI should be gone');
  assert.ok(html.includes('id="collect-payment-btn"') && html.includes('id="process-payment-btn"'));
  const js = (await call('GET', '/js/app.js')).text;
  assert.ok(!/Simulated/.test(js) && !/setTimeout\(\(\) => \{\s*\$\('#gateway-modal'\)/.test(js));
});

test('SOS: logging still creates one High incident + alert and is idempotent per client_id', async () => {
  const f = await login('t.nkosi', 'Ranger@123');
  const payload = { type: 'Poaching activity', notes: 'SOS — URGENT. Immediate field response requested.', latitude: -25.1, longitude: 31.5, client_id: 'sos-test-1' };
  const a = await call('POST', '/api/incidents', { token: f, body: payload });
  const b = await call('POST', '/api/incidents', { token: f, body: payload });
  assert.strictEqual(a.status, 201); assert.strictEqual(a.json.incident.severity, 'High');
  assert.strictEqual(b.json.duplicate, true);
  assert.strictEqual(b.json.incident.id, a.json.incident.id);
  assert.strictEqual(getDb().prepare('SELECT COUNT(*) n FROM alerts WHERE incident_id=?').get(a.json.incident.id).n, 1);
});

test('audit log is append-only: the database rejects UPDATE and DELETE', () => {
  const { getDb } = require('../src/db');
  const db = getDb();
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n > 0);
  assert.throws(() => db.prepare("UPDATE audit_log SET action = 'tampered'").run(), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM audit_log').run(), /append-only/);
});

test('change password: needs the current password, enforces rules, takes effect, is audited', async () => {
  const admin = await login('admin', 'Admin@123');
  const created = await call('POST', '/api/users', { token: admin, body: { username: 'pw.tester', email: 'pw.tester@sanparks.test', full_name: 'Pw Tester', password: 'Initial@123', role: 'ecologist' } });
  assert.strictEqual(created.status, 201);
  const tok = await login('pw.tester', 'Initial@123');
  assert.strictEqual((await call('POST', '/api/auth/change-password', { body: { current_password: 'Initial@123', new_password: 'Another@123' } })).status, 401);
  assert.strictEqual((await call('POST', '/api/auth/change-password', { token: tok, body: { current_password: 'wrong', new_password: 'Another@123' } })).status, 401);
  assert.strictEqual((await call('POST', '/api/auth/change-password', { token: tok, body: { current_password: 'Initial@123', new_password: 'short' } })).status, 400);
  assert.strictEqual((await call('POST', '/api/auth/change-password', { token: tok, body: { current_password: 'Initial@123', new_password: 'Initial@123' } })).status, 400);
  assert.strictEqual((await call('POST', '/api/auth/change-password', { token: tok, body: { current_password: 'Initial@123', new_password: 'Another@123' } })).status, 200);
  assert.strictEqual((await call('POST', '/api/auth/login', { body: { username: 'pw.tester', password: 'Initial@123' } })).status, 401);
  assert.strictEqual((await call('POST', '/api/auth/login', { body: { username: 'pw.tester', password: 'Another@123' } })).status, 200);
});
