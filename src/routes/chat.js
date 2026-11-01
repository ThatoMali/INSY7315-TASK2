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

// The role always comes from req.user (set by the JWT middleware + DB lookup) — never from the request body.
const ROLE_PROFILES = {
  field_ranger: {
    label: 'Field Ranger',
    greeting: (n) => `Hi ${n} 👋 Field assistant here. I keep answers short and step-by-step so you can use them on patrol. Ask me how to log an incident, capture GPS, attach a photo, work offline, or what to do in an emergency.`,
    suggestions: ['How do I log an incident?', 'What do I do in an emergency?', 'How does the offline queue work?', 'Show my open reports'],
    fallback: `I didn't catch that. Try something short like **"log an incident"**, **"GPS"**, **"photo"**, **"offline"**, **"SOS"** or **"my reports"**.`,
    help: `**Quick help for the field**\n\n- **Log** an incident (GPS, photo, notes)\n- **Severity** — what counts as High\n- **Offline** — saving and syncing\n- **SOS** — calling 112 / 10111 / 10177 and alerting your section\n- **My reports** — "show my open reports"\n- **Fines** — "do I have any fines?"`,
  },
  section_ranger: {
    label: 'Section Ranger',
    greeting: (n) => `Hello ${n}. Section operations assistant here. I can pull the picture for your section, explain alerts and severity, and walk you through escalating, resolving or reopening incidents and exporting reports.`,
    suggestions: ["Show today's high-severity incidents", 'Show unread alerts', 'How do I escalate an incident?', 'How many incidents are open?'],
    fallback: `I'm not sure I follow. For your section I can show **open or high-severity incidents**, **unread alerts**, an **incident summary**, or explain **escalating / resolving**, **severity** and **exports**.`,
    help: `**Section coordination**\n\n- **Live picture** — open, escalated and high-severity incidents in your section\n- **Alerts** — "show unread alerts"\n- **Status changes** — escalate, resolve, reopen\n- **Severity** — how the server scores reports\n- **Exports** — CSV / PDF for your section\n- **Fines** — "show unpaid fines"`,
  },
  ecologist: {
    label: 'Regional Ecologist',
    greeting: (n) => `Hello ${n}. Analysis assistant here. I can summarise the incident data you're allowed to see across sections, break it down by type, and explain what the figures can and can't tell you. I only report what's recorded in FRIMS.`,
    suggestions: ['Give me an incident summary', 'Which incident types are most common?', 'How should I interpret these numbers?', 'How do I export data?'],
    fallback: `I can't match that. For analysis I can give an **incident summary**, a **breakdown by type**, counts **per section** (e.g. "high severity in Kruger North"), explain **how to read the numbers**, or cover **exports** and the **audit log**.`,
    help: `**Analysis help**\n\n- **Summary** — totals, open, escalated, resolved, high severity\n- **By type** — "which incident types are most common?"\n- **By section** — add a section name to any count\n- **Interpreting data** — what FRIMS figures do and don't show\n- **Exports & audit log**\n\nI only quote numbers stored in FRIMS and won't estimate anything beyond them.`,
  },
  admin: {
    label: 'System Administrator',
    greeting: (n) => `Hello ${n}. Administration assistant here. I can explain user management, roles and permissions, the audit trail, and how supported workflows behave. I never reveal passwords, tokens or other secrets.`,
    suggestions: ['How do I add a user?', 'How many users are there?', 'What does the audit log record?', 'What can each role do?'],
    fallback: `Not sure about that one. As an administrator you can ask about **adding or deactivating users**, **roles and permissions**, the **audit log**, **payments / fines**, or **why something isn't working** (e.g. "user can't log in"). I can't show secrets or configuration values.`,
    help: `**Administration help**\n\n- **Users** — add, edit, deactivate; "how many users are there?"\n- **Roles & permissions** — what each role can see and do\n- **Audit trail** — what is recorded and where to see it\n- **Troubleshooting** — login, sync, missing section, payments\n- **Limits** — I can't reveal secrets or change anything for you`,
  },
};
const profileFor = (user) => ROLE_PROFILES[user.role] || ROLE_PROFILES.field_ranger;

