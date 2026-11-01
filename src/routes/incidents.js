const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { getDb } = require('../db');
const { authorize, validate } = require('../middleware');
const { triage } = require('../triage');
const { audit, listAudit } = require('../audit');
const { scopeSql, endOfDay } = require('../scope');

const TYPES      = ['Snare found', 'Poaching activity', 'Fence breach', 'Wildlife sighting',
                    'Injured animal', 'Carcass found', 'Vehicle in restricted area', 'Other'];
const SEVERITIES = ['Low', 'Medium', 'High'];
const STATUSES   = ['Open', 'Escalated', 'Resolved'];
const IMAGE_EXT  = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;

const INCIDENT_SELECT = `
  SELECT i.*, u.full_name AS reported_by_name, s.name AS section_name
  FROM incidents i
  LEFT JOIN users u ON u.id = i.reported_by
  LEFT JOIN sections s ON s.id = i.section_id
`;

// ---------- list ----------
router.get('/', (req, res) => {
  const { status, severity, type, section_id, reported_by, from, to, q, limit } = req.query;
  const params = [];
  let sql = INCIDENT_SELECT + ' WHERE 1=1' + scopeSql(req.user, params, section_id);

  if (status)      { sql += ' AND i.status = ?';      params.push(status); }
  if (severity)    { sql += ' AND i.severity = ?';    params.push(severity); }
  if (type)        { sql += ' AND i.type = ?';        params.push(type); }
  if (reported_by) { sql += ' AND i.reported_by = ?'; params.push(reported_by); }
  if (from)        { sql += ' AND i.created_at >= ?'; params.push(from); }
  if (to)          { sql += ' AND i.created_at <= ?'; params.push(endOfDay(to)); }
  if (q)           { sql += ' AND (i.reference LIKE ? OR i.notes LIKE ?)'; params.push('%' + q + '%', '%' + q + '%'); }

  sql += ' ORDER BY i.created_at DESC, i.id DESC LIMIT ?';
  params.push(Math.min(parseInt(limit, 10) || 200, 500));

  res.json({ incidents: getDb().prepare(sql).all(...params) });
});

// ---------- dashboard stats ----------
router.get('/stats', (req, res) => {
  const db = getDb();
  const params = [];
  const where = '1=1' + scopeSql(req.user, params, req.query.section_id);
  const count = (extra) => db.prepare(`SELECT COUNT(*) AS n FROM incidents i WHERE ${where} ${extra}`).get(...params).n;

  res.json({
    open:      count(`AND i.status='Open'`),
    escalated: count(`AND i.status='Escalated'`),
    resolved:  count(`AND i.status='Resolved' AND i.updated_at >= datetime('now','start of month')`),
    total:     count(''),
    byType:    db.prepare(`SELECT i.type, COUNT(*) AS count FROM incidents i WHERE ${where} GROUP BY i.type ORDER BY count DESC`).all(...params),
  });
});

// ---------- live triage preview (used by the ranger form) ----------
router.post('/triage', (req, res) => {
  const { type = '', notes = '' } = req.body || {};
  res.json(triage(String(type), String(notes)));
});

// ---------- one incident (+ audit trail) ----------
router.get('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(404).json({ error: 'Incident not found' });

  const inc = getDb().prepare(INCIDENT_SELECT + ' WHERE i.id = ?').get(id);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });
  if (req.user.role === 'field_ranger'   && inc.reported_by !== req.user.sub)       return res.status(403).json({ error: 'Access denied' });
  if (req.user.role === 'section_ranger' && inc.section_id  !== req.user.section_id) return res.status(403).json({ error: 'Access denied' });

  inc.audit = listAudit('incident', inc.id);
  res.json({ incident: inc });
});

