const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authorize, validate } = require('../middleware');
const { hashPassword } = require('../auth');
const { audit } = require('../audit');

const ROLES    = ['field_ranger', 'section_ranger', 'ecologist', 'admin'];
const STATUSES = ['Active', 'Invited', 'Inactive'];
const NEEDS_SECTION = ['field_ranger', 'section_ranger'];

const USER_SELECT = `
  SELECT u.id, u.username, u.email, u.full_name, u.role, u.status,
         u.section_id, s.name AS section_name, u.created_at
  FROM users u LEFT JOIN sections s ON s.id = u.section_id
`;

router.get('/sections', (req, res) => {
  res.json({ sections: getDb().prepare('SELECT * FROM sections ORDER BY name').all() });
});

router.get('/', authorize('admin', 'section_ranger', 'ecologist'), (req, res) => {
  const params = [];
  let sql = USER_SELECT;
  if (req.user.role === 'section_ranger') { sql += ' WHERE u.section_id = ?'; params.push(req.user.section_id); }
  sql += ' ORDER BY u.full_name';
  res.json({ users: getDb().prepare(sql).all(...params) });
});

router.post('/',
  authorize('admin'),
  validate({
    username:  { required: true, type: 'string', maxLength: 60 },
    email:     { required: true, type: 'string', maxLength: 120 },
    full_name: { required: true, type: 'string', maxLength: 120 },
    password:  { required: true, type: 'string', maxLength: 200 },
    role:      { required: true, oneOf: ROLES },
  }),
  (req, res) => {
    const db = getDb();
    const { username, email, full_name, password, role, section_id, status } = req.body;
    const sid = section_id ? Number(section_id) : null;
    const st  = status || 'Active';

    if (password.length < 8)     return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!STATUSES.includes(st))  return res.status(400).json({ error: 'Invalid status' });
    if (NEEDS_SECTION.includes(role) && !sid) return res.status(400).json({ error: 'Rangers must be assigned to a section' });
    if (sid && !db.prepare('SELECT id FROM sections WHERE id = ?').get(sid)) return res.status(400).json({ error: 'Unknown section' });
    if (db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username.trim(), email.trim())) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }

    const info = db.prepare(`
      INSERT INTO users (username, email, full_name, password_hash, role, section_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(username.trim(), email.trim(), full_name.trim(), hashPassword(password), role, sid, st);

    const user = db.prepare(USER_SELECT + ' WHERE u.id = ?').get(info.lastInsertRowid);
    audit('user', user.id, 'created', req.user.sub, null, user);
    res.status(201).json({ user });
  }
);

router.patch('/:id', authorize('admin'), (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(parseInt(req.params.id, 10) || 0);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const b = req.body || {};
  const next = {
    full_name:  typeof b.full_name === 'string' && b.full_name.trim() ? b.full_name.trim() : user.full_name,
    email:      typeof b.email === 'string' && b.email.trim() ? b.email.trim() : user.email,
    role:       b.role   || user.role,
    status:     b.status || user.status,
    section_id: 'section_id' in b ? (b.section_id ? Number(b.section_id) : null) : user.section_id,
  };

  if (!ROLES.includes(next.role))       return res.status(400).json({ error: 'Invalid role' });
  if (!STATUSES.includes(next.status))  return res.status(400).json({ error: 'Invalid status' });
  if (next.full_name.length > 120 || next.email.length > 120) return res.status(400).json({ error: 'Name or email too long' });
  if (NEEDS_SECTION.includes(next.role) && !next.section_id) return res.status(400).json({ error: 'Rangers must be assigned to a section' });
  if (next.section_id && !db.prepare('SELECT id FROM sections WHERE id = ?').get(next.section_id)) return res.status(400).json({ error: 'Unknown section' });
  if (user.id === req.user.sub && (next.role !== 'admin' || next.status !== 'Active')) {
    return res.status(400).json({ error: 'You cannot change your own role or deactivate your own account' });
  }
  if (b.password !== undefined && b.password !== '' && (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 200)) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(next.email, user.id)) {
    return res.status(409).json({ error: 'Email already in use' });
  }

  db.prepare(`
    UPDATE users SET full_name = ?, email = ?, role = ?, section_id = ?, status = ?,
      password_hash = COALESCE(?, password_hash), updated_at = datetime('now')
    WHERE id = ?
  `).run(next.full_name, next.email, next.role, next.section_id, next.status,
         b.password ? hashPassword(b.password) : null, user.id);

  const updated = db.prepare(USER_SELECT + ' WHERE u.id = ?').get(user.id);
  audit('user', user.id, b.password ? 'updated (password reset)' : 'updated', req.user.sub, user, updated);
  res.json({ user: updated });
});

router.delete('/:id', authorize('admin'), (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10) || 0;
  if (id === req.user.sub) return res.status(400).json({ error: 'You cannot deactivate your own account' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  db.prepare(`UPDATE users SET status='Inactive', updated_at=datetime('now') WHERE id = ?`).run(user.id);
  audit('user', user.id, 'deactivated', req.user.sub, user, { ...user, status: 'Inactive' });
  res.json({ ok: true });
});

module.exports = router;
