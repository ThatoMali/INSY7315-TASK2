const express = require('express');
const router = express.Router();
const { getDb } = require('../db');
const { scopeSql } = require('../scope');
const { triage } = require('../triage');

/*
  FRIMS assistant — deterministic, offline, no external API.

  Flow:  normalise → match intents → (optionally) query DB scoped to the user
         → return { reply, suggestions[], data? }

  It answers within the user's own permissions: a field ranger can only see
  their own incidents, a section ranger only their section, and so on.
*/

const HELP_SUGGESTIONS = [
  'How do I log an incident?',
  'What makes an incident High severity?',
  'How many incidents are open?',
  'Show me today\'s high-severity incidents',
  'What can a field ranger do?',
  'How does the offline queue work?',
];

const norm = (s) => String(s || '').toLowerCase().replace(/[^\w\s?]/g, ' ').replace(/\s+/g, ' ').trim();
const has = (text, ...words) => words.some((w) => text.includes(w));

// ---------- static answers (the FRIMS knowledge base) ----------
const KNOWLEDGE = [
  {
    id: 'log_incident',
    match: (t) => has(t, 'how do i log', 'how to log', 'log an incident', 'report an incident', 'new incident', 'capture incident', 'submit report'),
    reply: `**Logging an incident (field ranger)**\n\n1. Open the **Log** tab.\n2. Pick the **Incident type**.\n3. Tap **📍 Locate** to capture GPS (or type "lat, lng").\n4. Attach a **photo** if you have one.\n5. Add **notes** — the AI severity tag updates as you type.\n6. Tap **SUBMIT**.\n\nIf you're offline, the report is saved on the device and syncs automatically when you reconnect. You can also force it from **Profile → Sync now**.`,
    suggestions: ['What makes an incident High severity?', 'How does the offline queue work?'],
  },
  {
    id: 'severity',
    match: (t) => has(t, 'severity', 'how severe', 'high severity', 'ai tag', 'triage', 'how is severity calculated', 'risk score'),
    reply: `**How severity is worked out**\n\nSeverity is set by the server (rule-based triage), never by the device — so it can't be spoofed.\n\n- **Base score by type** — e.g. *Poaching activity* = 8, *Snare found* = 5, *Carcass found* = 4, *Wildlife sighting* = 0.\n- **Keywords in the notes add points** — *gunshot, armed, rifle, poacher, horn(s) removed, tusks removed* are worth the most; *blood, snare, trap, wound, fresh* add less.\n- **Calming phrases subtract points** — *no recent activity, no sign, inactive, routine, old* lower the score.\n- **Thresholds** — score ≥ 8 → **High**, ≥ 3 → **Medium**, otherwise **Low**.\n\nHigh-severity reports are auto-**Escalated** and raise an alert. Type a description and I'll score it live.`,
    suggestions: ['Score this: fresh wire snare near the waterhole', 'What does Escalated mean?'],
  },
  {
    id: 'offline',
    match: (t) => has(t, 'offline', 'no signal', 'no connection', 'sync', 'queued', 'pending', 'retry'),
    reply: `**Offline queue**\n\nWhen you submit without a connection, the report is stored on your device (a *Pending* row shows in **My Reports**). It sends automatically when you're back online, or you can trigger it from **Profile → Sync now**.\n\nEach report carries a unique \`client_id\`, so if a retry succeeds twice the server recognises the duplicate and returns the original — **nothing is ever logged twice**. Reports the server rejects outright (e.g. bad data) are dropped from the queue with a toast, so it can't get stuck.`,
    suggestions: ['How do I log an incident?', 'Why is my report still pending?'],
  },
  {
    id: 'roles',
    match: (t) => has(t, 'what can a', 'permissions', 'who can', 'my role', 'what am i allowed', 'role do'),
    reply: `**Roles at a glance**\n\n- **Field Ranger** — logs incidents (GPS, photo, offline). Sees only their own reports.\n- **Section Ranger** — sees every incident in *their* section, escalates / resolves / reopens, exports CSV/PDF, gets high-severity alerts.\n- **Regional Ecologist** — sees *all* sections (filterable), read-only on incidents, can view the audit log and export.\n- **System Administrator** — everything, plus user management (create/edit/deactivate) and the audit log.\n\nScoping is enforced on the **server**, not just hidden in the UI.`,
    suggestions: ['How do I escalate an incident?', 'Who can export data?'],
  },
  {
    id: 'escalate',
    match: (t) => has(t, 'escalate', 'escalated', 'reopen', 'resolve', 'mark resolved', 'close incident'),
    reply: `**Managing incident status**\n\nSection rangers and admins can move an incident between **Open → Escalated → Resolved** (and reopen a resolved one).\n\n- **Escalate** — raises the profile and creates an alert for the section.\n- **Mark resolved** — closes it out (counts toward the MTD "Resolved" stat).\n- **Reopen** — sends a resolved incident back to *Open*.\n\nHigh-severity incidents are escalated automatically on creation. Every change is written to the audit trail.`,
    suggestions: ['What makes an incident High severity?', 'Show incidents by status'],
  },
  {
    id: 'alerts',
    match: (t) => has(t, 'alert', 'notification', 'unread', 'high severity alert'),
    reply: `**Alerts**\n\nAlerts are for managers (section ranger, ecologist, admin) — not field rangers. A high-severity incident raises an alert automatically, and escalating an incident raises another. The **High-Severity Alerts** panel shows unread alerts first; click one to jump to the incident, or hit **Mark all read**.`,
    suggestions: ['Show unread alerts', 'How many incidents are open?'],
  },
  {
    id: 'export',
    match: (t) => has(t, 'export', 'csv', 'pdf', 'download', 'print', 'report'),
    reply: `**Exporting**\n\nOn the dashboard, **Export CSV** downloads the incidents in your scope (Excel-safe: a BOM is added and leading =,+,-,@ are neutralised to stop formula injection). **Export PDF** opens the print dialog — choose *Save as PDF*. Both respect the section filter and your role's data scope.`,
    suggestions: ['How many incidents are open?', 'What can a field ranger do?'],
  },
  {
    id: 'gps',
    match: (t) => has(t, 'gps', 'location', 'coordinates', 'lat', 'lng', 'locate'),
    reply: `**Capturing location**\n\nTap **📍 Locate** on the log screen — the app asks the browser for your position and fills in "lat, lng". If GPS is unavailable you can type coordinates manually, e.g. \`-25.10230, 31.51820\`. Valid ranges: latitude −90…90, longitude −180…180.`,
    suggestions: ['How do I log an incident?', 'How does the offline queue work?'],
  },
  {
    id: 'photo',
    match: (t) => has(t, 'photo', 'image', 'picture', 'camera', 'attach'),
    reply: `**Attaching a photo**\n\nTap **Attach Photo** on the log screen. On a phone it opens the rear camera; on desktop it's a file picker. Photos are downscaled in the browser (max 1280 px, JPEG) so they upload over weak connections. Accepted types: **JPEG, PNG, WebP** — max 6 MB after processing. They're stored under \`/uploads/<random name>\`.`,
    suggestions: ['How does the offline queue work?', 'How do I log an incident?'],
  },
  {
    id: 'privacy',
    match: (t) => has(t, 'security', 'secure', 'password', 'privacy', 'safe', 'hack'),
    reply: `**Security**\n\nPasswords are hashed with bcrypt. Sessions use signed JWTs that are re-checked against the database on every request, so deactivating a user takes effect **immediately** rather than when their token expires. Logins are rate-limited (10 failed attempts per 15 minutes). The app ships a strict Content-Security-Policy, uses parameterised SQL only, escapes output, whitelists image types on upload, and never stores password material in the audit log.`,
    suggestions: ['What can a field ranger do?', 'Help'],
  },
  {
    id: 'account',
    match: (t) => has(t, 'my account', 'profile', 'change password', 'my details', 'who am i', 'my id'),
    reply: `**Your account**\n\nOpen **Profile** from the tab bar (ranger) or the 👤 button (dashboard). It shows your name, role, section, app version, last sync time and pending uploads. To change your password, ask an administrator — passwords are reset from **Users → Edit**.`,
    suggestions: ['What can a field ranger do?', 'Help'],
  },
  {
    id: 'greeting',
    match: (t) => /^(hi|hello|hey|good (morning|afternoon|evening)|howzit|molo)\b/.test(t) || has(t, 'hello', 'hi there'),
    reply: `Hello! I'm the **FRIMS assistant**. I can explain how to log an incident, how severity is calculated, what your role allows, or pull live numbers from your incidents. What do you need?`,
    suggestions: HELP_SUGGESTIONS,
  },
  {
    id: 'thanks',
    match: (t) => has(t, 'thank', 'thanks', 'cheers', 'ta '),
    reply: `Happy to help. Anything else — logging, severity, exports, or your incident numbers?`,
    suggestions: HELP_SUGGESTIONS,
  },
  {
    id: 'help',
    match: (t) => has(t, 'help', 'what can you do', 'what can you help', 'commands', 'options'),
    reply: `**I can help with:**\n\n- **Logging** — how to submit an incident, GPS, photos\n- **Severity** — what makes something High/Medium/Low (and I'll score a description for you)\n- **Offline** — the queue, syncing, duplicate protection\n- **Status** — escalating, resolving, reopening\n- **Alerts, exports, roles, security**\n\nI can also answer live questions like *"how many incidents are open?"*, *"show today's high-severity incidents"*, or *"what's open in Kruger North?"*`,
    suggestions: HELP_SUGGESTIONS,
  },
];