// Static suggestions that don't apply to a role are swapped for that role's defaults.
const NOT_FOR = {
  field_ranger: /escalat|export|csv|alert/i,
  ecologist: /escalat|resolve|reopen/i,
};
function suggestionsFor(user, list) {
  const bad = NOT_FOR[user.role];
  const kept = (list || []).filter((x) => !(bad && bad.test(x)));
  return kept.length ? kept : profileFor(user).suggestions;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^\w\s?]/g, ' ').replace(/\s+/g, ' ').trim();
const has = (text, ...words) => words.some((w) => text.includes(w));

// Simple typo tolerance: words close (edit distance) to a known FRIMS term are corrected.
const VOCAB = ['incident', 'incidents', 'severity', 'escalate', 'escalated', 'resolved', 'offline', 'export', 'alerts', 'alert',
  'reports', 'summary', 'statistics', 'emergency', 'payment', 'payments', 'audit', 'location', 'photo', 'coordinates',
  'permissions', 'password', 'unresolved', 'outstanding', 'section', 'users', 'poaching', 'snare'];
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function fixTypos(text) {
  return text.split(' ').map((w) => {
    if (w.length < 5 || VOCAB.includes(w)) return w;
    const max = w.length >= 8 ? 2 : 1;
    const hit = VOCAB.find((v) => Math.abs(v.length - w.length) <= max && lev(w, v) <= max);
    return hit || w;
  }).join(' ');
}