// ---------- create ----------
router.post('/',
  authorize('field_ranger', 'section_ranger'),
  validate({
    type:      { required: true, oneOf: TYPES },
    notes:     { type: 'string', maxLength: 4000 },
    latitude:  { required: true, type: 'number', min: -90,  max: 90 },
    longitude: { required: true, type: 'number', min: -180, max: 180 },
  }),
  (req, res) => {
    const db = getDb();
    if (!req.user.section_id) return res.status(400).json({ error: 'Your account is not assigned to a section' });

    const { type, latitude, longitude, photo_base64, client_id, captured_at } = req.body;

    // Idempotency: an offline-queued report that was already received is returned, not duplicated.
    const cid = typeof client_id === 'string' && client_id ? client_id.slice(0, 64) : null;
    if (cid) {
      const existing = db.prepare('SELECT * FROM incidents WHERE reported_by = ? AND client_id = ?').get(req.user.sub, cid);
      if (existing) return res.status(200).json({ incident: existing, duplicate: true });
    }

    // Strip control characters from free text (output is also HTML-escaped by the client)
    const notes = String(req.body.notes || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();

    // Severity/status are decided by the server, never trusted from the client
    const ai = triage(type, notes);
    const severity = ai.severity;
    const status   = severity === 'High' ? 'Escalated' : 'Open';

    // Time of capture: honour the device time for offline reports if it is sane
    let createdAt = null;
    if (captured_at) {
      const t = new Date(captured_at).getTime();
      if (Number.isFinite(t) && t <= Date.now() + 60000 && t > Date.now() - 30 * 86400000) {
        createdAt = new Date(t).toISOString().replace('T', ' ').slice(0, 19);
      }
    }

    // Photo (data URL) → /uploads, image types only
    let photoPath = null;
    if (photo_base64) {
      const m = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(photo_base64));
      const ext = m && IMAGE_EXT[m[1].toLowerCase()];
      if (!ext) return res.status(400).json({ error: 'Photo must be a JPEG, PNG or WebP image' });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > MAX_PHOTO_BYTES) return res.status(400).json({ error: 'Photo is too large (max 6 MB)' });
      if (!fs.existsSync(config.UPLOAD_DIR)) fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
      const fname = crypto.randomBytes(12).toString('hex') + '.' + ext;
      fs.writeFileSync(path.join(config.UPLOAD_DIR, fname), buf);
      photoPath = '/uploads/' + fname;
    }

    const insert = db.transaction(() => {
      const last = db.prepare(`SELECT MAX(CAST(SUBSTR(reference, 5) AS INTEGER)) AS n FROM incidents`).get().n || 0;
      const reference = 'INC-' + String(last + 1).padStart(4, '0');
      const info = db.prepare(`
        INSERT INTO incidents
          (reference, client_id, type, severity, status, notes, latitude, longitude,
           reported_by, section_id, photo_path, ai_suggestion, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
      `).run(reference, cid, type, severity, status, notes, Number(latitude), Number(longitude),
             req.user.sub, req.user.section_id, photoPath, ai.severity, createdAt, createdAt);

      const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(info.lastInsertRowid);
      audit('incident', incident.id, 'created', req.user.sub, null, incident);
      if (severity === 'High') {
        db.prepare(`INSERT INTO alerts (incident_id, message, severity) VALUES (?, ?, 'High')`)
          .run(incident.id, `High-severity incident logged: ${type} (${reference})`);
      }
      return incident;
    });

    res.status(201).json({ incident: insert() });
  }
);

// ---------- update status / severity ----------
router.patch('/:id', authorize('section_ranger', 'admin'), (req, res) => {
  const db = getDb();
  const inc = db.prepare('SELECT * FROM incidents WHERE id = ?').get(parseInt(req.params.id, 10) || 0);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });
  if (req.user.role === 'section_ranger' && inc.section_id !== req.user.section_id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const { status, severity } = req.body || {};
  if (!status && !severity)                       return res.status(400).json({ error: 'Nothing to update' });
  if (status   && !STATUSES.includes(status))     return res.status(400).json({ error: 'Invalid status' });
  if (severity && !SEVERITIES.includes(severity)) return res.status(400).json({ error: 'Invalid severity' });

  db.prepare(`
    UPDATE incidents SET status = COALESCE(?, status), severity = COALESCE(?, severity), updated_at = datetime('now')
    WHERE id = ?
  `).run(status || null, severity || null, inc.id);

  const updated = db.prepare('SELECT * FROM incidents WHERE id = ?').get(inc.id);
  audit('incident', inc.id, status && status !== inc.status ? status.toLowerCase() : 'updated', req.user.sub, inc, updated);

  if (status === 'Escalated' && inc.status !== 'Escalated') {
    db.prepare(`INSERT INTO alerts (incident_id, message, severity) VALUES (?, ?, ?)`)
      .run(inc.id, `Incident escalated: ${inc.type} (${inc.reference})`, updated.severity);
  }
  res.json({ incident: updated });
});

module.exports = router;
