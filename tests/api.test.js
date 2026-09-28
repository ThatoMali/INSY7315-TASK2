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