// ---------- static answers (the FRIMS knowledge base) ----------
const KNOWLEDGE = [
  {
    id: 'log_incident',
    match: (t) => has(t, 'how do i log', 'how to log', 'log an incident', 'report an incident', 'new incident', 'capture incident', 'submit report'),
    reply: `**Logging an incident (field ranger)**\n\n1. Open the **Log** tab.\n2. Pick the **Incident type**.\n3. Tap **📍 Locate** to capture GPS (or type "lat, lng").\n4. Attach a **photo** if you have one.\n5. Add **notes** — the AI severity tag updates as you type.\n6. Tap **SUBMIT**.\n\nIf you're offline, the report is saved on the device and syncs automatically when you reconnect. You can also force it from **Profile → Sync now**.`,
    suggestions: ['What makes an incident High severity?', 'How does the offline queue work?'],
    byRole: {
      ecologist: { reply: `Logging incidents is done by **Field Rangers and Section Rangers**. Your role is read-only on incidents: you can review them on the dashboard, filter by section, and export.`, suggestions: ['Give me an incident summary', 'How do I export data?'] },
      admin: { reply: `Only **Field Rangers and Section Rangers** can log incidents (admins manage users and review records). Rangers use the **Log** tab: type → Locate → photo → notes → Submit.`, suggestions: ['How do I add a user?', 'What can each role do?'] },
      field_ranger: { reply: `**Log an incident**\n\n1. **Log** tab → pick the **type**.\n2. Tap **📍 Locate** (or type "lat, lng").\n3. Add a **photo** if you can.\n4. Write short **notes** (what, where, fresh or old).\n5. **SUBMIT**.\n\nNo signal? It saves on your phone and syncs automatically. In danger? Use **SOS** first.`, suggestions: ['What do I do in an emergency?', 'What makes an incident High severity?'] },
    },
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
    byRole: {
      field_ranger: { reply: `You're signed in as a **Field Ranger**. You can log incidents (GPS, photo, offline), use SOS, view only **your own** reports and pay your fines. You can't see other rangers' reports, alerts or exports.`, suggestions: ['How do I log an incident?', 'What do I do in an emergency?'] },
      section_ranger: { reply: `You're signed in as a **Section Ranger**. You see **every incident in your section**, can log incidents, escalate / resolve / reopen, read alerts and export. You can't see other sections or manage users.`, suggestions: ['How do I escalate an incident?', 'Show unread alerts'] },
      ecologist: { reply: `You're signed in as a **Regional Ecologist**. You can view incidents across **all sections** (filterable), read alerts, view the audit log and export — but you can't log or change incidents.`, suggestions: ['Give me an incident summary', 'How do I export data?'] },
    },
  },
  {
    id: 'escalate',
    match: (t) => has(t, 'escalate', 'escalated', 'reopen', 'resolve', 'mark resolved', 'close incident'),
    reply: `**Managing incident status**\n\nSection rangers and admins can move an incident between **Open → Escalated → Resolved** (and reopen a resolved one).\n\n- **Escalate** — raises the profile and creates an alert for the section.\n- **Mark resolved** — closes it out (counts toward the MTD "Resolved" stat).\n- **Reopen** — sends a resolved incident back to *Open*.\n\nHigh-severity incidents are escalated automatically on creation. Every change is written to the audit trail.`,
    suggestions: ['What makes an incident High severity?', 'Show incidents by status'],
    byRole: {
      field_ranger: { reply: `Rangers can't change an incident's status. High-severity reports are **escalated automatically** and your Section Ranger is alerted. To follow up, tell your Section Ranger the reference (e.g. INC-0412).`, suggestions: ['Show my open reports', 'What makes an incident High severity?'] },
      ecologist: { reply: `Your role is read-only on incidents, so you can't escalate or resolve. You can see statuses and the audit trail. Section Rangers and administrators make status changes.`, suggestions: ['Give me an incident summary', 'What does the audit log record?'] },
      section_ranger: { reply: `**Coordinating incidents in your section**\n\n- Open an incident → **Escalate** (raises an alert), **Mark resolved**, or **Reopen** a resolved one.\n- Work High-severity and Escalated items first; they come with alerts.\n- Every change is recorded in the audit trail.\n- You can only act on incidents in **your** section.`, suggestions: ['Show unread alerts', "Show today's high-severity incidents"] },
    },
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
    byRole: {
      field_ranger: { reply: `Exports are for managers. You can review your own submissions under **My Reports**, including any still *Pending* upload.`, suggestions: ['Show my open reports', 'How does the offline queue work?'] },
      ecologist: { reply: `**Exporting for analysis**\n\nOn the dashboard use **Export CSV** (spreadsheet-ready, formula-safe) or **Export PDF** (print → Save as PDF). Pick a section in the filter first to export just that section. Exports contain incident records, not statistics — summarise with the dashboard figures or ask me for counts.`, suggestions: ['Give me an incident summary', 'Which incident types are most common?'] },
    },
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
    id: 'sos',
    match: (t) => has(t, 'sos', 'emergency', 'panic', 'in danger', 'ambulance', 'police', '10111', '10177', '112', 'urgent'),
    reply: `**Emergency / SOS**\n\n1. Tap **SOS — Report Emergency** on the Log screen.\n2. To get help now, tap **Call 112** (general), **Police 10111** or **Ambulance 10177**. Your phone's dialler opens — you still press call.\n3. Separately, tap **Log SOS incident** to record a High-severity incident and alert your section.\n\nLogging does **not** contact police or ambulance, and opening the dialler does **not** log anything. If you're offline, the log is saved and sent when you reconnect — call first.`,
    suggestions: ['How does the offline queue work?', 'How do I log an incident?'],
    byRole: {
      section_ranger: { reply: `**Emergency / SOS (section view)**\n\nWhen a ranger logs an SOS it appears as a **High-severity, Escalated** incident with an alert for your section. Check **High-Severity Alerts**, call the ranger and, if life is at risk, dial **112**, **10111** (police) or **10177** (ambulance) yourself — FRIMS does not contact external services.`, suggestions: ['Show unread alerts', "Show today's high-severity incidents"] },
      ecologist: { reply: `SOS is a field-ranger tool: it dials **112 / 10111 / 10177** through the phone and logs a High-severity incident. SOS incidents appear in your data like any other High-severity *Poaching activity* report.`, suggestions: ['Give me an incident summary'] },
      admin: { reply: `SOS is a field-ranger tool: it opens the phone dialler for **112 / 10111 / 10177** and separately logs a High-severity incident that alerts the ranger's section. FRIMS has no integration that contacts external emergency services.`, suggestions: ['What does the audit log record?'] },
    },
  },
  {
    id: 'payments',
    match: (t) => has(t, 'pay ', 'payment', 'fine', 'payfast', 'invoice', 'receipt', 'owe'),
    reply: `**Paying a fine**\n\n1. Open the incident (or tap **Pay Outstanding Fine** on the Log screen).\n2. Check the fine reference and amount — they come from the server.\n3. Tap **Pay with PayFast** and complete payment on PayFast's page.\n4. You'll return to FRIMS. The fine shows **Paid** only after PayFast confirms it; until then it shows *Awaiting confirmation*.\n\nIf you cancel, nothing is charged and the fine stays unpaid.`,
    suggestions: ['Do I have any fines?', 'How do I log an incident?'],
    byRole: {
      section_ranger: { reply: `**Fines (section view)**\n\nFines are attached to incidents and paid by the ranger through PayFast. You can see the fine status on an incident in your section (*Unpaid*, *Awaiting confirmation*, *Paid*). A fine is only marked paid after PayFast confirms the payment to the server.`, suggestions: ['Show unpaid fines', 'How many incidents are open?'] },
      ecologist: { reply: `Fines are attached to incidents and paid by rangers through PayFast. You can see their status on incidents you can view; payment handling isn't part of the ecologist role.`, suggestions: ['Give me an incident summary'] },
      admin: { reply: `**Payments (admin)**\n\nFines are paid through PayFast hosted checkout. A fine becomes **Paid** only when PayFast's notification passes signature, source, amount and server-confirmation checks. If payments don't start, the PayFast settings (merchant ID/key, public app URL) are probably not configured on the server — I can't show their values. Payment events are in the audit trail.`, suggestions: ['What does the audit log record?', 'What can each role do?'] },
    },
  },
  {
    id: 'audit',
    match: (t) => has(t, 'audit', 'history of changes', 'who changed', 'trail'),
    reply: `**Audit trail**\n\nEvery incident creation and status change is recorded with who did it and when, and you can see an incident's trail inside its detail view. The full audit log is available to administrators and regional ecologists.`,
    suggestions: ['How do I escalate an incident?'],
    byRole: {
      admin: { reply: `**Audit log (admin)**\n\nFRIMS records incident creation and status changes, user account changes and fine events (issued, checkout started, paid, failed). Open the **Audit** screen from the dashboard. Password material is never written to it.`, suggestions: ['How do I add a user?', 'What can each role do?'] },
      ecologist: { reply: `**Audit log**\n\nYou can open the **Audit** screen to see who created or changed records and when. It shows activity, not ecological findings.`, suggestions: ['Give me an incident summary'] },
    },
  },
  {
    id: 'users',
    match: (t) => has(t, 'add a user', 'new user', 'create user', 'create a user', 'deactivate', 'reset password', 'user management', 'manage users', "can't log in", 'cannot log in', 'locked out'),
    reply: `User management is done by a **System Administrator**. If you can't sign in or need access changed, ask your administrator.`,
    suggestions: ['What can a field ranger do?'],
    byRole: {
      admin: { reply: `**User management**\n\n- **Add** — Users → **Add user**: name, username, email, password (min 8 chars), role, section.\n- **Edit / reset password** — Users → Edit. Passwords are reset here.\n- **Deactivate** — set status to *Inactive*; it takes effect on their next request.\n- Field and Section Rangers **must have a section** to log incidents.\n\n*Can't log in?* Check status is *Active*, then reset the password.`, suggestions: ['How many users are there?', 'What can each role do?'] },
    },
  },
  {
    id: 'interpret',
    match: (t) => has(t, 'interpret', 'trend', 'what does this mean', 'what do the numbers', 'ecolog', 'conservation', 'population', 'read the numbers'),
    reply: `FRIMS records **incident reports**. Ask me for an incident summary or a breakdown by type for your scope.`,
    suggestions: ['How many incidents are open?'],
    byRole: {
      ecologist: { reply: `**Reading FRIMS figures**\n\n- Counts are **reports logged by rangers**, not wildlife surveys. They reflect patrol effort as well as real activity.\n- A **Carcass found** or **Snare found** is a record of a find; FRIMS doesn't record cause of death unless the notes say so.\n- **Wildlife sighting** counts are observations, not population estimates.\n- Severity is **rule-based** (type + keywords), not an ecological assessment.\n- Compare sections with care — patrol coverage differs.\n\nI can give counts and breakdowns from the data; I won't estimate anything FRIMS doesn't record.`, suggestions: ['Which incident types are most common?', 'Give me an incident summary'] },
    },
  },
  {
    id: 'greeting',
    match: (t) => /^(hi|hello|hey|good (morning|afternoon|evening)|howzit|molo)\b/.test(t) || has(t, 'hello', 'hi there'),
    reply: (u) => profileFor(u).greeting(u.full_name.split(' ')[0]),
    suggestions: null,
  },
  {
    id: 'thanks',
    match: (t) => has(t, 'thank', 'thanks', 'cheers', 'ta '),
    reply: `Happy to help. Anything else — logging, severity, exports, or your incident numbers?`,
    suggestions: null,
  },
  {
    id: 'help',
    match: (t) => has(t, 'help', 'what can you do', 'what can you help', 'commands', 'options'),
    reply: (u) => profileFor(u).help,
    suggestions: null,
  },
];