// ---------- live-data intents (query the scoped DB) ----------
const STAT_WORDS   = ['how many', 'count', 'number of', 'how much', 'stats', 'statistics', 'summary', 'overview'];
const HIGH_WORDS   = ['high', 'severe', 'critical', 'escalated'];
const OPEN_WORDS   = ['open', 'outstanding', 'unresolved', 'active'];
const TODAY_WORDS  = ['today', 'last 24', '24 hours', 'this morning'];
const LIST_WORDS   = ['show', 'list', 'give me', 'which', 'what are', 'see'];

function sectionNames() {
  return getDb().prepare('SELECT id, name FROM sections ORDER BY name').all();
}

function resolveSection(text, user) {
  // Only managers may target another section; field rangers are pinned to their own data anyway.
  if (user.role === 'field_ranger') return null;
  const wanted = sectionNames().find((s) => text.includes(s.name.toLowerCase()) || text.includes(s.name.toLowerCase().split(' ')[0]));
  if (wanted) return wanted;
  const m = /\bsection\s+(\d+)\b/.exec(text);
  if (m) { const s = sectionNames().find((x) => x.id === Number(m[1])); if (s) return s; }
  return null;
}

function findIncidentByRef(text, user) {
  const m = /\binc-\d{3,6}\b/i.exec(text);
  if (!m) return null;
  const params = [m[0].toUpperCase()];
  const scope = scopeSql(user, params);
  return getDb().prepare(`
    SELECT i.*, u.full_name AS reported_by_name, s.name AS section_name
    FROM incidents i
    LEFT JOIN users u ON u.id = i.reported_by
    LEFT JOIN sections s ON s.id = i.section_id
    WHERE UPPER(i.reference) = ? ${scope}
  `).get(...params);
}

