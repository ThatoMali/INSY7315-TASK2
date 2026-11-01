const { getDb } = require('./db');

// Never persist credential material in the audit trail.
function clean(value) {
  if (value == null) return null;
  const copy = { ...value };
  delete copy.password_hash;
  delete copy.password;
  return JSON.stringify(copy);
}

function audit(entity, entityId, action, userId, oldValue, newValue) {
  getDb().prepare(`
    INSERT INTO audit_log (entity_name, entity_id, action, user_id, old_value, new_value)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(entity, entityId, action, userId || null, clean(oldValue), clean(newValue));
}

function listAudit(entity, entityId) {
  return getDb().prepare(`
    SELECT a.id, a.action, a.timestamp, u.full_name AS user_name
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.entity_name = ? AND a.entity_id = ?
    ORDER BY a.timestamp ASC, a.id ASC
  `).all(entity, entityId);
}

module.exports = { audit, listAudit };