function knowledgeAnswer(k, user) {
  const v = (k.byRole && k.byRole[user.role]) || k;
  const reply = typeof v.reply === 'function' ? v.reply(user) : v.reply;
  return { reply, suggestions: suggestionsFor(user, v.suggestions || k.suggestions) };
}

// ---------- live-data intents (query the scoped DB) ----------
const STAT_WORDS   = ['how many', 'count', 'number of', 'how much', 'stats', 'statistics', 'summary', 'overview'];
const HIGH_WORDS   = ['high', 'severe', 'critical', 'escalated'];
const OPEN_WORDS   = ['open', 'outstanding', 'unresolved', 'active'];
const TODAY_WORDS  = ['today', 'last 24', '24 hours', 'this morning'];
const LIST_WORDS   = ['show', 'list', 'give me', 'which', 'what are', 'see'];

function sectionNames() {
  return getDb().prepare('SELECT id, name FROM sections ORDER BY name').all();
}

// Full name wins ("kruger south"); a bare first word only counts if it is unambiguous.
function namedSection(text) {
  const all = sectionNames();
  const full = all.find((x) => text.includes(x.name.toLowerCase()));
  if (full) return full;
  const byFirst = all.filter((x) => new RegExp('\\b' + x.name.toLowerCase().split(' ')[0] + '\\b').test(text));
  if (byFirst.length === 1) return byFirst[0];
  const m = /\bsection\s+(\d+)\b/.exec(text);
  return m ? (all.find((x) => x.id === Number(m[1])) || null) : null;
}

