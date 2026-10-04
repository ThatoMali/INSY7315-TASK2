const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authorize } = require('../middleware');

router.get('/', authorize('admin', 'ecologist'), (req, res) => {
  const entries = getDb().prepare(`
    SELECT a.id, a.entity_name, a.entity_id, a.action, a.timestamp,
           u.full_name AS user_name,
           CASE a.entity_name WHEN 'incident' THEN i.reference WHEN 'user' THEN t.username END AS target
    FROM audit_log a
    LEFT JOIN users u     ON u.id = a.user_id
    LEFT JOIN incidents i ON a.entity_name = 'incident' AND i.id = a.entity_id
    LEFT JOIN users t     ON a.entity_name = 'user'     AND t.id = a.entity_id
    ORDER BY a.timestamp DESC, a.id DESC
    LIMIT 200
  `).all();
  res.json({ entries });
});

module.exports = router;
