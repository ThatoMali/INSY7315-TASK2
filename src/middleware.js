const { verifyToken } = require('./auth');
const { getDb } = require('./db');

// Verifies the JWT, then re-loads the user so role/section changes and
// deactivation take effect immediately (not only when the token expires).
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  let payload;
  try { payload = verifyToken(token); }
  catch { return res.status(401).json({ error: 'Invalid or expired token' }); }

  const user = getDb().prepare(
    'SELECT id, username, full_name, role, section_id, status FROM users WHERE id = ?'
  ).get(payload.sub);
  if (!user || user.status !== 'Active') {
    return res.status(401).json({ error: 'Account is no longer active' });
  }
  req.user = { sub: user.id, username: user.username, full_name: user.full_name, role: user.role, section_id: user.section_id };
  next();
}

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (roles.length && !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action' });
    }
    next();
  };
}

class ValidationError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

const isNumeric = (v) =>
  (typeof v === 'number' && Number.isFinite(v)) ||
  (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));

function validate(rules) {
  return (req, res, next) => {
    const errors = [];
    for (const [field, rule] of Object.entries(rules)) {
      const value = req.body ? req.body[field] : undefined;
      if (rule.required && (value === undefined || value === null || value === '')) {
        errors.push(`${field} is required`); continue;
      }
      if (value === undefined || value === null) continue;
      if (rule.type === 'number') {
        if (!isNumeric(value)) { errors.push(`${field} must be a number`); continue; }
        if (rule.min !== undefined && Number(value) < rule.min) errors.push(`${field} must be at least ${rule.min}`);
        if (rule.max !== undefined && Number(value) > rule.max) errors.push(`${field} must be at most ${rule.max}`);
      }
      if (rule.type === 'string' && typeof value !== 'string') errors.push(`${field} must be text`);
      if (rule.maxLength && String(value).length > rule.maxLength) errors.push(`${field} exceeds max length`);
      if (rule.oneOf && !rule.oneOf.includes(value)) errors.push(`${field} must be one of: ${rule.oneOf.join(', ')}`);
    }
    if (errors.length) return next(new ValidationError(errors.join('; ')));
    next();
  };
}

function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Endpoint not found' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : (err.message || 'Request failed') });
}

module.exports = { authenticate, authorize, validate, ValidationError, notFoundHandler, errorHandler };