function buildWhere(text, user, params, { status, severity, today } = {}) {
  let sql = 'WHERE 1=1' + scopeSql(user, params);
  if (status)   { sql += ' AND i.status = ?';   params.push(status); }
  if (severity) { sql += ' AND i.severity = ?'; params.push(severity); }
  if (today)    { sql += " AND i.created_at >= datetime('now','-1 day')"; }
  const sec = resolveSection(text, user);
  if (sec) { sql += ' AND i.section_id = ?'; params.push(sec.id); }
  return { sql, section: sec };
}

function runLiveQuery(text, user) {
  const db = getDb();
  const params = [];

  // --- incident by reference ---
  const byRef = findIncidentByRef(text, user);
  if (byRef) {
    return {
      reply: `**${byRef.reference}** — ${byRef.type}\n\n- Severity: **${byRef.severity}**\n- Status: **${byRef.status}**\n- Section: ${byRef.section_name || '—'}\n- Reported by: ${byRef.reported_by_name || '—'}\n- Location: ${byRef.latitude.toFixed(5)}, ${byRef.longitude.toFixed(5)}\n- Logged: ${byRef.created_at} UTC\n${byRef.notes ? '\n> ' + byRef.notes : ''}`,
      suggestions: ['How do I escalate an incident?', 'Show open incidents'],
    };
  }

  const wantsList    = LIST_WORDS.some((w) => text.includes(w));
  const wantsStats   = STAT_WORDS.some((w) => text.includes(w));
  const wantsHigh    = HIGH_WORDS.some((w) => text.includes(w));
  const wantsOpen    = OPEN_WORDS.some((w) => text.includes(w));
  const wantsToday   = TODAY_WORDS.some((w) => text.includes(w));
  const wantsAlerts  = has(text, 'alert', 'unread');

  // --- alerts ---
  if (wantsAlerts && ['section_ranger', 'ecologist', 'admin'].includes(user.role)) {
    const p = [];
    const { sql } = buildWhere(text, user, p);
    const rows = db.prepare(`
      SELECT a.message, a.is_read, a.created_at, i.reference
      FROM alerts a JOIN incidents i ON i.id = a.incident_id
      ${sql} ORDER BY a.created_at DESC LIMIT 10
    `).all(...p);
    if (!rows.length) return { reply: 'There are no alerts in your scope right now.', suggestions: ['How many incidents are open?'] };
    const unread = rows.filter((r) => !r.is_read).length;
    return {
      reply: `You have **${unread} unread** alert${unread === 1 ? '' : 's'} (showing latest ${rows.length}):\n\n` +
        rows.map((r) => `${r.is_read ? '•' : '⚠'} **${r.reference}** — ${r.message}`).join('\n'),
      suggestions: ['How do I escalate an incident?', 'How many incidents are open?'],
    };
  }

  // --- list of incidents ---
  if (wantsList && (wantsHigh || wantsOpen || wantsToday || has(text, 'incident', 'reports'))) {
    const p = [];
    const { sql, section } = buildWhere(text, user, p, {
      status: wantsOpen && !wantsHigh ? 'Open' : (has(text, 'resolved') ? 'Resolved' : undefined),
      severity: wantsHigh ? 'High' : undefined,
      today: wantsToday,
    });
    const rows = db.prepare(`
      SELECT i.reference, i.type, i.severity, i.status, i.section_name, i.created_at,
             u.full_name AS reported_by_name
      FROM incidents i
      LEFT JOIN users u ON u.id = i.reported_by
      LEFT JOIN sections s ON s.id = i.section_id
      ${sql} ORDER BY i.created_at DESC LIMIT 10
    `).all(...p);

    const label = [wantsHigh && 'high-severity', wantsOpen && 'open', wantsToday && "today's"]
      .filter(Boolean).join(' ') || 'matching';
    const where = section ? ` in **${section.name}**` : '';
    if (!rows.length) return { reply: `No ${label} incidents${where}.`, suggestions: ['How many incidents are open?'] };

    return {
      reply: `**${label.charAt(0).toUpperCase() + label.slice(1)} incidents**${where} — showing ${rows.length}:\n\n` +
        rows.map((r) => `• \`${r.reference}\` — **${r.type}** · ${r.severity} · ${r.status} · ${r.created_at} UTC`).join('\n'),
      suggestions: ['How many incidents are open?', 'Export a CSV'],
    };
  }

  // --- stats / counts ---
  if (wantsStats || wantsHigh || wantsOpen) {
    const p = [];
    const { sql, section } = buildWhere(text, user, p);
    const count = (extra, args) => db.prepare(`SELECT COUNT(*) AS n FROM incidents i ${sql} ${extra}`).get(...p, ...(args || [])).n;
    const where = section ? ` in **${section.name}**` : '';

    if (wantsHigh) {
      const n = count("AND i.severity = 'High'");
      const open = count("AND i.severity = 'High' AND i.status != 'Resolved'");
      return {
        reply: `There are **${n} high-severity incident${n === 1 ? '' : 's'}**${where} in total, **${open}** still unresolved.`,
        suggestions: ["Show today's high-severity incidents", 'How many incidents are open?'],
      };
    }
    if (wantsOpen) {
      const n = count("AND i.status = 'Open'");
      const esc = count("AND i.status = 'Escalated'");
      return {
        reply: `Open incidents${where}: **${n}**. Escalated: **${esc}**.`,
        suggestions: ['Show open incidents', 'How many high-severity incidents?'],
      };
    }
    const total = count('');
    const open  = count("AND i.status = 'Open'");
    const esc   = count("AND i.status = 'Escalated'");
    const res   = count("AND i.status = 'Resolved' AND i.updated_at >= datetime('now','start of month')");
    const high  = count("AND i.severity = 'High'");
    return {
      reply: `**Incident summary**${where}\n\n- Total: **${total}**\n- Open: **${open}**\n- Escalated: **${esc}**\n- Resolved (MTD): **${res}**\n- High severity: **${high}**`,
      suggestions: ['Show open incidents', 'Export a CSV'],
    };
  }

  return null;
}

