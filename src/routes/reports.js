const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { authorize } = require('../middleware');
const { scopeSql, endOfDay } = require('../scope');

// Quote CSV fields and neutralise spreadsheet formulas (=, +, -, @) in free text.
function csvText(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

router.get('/incidents.:format', authorize('section_ranger', 'ecologist', 'admin'), (req, res) => {
  const { format } = req.params;
  const { from, to, section_id } = req.query;
  if (!['csv', 'json'].includes(format)) return res.status(400).json({ error: 'Unsupported format. Use csv or json.' });

  const params = [];
  let sql = `
    SELECT i.reference, i.created_at, i.type, i.severity, i.status,
           i.latitude, i.longitude, i.notes,
           u.full_name AS reported_by_name, s.name AS section_name
    FROM incidents i
    LEFT JOIN users u ON u.id = i.reported_by
    LEFT JOIN sections s ON s.id = i.section_id
    WHERE 1=1 ${scopeSql(req.user, params, section_id)}
  `;
  if (from) { sql += ' AND i.created_at >= ?'; params.push(from); }
  if (to)   { sql += ' AND i.created_at <= ?'; params.push(endOfDay(to)); }
  sql += ' ORDER BY i.created_at DESC';

  const rows  = getDb().prepare(sql).all(...params);
  const stamp = new Date().toISOString().slice(0, 10);

  if (format === 'json') {
    return res.json({ generated_at: new Date().toISOString(), count: rows.length, incidents: rows });
  }

  const headers = ['Reference', 'Date (UTC)', 'Type', 'Severity', 'Status', 'Latitude', 'Longitude', 'Reported By', 'Section', 'Notes'];
  const lines = [headers.join(',')];
  rows.forEach((r) => lines.push([
    r.reference, r.created_at, csvText(r.type), r.severity, r.status,
    r.latitude, r.longitude,
    csvText(r.reported_by_name), csvText(r.section_name), csvText(r.notes),
  ].join(',')));

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="frims-incidents-${stamp}.csv"`);
  res.send('\ufeff' + lines.join('\r\n'));   // BOM so Excel reads UTF-8 correctly
});

module.exports = router;
