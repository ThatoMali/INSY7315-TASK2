const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authorize } = require('../middleware');
const { scopeSql } = require('../scope');

// Alerts are for the people who manage incidents, not for field rangers.
router.use(authorize('section_ranger', 'ecologist', 'admin'));

router.get('/', (req, res) => {
  const params = [];
  const sql = `
    SELECT a.*, i.reference, i.type, i.section_id, u.full_name AS reported_by_name
    FROM alerts a
    JOIN incidents i ON i.id = a.incident_id
    LEFT JOIN users u ON u.id = i.reported_by
    WHERE 1=1 ${scopeSql(req.user, params, req.query.section_id)}
    ORDER BY a.created_at DESC, a.id DESC LIMIT 100
  `;
  res.json({ alerts: getDb().prepare(sql).all(...params) });
});

router.patch('/read-all', (req, res) => {
  const params = [];
  const scope = scopeSql(req.user, params, req.query.section_id);
  const info = getDb().prepare(`
    UPDATE alerts SET is_read = 1
    WHERE is_read = 0 AND incident_id IN (SELECT i.id FROM incidents i WHERE 1=1 ${scope})
  `).run(...params);
  res.json({ ok: true, updated: info.changes });
});

router.patch('/:id/read', (req, res) => {
  const params = [parseInt(req.params.id, 10) || 0];
  const scope = scopeSql(req.user, params);
  const info = getDb().prepare(`
    UPDATE alerts SET is_read = 1
    WHERE id = ? AND incident_id IN (SELECT i.id FROM incidents i WHERE 1=1 ${scope})
  `).run(...params);
  if (!info.changes) return res.status(404).json({ error: 'Alert not found' });
  res.json({ ok: true });
});

module.exports = router;
