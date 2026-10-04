/* Role-based data scoping, shared by incidents / alerts / reports.
   field_ranger   → only their own incidents
   section_ranger → only their section
   ecologist/admin→ everything (optionally narrowed by ?section_id=) */
function scopeSql(user, params, sectionQuery, alias = 'i') {
  if (user.role === 'field_ranger')   { params.push(user.sub);        return ` AND ${alias}.reported_by = ?`; }
  if (user.role === 'section_ranger') { params.push(user.section_id); return ` AND ${alias}.section_id = ?`; }
  const sid = parseInt(sectionQuery, 10);
  if (sid) { params.push(sid); return ` AND ${alias}.section_id = ?`; }
  return '';
}

// "2026-09-23" as an upper bound should include the whole day.
function endOfDay(to) {
  return /^\d{4}-\d{2}-\d{2}$/.test(to) ? to + ' 23:59:59' : to;
}

module.exports = { scopeSql, endOfDay };