// ---------- live triage ("score this ...") ----------
function maybeScore(text) {
  const m = /^(?:score|rate|triage|how severe(?: is)?|what severity(?: is)?)[:\s]+(.+)$/i.exec(text);
  if (!m) return null;
  const body = m[1];
  // Best-effort type detection from the description
  const typeGuess =
    /snare|wire/.test(body) ? 'Snare found' :
    /poach|gun|rifle|armed|horn|tusk|intruder/.test(body) ? 'Poaching activity' :
    /fence|breach|cut wire/.test(body) ? 'Fence breach' :
    /carcass|dead/.test(body) ? 'Carcass found' :
    /injur|wound|sick|limping/.test(body) ? 'Injured animal' :
    /sight|herd|elephant|rhino|lion/.test(body) ? 'Wildlife sighting' :
    /vehicle|car|truck/.test(body) ? 'Vehicle in restricted area' : 'Other';
  const r = triage(typeGuess, body);
  return {
    reply: `**Severity: ${r.severity}** (score ${r.score})\n\nAssumed type: *${typeGuess}*\n\n${r.reasons.length ? 'Why:\n' + r.reasons.map((x) => '• ' + x).join('\n') : 'No scoring keywords found.'}\n\n_On the real log screen the server assigns severity and a High result is auto-escalated._`,
    suggestions: ['What makes an incident High severity?', 'How do I log an incident?'],
  };
}

// ---------- endpoint ----------
router.post('/', (req, res) => {
  const message = String((req.body && req.body.message) || '').trim();
  if (!message) return res.status(400).json({ error: 'message is required' });
  if (message.length > 500) return res.status(400).json({ error: 'Message is too long (max 500 characters)' });

  const text = norm(message);
  const user = req.user;

  // 1. live triage scoring
  const scored = maybeScore(message);
  if (scored) return res.json(scored);

  // 2. live data questions
  let live = null;
  try { live = runLiveQuery(text, user); }
  catch (e) { /* fall through to knowledge base */ }
  if (live) return res.json(live);

  // 3. knowledge base
  const hit = KNOWLEDGE.find((k) => k.match(text));
  if (hit) return res.json({ reply: hit.reply, suggestions: hit.suggestions || HELP_SUGGESTIONS });

  // 4. graceful fallback
  return res.json({
    reply: `I'm not sure about that one. I can help with **logging incidents**, **severity rules**, the **offline queue**, **status changes**, **alerts**, **exports**, **roles**, and **security** — and I can answer live questions like *"how many incidents are open?"* or *"show today's high-severity incidents"*.`,
    suggestions: HELP_SUGGESTIONS,
  });
});

module.exports = router;