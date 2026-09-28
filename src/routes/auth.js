const express = require('express');
const router = express.Router();
const config = require('../config');
const { getDb } = require('../db');
const { hashPassword, verifyPassword, signToken } = require('../auth');
const { authenticate, validate } = require('../middleware');
const { audit } = require('../audit');

// --- tiny in-memory brute-force guard: 10 failed logins / 15 min per IP+username ---
const WINDOW_MS = 15 * 60 * 1000, MAX_FAILS = 10;
const fails = new Map();
function failKey(req, username) { return req.ip + '|' + String(username).toLowerCase(); }
function isLocked(key) {
  const f = fails.get(key);
  if (!f) return false;
  if (Date.now() - f.first > WINDOW_MS) { fails.delete(key); return false; }
  return f.count >= MAX_FAILS;
}
function recordFail(key) {
  const f = fails.get(key);
  if (!f || Date.now() - f.first > WINDOW_MS) fails.set(key, { count: 1, first: Date.now() });
  else f.count++;
  if (fails.size > 5000) fails.clear();
}

const USER_SQL = `
  SELECT u.*, s.name AS section_name
  FROM users u LEFT JOIN sections s ON s.id = u.section_id
`;

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  const key = failKey(req, username);
  if (isLocked(key)) return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });

  const user = getDb().prepare(USER_SQL + ' WHERE u.username = ?').get(username.trim());
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordFail(key);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  if (user.status !== 'Active') return res.status(403).json({ error: 'Account is not active' });

  fails.delete(key);
  audit('user', user.id, 'login', user.id, null, null);
  res.json({ token: signToken(user), user: publicUser(user) });
});

router.get('/me', authenticate, (req, res) => {
  const user = getDb().prepare(USER_SQL + ' WHERE u.id = ?').get(req.user.sub);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(user) });
});

// Public self-registration is OFF unless ALLOW_REGISTRATION=true (accounts are normally created by an admin).
router.post('/register',
  (req, res, next) => config.ALLOW_REGISTRATION ? next() : res.status(403).json({ error: 'Self-registration is disabled. Ask an administrator for an account.' }),
  validate({
    username: { required: true, type: 'string', maxLength: 60 },
    email:    { required: true, type: 'string', maxLength: 120 },
    full_name:{ required: true, type: 'string', maxLength: 120 },
    password: { required: true, type: 'string', maxLength: 200 },
  }),
  (req, res) => {
    const { username, email, full_name, password } = req.body;
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const db = getDb();
    if (db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email)) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    const info = db.prepare(`
      INSERT INTO users (username, email, full_name, password_hash, role, status)
      VALUES (?, ?, ?, ?, 'field_ranger', 'Active')
    `).run(username, email, full_name, hashPassword(password));
    res.status(201).json({ id: info.lastInsertRowid });
  }
);

function publicUser(u) {
  return {
    id: u.id, username: u.username, email: u.email,
    full_name: u.full_name, role: u.role,
    section_id: u.section_id, section_name: u.section_name || null,
    status: u.status,
  };
}

module.exports = router;