function resolveSection(text, user) {
  // Only ecologists/admins may target a section; rangers are pinned to their own scope by scopeSql.
  if (user.role === 'field_ranger' || user.role === 'section_ranger') return null;
  return namedSection(text);
}

// A ranger naming a section that isn't theirs is told so, instead of getting a misleading "0 incidents".
function otherSectionRefusal(text, user) {
  if (user.role !== 'field_ranger' && user.role !== 'section_ranger') return null;
  const sec = namedSection(text);
  if (!sec || sec.id === user.section_id) return null;
  return {
    reply: `I can't show **${sec.name}**. As a ${profileFor(user).label} you only have access to ${user.role === 'field_ranger' ? 'your own reports' : 'incidents in your own section'}. Regional ecologists and administrators can view other sections.`,
    suggestions: suggestionsFor(user, null),
  };
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

  // --- fines (scoped through the incident, same rules as the incident list) ---
  if (has(text, 'fine', 'owe', 'unpaid') && !has(text, 'define', 'refine')) {
    const p = [];
    const rows = db.prepare(`SELECT f.reference, f.amount_cents, f.status, i.reference AS incident_reference
      FROM fines f JOIN incidents i ON i.id = f.incident_id WHERE f.status != 'Cancelled'${scopeSql(user, p)} ORDER BY f.id DESC LIMIT 10`).all(...p);
    const unpaid = rows.filter((r) => r.status !== 'Paid');
    if (!rows.length) return { reply: 'There are no fines in your scope.', suggestions: suggestionsFor(user, ['How do I pay a fine?']) };
    return {
      reply: `**${unpaid.length} unpaid fine${unpaid.length === 1 ? '' : 's'}** (of ${rows.length} shown):\n\n` +
        rows.map((r) => `• \`${r.reference}\` — R ${(r.amount_cents / 100).toFixed(2)} · ${r.status === 'Pending' ? 'Awaiting confirmation' : r.status} · ${r.incident_reference}`).join('\n'),
      suggestions: suggestionsFor(user, ['How do I pay a fine?']),
    };
  }

  // --- user counts (administrators only) ---
  if (has(text, 'how many users', 'number of users', 'user count', 'list users', 'show users')) {
    if (user.role !== 'admin') return { reply: 'User numbers and lists are available to **System Administrators** only.', suggestions: suggestionsFor(user, null) };
    const rows = db.prepare("SELECT role, status, COUNT(*) AS n FROM users GROUP BY role, status").all();
    const total = rows.reduce((a, r) => a + r.n, 0);
    return {
      reply: `**${total} user accounts**\n\n` + rows.map((r) => `• ${(ROLE_PROFILES[r.role] || {}).label || r.role} (${r.status}): **${r.n}**`).join('\n'),
      suggestions: ['How do I add a user?', 'What can each role do?'],
    };
  }

  // --- breakdown by incident type (scoped) ---
  if (has(text, 'by type', 'most common', 'common type', 'types of incident', 'incident types', 'breakdown', 'which types')) {
    const p = [];
    const { sql, section } = buildWhere(text, user, p);
    const rows = db.prepare(`SELECT i.type, COUNT(*) AS n FROM incidents i ${sql} GROUP BY i.type ORDER BY n DESC`).all(...p);
    const where = section ? ` in **${section.name}**` : '';
    if (!rows.length) return { reply: `No incidents recorded${where}.`, suggestions: suggestionsFor(user, null) };
    return {
      reply: `**Incidents by type**${where}\n\n` + rows.map((r) => `• ${r.type}: **${r.n}**`).join('\n') +
        `\n\n_These are counts of logged reports, not population or wildlife measures._`,
      suggestions: suggestionsFor(user, ['Give me an incident summary', 'How do I export data?']),
    };
  }

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
      SELECT i.reference, i.type, i.severity, i.status, s.name AS section_name, i.created_at,
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

// ---------- guards ----------
const SECRET_RE = /(jwt|secret|api[ _-]?key|merchant[ _-]?(id|key)|passphrase|credential|\.env|env file|password hash|access token|private key)/i;
const ROLE_CLAIM_RE = /\b(i am|i'm|im|act as|pretend|switch (to|role)|make me|treat me as|my role is)\b.*\b(admin|administrator|ecologist|section ranger|field ranger|manager)\b/i;

// ---------- endpoint ----------
// Role-specific greeting + starter suggestions, from the authenticated user only.
router.get('/start', (req, res) => {
  const profile = profileFor(req.user);
  const first = String(req.user.full_name || '').split(' ')[0] || 'there';
  res.json({ role: req.user.role, label: profile.label, greeting: profile.greeting(first), suggestions: profile.suggestions });
});

router.post('/', (req, res) => {
  const message = String((req.body && req.body.message) || '').trim();
  if (!message) return res.status(400).json({ error: 'message is required' });
  if (message.length > 500) return res.status(400).json({ error: 'Message is too long (max 500 characters)' });

  const text = fixTypos(norm(message));
  const user = req.user;           // trusted server-side identity; any role/section in the body is ignored
  const profile = profileFor(user);

  // 1. live triage scoring
  const scored = maybeScore(message);
  if (scored) return res.json(scored);

  // 2. never reveal secrets or configuration values
  if (SECRET_RE.test(message)) {
    return res.json({ reply: `I can't share passwords, tokens, API or payment credentials, or other configuration secrets. ${user.role === 'admin' ? 'These are managed in the server environment settings, not in FRIMS.' : 'Please contact your System Administrator if you need access to something.'}`, suggestions: suggestionsFor(user, null) });
  }

  // 3. claims about a different role don't change what the user may see
  if (ROLE_CLAIM_RE.test(message)) {
    return res.json({ reply: `I answer based on the account you're signed in with — **${profile.label}** — and can't switch roles. If your access is wrong, ask a System Administrator to update your account.`, suggestions: suggestionsFor(user, null) });
  }

  // 4. other-section access attempts by rangers
  const refused = otherSectionRefusal(text, user);
  if (refused) return res.json(refused);

  // 5. live data questions (scoped)
  let live = null;
  try { live = runLiveQuery(text, user); }
  catch (e) { console.error('[chat]', e.message); }
  if (live) return res.json({ reply: live.reply, suggestions: suggestionsFor(user, live.suggestions) });

  // 6. knowledge base (role-aware)
  const hit = KNOWLEDGE.find((k) => k.match(text));
  if (hit) return res.json(knowledgeAnswer(hit, user));

  // 7. role-specific fallback
  return res.json({ reply: profile.fallback, suggestions: profile.suggestions });
});

module.exports = router;
