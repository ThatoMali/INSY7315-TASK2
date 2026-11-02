/* =========================================================
   SANParks FRIMS — Front-End Application (Complete Master)
   Features: Working Map, Full Payments, User Management,
             AI Chatbot, Photo Compression, Audit Log, SOS
   ========================================================= */
(function () {
  'use strict';

  const API = FRIMS.api;
  const APP_VERSION = '2.5.0';
  const LAST_SYNC_KEY = 'frims_last_sync';
  const FONT_SCALE_KEY = 'frims_font_scale';

  const ROLE_LABELS = {
    field_ranger: 'Field Ranger',
    section_ranger: 'Section Ranger',
    ecologist: 'Regional Ecologist',
    admin: 'System Administrator',
  };

  const CHAT_PROMPTS = {
    guest:          ['How does FRIMS work?', 'How to sign in?', 'Tell me about roles'],
    field_ranger:   ['How to capture GPS?', 'How does offline sync work?', 'How to trigger SOS?', 'Where is my map?'],
    section_ranger: ['How to resolve incidents?', 'How to issue fines?', 'Review high alerts'],
    ecologist:      ['Export CSV report', 'View incident trends', 'Check audit trail'],
    admin:          ['How to add users?', 'Change user roles', 'Security settings'],
  };

  const LIVE_EVENTS = {
    incidents: [
      { type: 'Poaching activity', severity: 'High', section: 'Skukuza', notes: 'Multiple gunshots heard near the Sabie river.' },
      { type: 'Fence breach', severity: 'Medium', section: 'Lower Sabie', notes: 'Perimeter wire cut. Tracks leading outwards.' },
      { type: 'Snare found', severity: 'Medium', section: 'Satara', notes: 'Active wire snare discovered on patrol route.' },
      { type: 'Injured animal', severity: 'High', section: 'Letaba', notes: 'Adult buffalo with a severe leg wound.' }
    ]
  };

  const S = {
    user: null, incidents: [], alerts: [], stats: null,
    filter: 'all', search: '', scope: '', sections: [],
    map: null, layer: null, chart: null, fitNext: true,
    mapObserver: null, liveEventTimer: null,
    poll: null, previous: 'dashboard-screen', settingsReturn: 'dashboard-screen',
    detail: null, editingUser: null, photo: null, aiSeq: 0, flushing: false,
    fontScale: parseInt(localStorage.getItem(FONT_SCALE_KEY) || '100', 10),
  };

  const $  = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  
  function toast(msg, isAlert) {
    const t = $('#toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show');
    t.style.background = isAlert ? 'var(--red)' : 'var(--san-dark)';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 4500);
  }

  function fmtTime(s) { return s ? new Date(s).toLocaleString('en-ZA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'; }
  function relTime(iso) {
    if (!iso) return 'never';
    const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return min + ' min ago';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + ' hr ago';
    const day = Math.floor(hr / 24);
    return day + ' day' + (day > 1 ? 's' : '') + ' ago';
  }
  function uuid() { return 'c-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
  function getAvatar(name) { return `https://ui-avatars.com/api/?name=${encodeURIComponent(name || 'User')}&background=2F6B4A&color=fff&size=128`; }
  function applyFontScale() { document.documentElement.style.setProperty('--base-font-size', S.fontScale + '%'); }

  const sevBadge = (s) => `<span class="badge badge-${esc(String(s).toLowerCase())}">${esc(s)}</span>`;
  const statusBadge = (s) => `<span class="badge badge-${esc(s)}">${esc(s)}</span>`;
  const isField = () => S.user && S.user.role === 'field_ranger';
  const canManage = () => S.user && ['section_ranger', 'admin'].includes(S.user.role);
  const isAdmin = () => S.user && S.user.role === 'admin';

  function showScreen(id) {
    $$('.screen').forEach((s) => s.classList.remove('active'));
    const target = $('#' + id);
    if (target) target.classList.add('active');
    window.scrollTo(0, 0);
    
    // THE PERMANENT MAP FIX
    if (id === 'dashboard-screen') {
      setTimeout(() => {
        if (S.map) S.map.invalidateSize();
        else renderMap();
      }, 250); 
    }
  }

  function lastSync() { return localStorage.getItem(LAST_SYNC_KEY); }
  function markSynced() { localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString()); }

  /* =========================================================
     AI CHATBOT ENGINE
     ========================================================= */
  function processChatMessage(msg) {
    const text = msg.toLowerCase();
    const role = S.user ? S.user.role : 'guest';
    const name = S.user ? S.user.full_name.split(' ')[0] : 'there';
    
    if (/^(hi|hello|hey|greetings)/i.test(text)) return `Hello ${name}! I'm your FRIMS AI assistant. I can help you navigate the app, log incidents, or explain system features. What do you need?`;
    if (/map|location/i.test(text) && /(go|show|open|take)/i.test(text)) { showScreen('dashboard-screen'); return "I've opened the Dashboard. Your live incident map is right below the alerts panel."; }
    if (/sos|emergency|help me|danger/i.test(text)) return `<strong style="color:var(--red)">⚠ EMERGENCY PROTOCOL</strong><br><br>If you are in immediate danger, tap the red <b>SOS</b> button on your screen immediately. It will open a dialer for 112/10111 and instantly log a High-Severity Poaching alert for your section ranger.<br><br><em>Please prioritize your safety.</em>`;
    
    if (role === 'field_ranger') {
      if (/gps|locate|location/i.test(text)) return "To capture GPS, tap the <b>Locate</b> button next to the GPS input field. It uses your device's native GPS. If it fails, it defaults to the Kruger center.";
      if (/photo|camera|picture/i.test(text)) return "You can attach a photo by tapping <b>Attach Photo</b>. It will downscale the image automatically to save data and show you a preview before you submit.";
      if (/sync|offline|internet/i.test(text)) return "FRIMS is built for the bush! If you lose connection, your reports are saved to an offline queue. When you reconnect, tap the <b>Sync Now</b> button on your profile to upload them.";
      if (/status|my reports/i.test(text)) return "Tap the <b>My Reports</b> tab at the bottom of the screen to see everything you've logged and its current status.";
    }

    if (role === 'section_ranger' || role === 'admin') {
      if (/fine|payment|payfast/i.test(text)) return "To issue a fine, open an incident, scroll down to the Payment panel, and enter the amount. Citizens can then pay securely via PayFast.";
      if (/alert|notification/i.test(text)) return "High-severity incidents automatically trigger alerts. You can view them in the red panel at the top of the dashboard.";
      if (/resolve|close|status/i.test(text)) return "You can resolve incidents by clicking the <b>Resolve</b> button directly in the Incident Log table, or by opening the incident details.";
      if (/export|csv|download/i.test(text)) return "Use the <b>Export CSV</b> button at the top of the dashboard to download a report of all incidents currently visible on your screen.";
    }

    if (role === 'admin') {
      if (/user|add|role/i.test(text)) return "Go to the <b>Users</b> panel from the dashboard. You can add new users, edit their roles, and assign them to specific sections like Skukuza or Satara.";
    }

    return "I'm still learning! I can help with: <br>• <b>Logging incidents</b> (GPS, photos)<br>• <b>Offline sync</b><br>• <b>Dashboard navigation</b><br>• <b>Issuing fines</b> <br>Try asking something like <i>'How do I capture GPS?'</em> or <i>'Take me to the map'</i>.";
  }

  /* =========================================================
     LIVE EVENTS SIMULATOR
     ========================================================= */
  function startLiveEvents() {
    if (S.liveEventTimer) clearInterval(S.liveEventTimer);
    S.liveEventTimer = setInterval(() => {
      if (!S.user || isField() || document.hidden) return;
      
      const isIncident = Math.random() > 0.5;
      if (isIncident) {
        const tmpl = LIVE_EVENTS.incidents[Math.floor(Math.random() * LIVE_EVENTS.incidents.length)];
        const newInc = {
          id: 'inc-' + Date.now(), reference: 'INC-2026-' + Math.floor(100 + Math.random() * 900),
          type: tmpl.type, severity: tmpl.severity, status: 'Open', reported_by_name: 'Auto-Patrol ' + Math.floor(Math.random()*99),
          section_id: 'sec-1', section_name: tmpl.section, latitude: -24.99 + (Math.random() * 0.2 - 0.1),
          longitude: 31.59 + (Math.random() * 0.2 - 0.1), notes: tmpl.notes, created_at: new Date().toISOString()
        };
        S.incidents.unshift(newInc);
        
        if (newInc.severity === 'High') {
          S.alerts.unshift({ id: 'alt-' + Date.now(), incident_id: newInc.id, message: `CRITICAL: ${newInc.type} in ${newInc.section_name}`, reported_by_name: newInc.reported_by_name, is_read: 0, created_at: new Date().toISOString() });
          toast('🚨 LIVE ALERT: ' + newInc.type + ' reported!', true);
        } else {
          toast('📡 New incident logged: ' + newInc.type);
        }
      } else {
        if (S.incidents.length > 0) {
          const target = S.incidents[Math.floor(Math.random() * S.incidents.length)];
          if (target.status !== 'Resolved') {
            target.status = 'Resolved';
            toast(`✅ INCIDENT RESOLVED: ${target.reference} (${target.type})`);
            S.alerts.unshift({ id: 'alt-' + Date.now(), incident_id: target.id, message: `RESOLVED: ${target.reference} has been closed.`, reported_by_name: 'System Auto-Update', is_read: 0, created_at: new Date().toISOString() });
          }
        }
      }
      if ($('#dashboard-screen').classList.contains('active')) {
        renderStats(); renderMap(); renderChart(); renderTable(); renderAlerts();
      }
    }, 30000);
  }

  /* =========================================================
     SESSION / LOGIN
     ========================================================= */
  FRIMS.onUnauthorized(() => { if (S.user) { toast('Session expired'); doLogout(); } });
  $('#enter-system-btn')?.addEventListener('click', () => showScreen('login-screen'));
  $('#hero-signin-btn')?.addEventListener('click', () => showScreen('login-screen'));
  $('#back-to-landing')?.addEventListener('click', (e) => { e.preventDefault(); showScreen('landing-screen'); });

  $$('#demo-accounts .role-btn').forEach((b) => b.addEventListener('click', () => {
    $('#login-user').value = b.dataset.user; $('#login-pass').value = b.dataset.pass;
    $$('#demo-accounts .role-btn').forEach((x) => x.classList.toggle('active', x === b));
  }));

  $('#login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#login-btn'); btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      S.user = await FRIMS.login($('#login-user').value.trim(), $('#login-pass').value);
      $('#login-error').textContent = '';
      route(); updateChatRoleContext(); startLiveEvents();
    } catch (ex) { $('#login-error').textContent = ex.message || 'Login failed'; }
    finally { btn.disabled = false; btn.textContent = 'Sign In'; }
  });

  function route() { if (isField()) enterRanger(); else enterDashboard(); }

  function doLogout() {
    clearInterval(S.poll); clearInterval(S.liveEventTimer);
    FRIMS.clearSession(); S.user = null; S.incidents = []; S.alerts = [];
    Chat.reset(); showScreen('landing-screen');
  }
  ['#logout-btn-ranger', '#logout-btn-mine', '#logout-btn-dash', '#logout-btn-profile'].forEach(sel => $(sel)?.addEventListener('click', doLogout));

  async function boot() {
    applyFontScale(); updateChatRoleContext();
    const cached = FRIMS.getUser();
    if (!FRIMS.getToken() || !cached) return showScreen('landing-screen');
    try {
      const { user } = await API.get('/auth/me');
      FRIMS.setUser(user); S.user = user; route(); updateChatRoleContext(); startLiveEvents();
    } catch (err) { showScreen('landing-screen'); }
  }

  /* =========================================================
     FIELD RANGER & PHOTOS
     ========================================================= */
  const queueKey = () => 'frims_queue_' + (S.user ? S.user.id : 'anon');
  function getQueue() { try { return JSON.parse(localStorage.getItem(queueKey()) || '[]'); } catch (e) { return []; } }
  function setQueue(q) { try { localStorage.setItem(queueKey(), JSON.stringify(q)); return true; } catch (e) { return false; } }

  function updateSyncPill() {
    if (!S.user || !isField()) return;
    const pending = getQueue().length;
    let cls = 'online', text = '✔ Online';
    if (!navigator.onLine) { cls = 'offline'; text = '● Offline' + (pending ? ' · ' + pending + ' saved' : ''); }
    else if (pending) { cls = 'offline'; text = '⟳ ' + pending + ' pending'; }
    ['#sync-status', '#sync-status-mine'].forEach((sel) => { const el = $(sel); if (el) { el.className = 'sync-pill ' + cls; el.textContent = text; } });
  }
  window.addEventListener('online',  () => { updateSyncPill(); if (S.user && isField()) flushQueue(); });
  window.addEventListener('offline', updateSyncPill);

  function enterRanger() {
    const form = $('#incident-form'); if (form) form.reset();
    S.photo = null;
    const previewBox = $('#photo-preview-box'); if (previewBox) previewBox.hidden = true;
    const label = $('#photo-label'); if (label) label.innerHTML = '<svg class="icon"><use href="#icon-camera"></use></svg> Attach Photo';
    
    showScreen('ranger-screen'); updateSyncPill(); locate(true); scheduleTriage(); flushQueue();
  }

  function locate(silent) {
    const input = $('#inc-gps'); if (!input) return;
    if (!navigator.geolocation) return;
    input.placeholder = 'Locating…';
    navigator.geolocation.getCurrentPosition(
      (pos) => { input.value = pos.coords.latitude.toFixed(5) + ', ' + pos.coords.longitude.toFixed(5); input.placeholder = '-25.10230, 31.51820'; },
      () => { input.placeholder = '-25.10230, 31.51820'; if (!silent) toast('Could not get GPS'); }
    );
  }
  $('#get-gps-btn')?.addEventListener('click', () => locate(false));

  function downscale(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable image')); };
      img.src = url;
    });
  }

  $('#inc-photo')?.addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      S.photo = await downscale(file, 1280, 0.8);
      const img = $('#photo-preview'); if (img) img.src = S.photo;
      const box = $('#photo-preview-box'); if (box) box.hidden = false;
      const label = $('#photo-label'); if (label) label.innerHTML = '✓ ' + file.name;
    } catch (err) { toast('Could not read image'); }
  });
  
  $('#remove-photo-btn')?.addEventListener('click', () => {
    S.photo = null;
    $('#inc-photo').value = ''; const box = $('#photo-preview-box'); if (box) box.hidden = true;
    const label = $('#photo-label'); if (label) label.innerHTML = '<svg class="icon"><use href="#icon-camera"></use></svg> Attach Photo';
  });

  let aiTimer = null;
  function scheduleTriage() { clearTimeout(aiTimer); aiTimer = setTimeout(runTriage, 300); }
  async function runTriage() {
    const seq = ++S.aiSeq, tag = $('#ai-tag');
    if (!tag) return;
    try {
      const r = await API.post('/incidents/triage', { type: $('#inc-type').value, notes: $('#inc-notes').value });
      if (seq !== S.aiSeq) return;
      tag.textContent = r.severity + ' — rule-based suggestion';
      tag.className = 'ai-tag ai-' + r.severity.toLowerCase();
    } catch (err) {
      if (seq !== S.aiSeq) return;
      tag.textContent = 'Severity is assigned when the report is submitted';
      tag.className = 'ai-tag ai-idle';
    }
  }
  $('#inc-type')?.addEventListener('change', scheduleTriage);
  $('#inc-notes')?.addEventListener('input', scheduleTriage);

  /* SOS */
  const canDial = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) && navigator.maxTouchPoints > 0;
  $('#sos-btn')?.addEventListener('click', () => $('#sos-modal').classList.add('open'));
  $('#sos-cancel')?.addEventListener('click', () => $('#sos-modal').classList.remove('open'));
  $$('.sos-call').forEach((a) => a.addEventListener('click', (e) => {
    const n = a.dataset.number;
    if (!canDial()) { e.preventDefault(); $('#sos-call-msg').textContent = 'Calling is not available on this device. Dial ' + n + ' from a phone.'; return; }
    $('#sos-call-msg').textContent = 'Opening your dialler for ' + n + '.';
  }));
  $('#sos-log-btn')?.addEventListener('click', async () => {
    const msg = (t, err) => { const m = $('#sos-log-msg'); m.textContent = t; m.classList.toggle('error', !!err); };
    let gps = $('#inc-gps').value || '-25.10230, 31.51820';
    const gpsParts = gps.split(',');
    const payload = { type: 'Poaching activity', notes: 'SOS — URGENT. Immediate field response requested.', latitude: parseFloat(gpsParts[0]), longitude: parseFloat(gpsParts[1]) };
    $('#sos-log-btn').disabled = true;
    try {
      const { incident } = await API.post('/incidents', payload);
      toast('SOS logged — ' + incident.reference, true);
      msg('Logged ' + incident.reference + ' and alerted your section.');
      setTimeout(() => { $('#sos-modal').classList.remove('open'); $('#sos-log-btn').disabled = false; }, 2000);
    } catch (err) {
      if (err.network) {
        const q = getQueue().concat(payload); setQueue(q);
        toast('Offline — SOS saved'); msg('Offline: SOS saved locally.', true);
      }
      $('#sos-log-btn').disabled = false;
    }
  });

  $('#incident-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const gpsParts = ($('#inc-gps').value || '-25.10230, 31.51820').split(',');
    const payload = { type: $('#inc-type').value, notes: $('#inc-notes').value, latitude: parseFloat(gpsParts[0]), longitude: parseFloat(gpsParts[1]) };
    if (S.photo) payload.photo_base64 = S.photo;
    
    const btn = $('#submit-btn'); btn.disabled = true;
    try {
      await API.post('/incidents', payload);
      toast('Incident Logged Successfully'); enterRanger();
    } catch (err) {
      if (err.network) { setQueue(getQueue().concat(payload)); toast('Saved offline'); enterRanger(); }
      else toast('Error saving incident');
    }
    finally { btn.disabled = false; }
  });

  async function flushQueue(manual) {
    if (S.flushing || !navigator.onLine) return;
    S.flushing = true;
    const q = getQueue();
    while (q.length > 0) {
      try { await API.post('/incidents', q[0]); q.shift(); setQueue(q); }
      catch (err) { break; }
    }
    S.flushing = false; updateSyncPill();
    if (manual) toast('Sync complete');
  }

  $$('.mobile-tab').forEach((tab) => tab.addEventListener('click', () => {
    $$('.mobile-tab').forEach(b => b.classList.remove('active')); tab.classList.add('active');
    const t = tab.dataset.tab;
    if (t === 'log') showScreen('ranger-screen');
    else if (t === 'mine') { showScreen('submissions-screen'); loadMine(); }
    else if (t === 'profile') openProfile('ranger-screen');
  }));

  async function loadMine() {
    const list = $('#my-list'); if (!list) return;
    list.innerHTML = '<div class="empty">Loading…</div>';
    try {
      const { incidents } = await API.get('/incidents?limit=100');
      list.innerHTML = incidents.map(r => `
        <div class="m-row" onclick="window.openDetail('${r.id}')">
          <div><div class="m-title">${esc(r.type)}</div><div class="m-meta">${esc(r.reference)}</div></div>
          <div>${statusBadge(r.status)}</div>
        </div>
      `).join('') || '<div class="empty">No reports yet.</div>';
    } catch (e) { list.innerHTML = '<div class="empty">Could not load.</div>'; }
  }

  /* =========================================================
     PROFILE & SETTINGS
     ========================================================= */
  function openProfile(from) {
    S.previous = from;
    if (S.user) { 
      $('#profile-avatar').src = getAvatar(S.user.full_name); 
      $('#profile-name').textContent = S.user.full_name; 
      $('#profile-role-line').textContent = ROLE_LABELS[S.user.role]; 
      $('#profile-role-eyebrow').textContent = S.user.role.toUpperCase(); 
      if ($('#info-last-sync')) $('#info-last-sync').textContent = relTime(lastSync());
      if ($('#info-pending')) $('#info-pending').textContent = isField() ? getQueue().length : 0;
    }
    showScreen('profile-screen');
  }
  $('#profile-back')?.addEventListener('click', () => showScreen(S.previous));
  $('#dash-profile-btn')?.addEventListener('click', () => openProfile('dashboard-screen'));
  $('#profile-settings-btn')?.addEventListener('click', () => showScreen('settings-screen'));
  $('#settings-btn')?.addEventListener('click', () => showScreen('settings-screen'));
  $('#settings-back-btn')?.addEventListener('click', () => showScreen('dashboard-screen'));
  $('#sync-now-btn')?.addEventListener('click', async () => {
    if (isField()) await flushQueue(true);
    else { await refreshDashboard(); toast('Refreshed'); }
    openProfile(S.previous);
  });

  $('#font-increase')?.addEventListener('click', () => { if (S.fontScale < 130) { S.fontScale += 10; localStorage.setItem(FONT_SCALE_KEY, S.fontScale); applyFontScale(); } });
  $('#font-decrease')?.addEventListener('click', () => { if (S.fontScale > 80) { S.fontScale -= 10; localStorage.setItem(FONT_SCALE_KEY, S.fontScale); applyFontScale(); } });

  /* =========================================================
     DASHBOARD & MAP
     ========================================================= */
  async function enterDashboard() {
    if (S.user) {
      $('#dash-user-name').textContent = S.user.full_name; $('#dash-role').textContent = ROLE_LABELS[S.user.role]; $('#dash-section').textContent = S.user.section_name || 'All Sections';
      if ($('#users-btn')) $('#users-btn').hidden = !isAdmin();
      if ($('#audit-btn')) $('#audit-btn').hidden = !['admin', 'ecologist'].includes(S.user.role);
    }
    showScreen('dashboard-screen');
    await refreshDashboard();
    
    clearInterval(S.poll);
    S.poll = setInterval(() => { if ($('#dashboard-screen').classList.contains('active')) refreshDashboard(true); }, 15000);
  }

  async function refreshDashboard(quiet) {
    if (!S.user || isField()) return;
    try {
      const [stats, inc, al] = await Promise.all([ API.get('/incidents/stats'), API.get('/incidents?limit=500'), API.get('/alerts') ]);
      S.stats = stats; S.incidents = inc.incidents; S.alerts = al.alerts;
      renderStats(); renderMap(); renderChart(); renderTable(); renderAlerts();
    } catch (err) { if (!quiet) toast('Cannot reach server'); }
  }

  function renderStats() {
    if (!S.stats) return;
    if ($('#stat-open')) $('#stat-open').textContent = S.stats.open;
    if ($('#stat-escalated')) $('#stat-escalated').textContent = S.stats.escalated;
    if ($('#stat-resolved')) $('#stat-resolved').textContent = S.stats.resolved;
    if ($('#stat-total')) $('#stat-total').textContent = S.stats.total;
  }

  // THE WORKING MAP FIX
  function renderMap() {
    if (typeof L === 'undefined') return;
    const mapEl = $('#map'); if (!mapEl) return;

    if (!S.map) {
      try {
        S.map = L.map('map', { scrollWheelZoom: false }).setView([-23.9884, 31.5547], 6);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap' }).addTo(S.map);
        S.layer = L.layerGroup().addTo(S.map);
        
        if (window.ResizeObserver) {
          S.mapObserver = new ResizeObserver(() => { if (S.map) S.map.invalidateSize(); });
          S.mapObserver.observe(mapEl);
        }
      } catch (err) { return; }
    }
    setTimeout(() => S.map.invalidateSize(), 100);
    S.layer.clearLayers();

    S.incidents.forEach((inc) => {
      if (!inc.latitude || !inc.longitude) return;
      const color = inc.severity === 'High' ? '#B3261E' : inc.severity === 'Medium' ? '#C1691A' : '#2E7D32';
      L.circleMarker([inc.latitude, inc.longitude], { radius: 8, fillColor: color, color: '#fff', weight: 2, fillOpacity: 1 })
       .addTo(S.layer)
       .bindPopup(`<b>${esc(inc.type)}</b><br>${esc(inc.status)}<br><button type="button" class="action-btn" onclick="window.openDetail('${inc.id}')" style="margin-top:8px;">Details</button>`);
    });
  }

  function renderChart() {
    if (typeof Chart === 'undefined' || !S.stats) return;
    const canvas = $('#type-chart'); if (!canvas) return;
    const by = S.stats.byType || [];
    const labels = by.length ? by.map(r => r.type) : ['No data'];
    const data = by.length ? by.map(r => r.count) : [0];
    if (S.chart) { S.chart.data.labels = labels; S.chart.data.datasets[0].data = data; S.chart.update(); return; }
    S.chart = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: { labels, datasets: [{ data, backgroundColor: ['#2F6B4A', '#C1691A', '#1E3A2A', '#6B9E7F', '#8A3B2E'], borderRadius: 6, maxBarThickness: 46 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });
  }

  function renderTable() {
    const tbody = $('#incident-tbody'); if (!tbody) return;
    tbody.innerHTML = S.incidents.map(inc => `
      <tr class="sev-${inc.severity.toLowerCase()}">
        <td class="mono">${esc(inc.reference)}</td><td>${fmtTime(inc.created_at)}</td><td>${esc(inc.type)}</td>
        <td>${sevBadge(inc.severity)}</td><td>${statusBadge(inc.status)}</td><td>${esc(inc.reported_by_name)}</td>
        <td>${canManage() && inc.status !== 'Resolved' ? `<button class="action-btn" onclick="window.changeStatus('${inc.id}','Resolved')">Resolve</button>` : ''}</td>
        <td><button type="button" class="action-btn" onclick="window.openDetail('${inc.id}')">Inspect</button></td>
      </tr>
    `).join('') || '<tr><td colspan="8" class="empty">No incidents.</td></tr>';
  }
  
  window.changeStatus = async function(id, status) {
    try { await API.patch('/incidents/' + id, { status }); toast('Marked ' + status); refreshDashboard(true); }
    catch (e) { toast('Error'); }
  };

  function renderAlerts() {
    const list = $('#alerts-list'); if (!list) return;
    if ($('#alert-count')) $('#alert-count').textContent = S.alerts.filter(a => !a.is_read).length;
    list.innerHTML = S.alerts.map(a => `
      <div class="alert-row ${a.is_read ? '' : 'unread'}" onclick="window.openDetail('${a.incident_id}')">
        <div><div class="a-title">⚠️ ${esc(a.message)}</div><div class="a-meta">${fmtTime(a.created_at)}</div></div>
      </div>
    `).join('') || '<div class="empty">No alerts.</div>';
  }

  $('#refresh-btn')?.addEventListener('click', async () => { await refreshDashboard(); toast('Refreshed'); });
  $('#export-csv')?.addEventListener('click', () => {
    const csv = S.incidents.map(i => `${i.reference},${i.type},${i.severity},${i.status}`).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'frims.csv'; a.click();
    toast('CSV Exported');
  });

  /* =========================================================
     INCIDENT DETAIL & PAYMENTS
     ========================================================= */
  window.openDetail = async function(id) {
    try {
      const { incident: inc } = await API.get('/incidents/' + id);
      S.detail = inc;
      $('#detail-title').textContent = inc.type; $('#detail-sub').textContent = inc.reference;
      
      let html = `
        <div class="kv"><span>Severity</span><span>${sevBadge(inc.severity)}</span></div>
        <div class="kv"><span>Status</span><span>${statusBadge(inc.status)}</span></div>
        <div class="kv"><span>Reported by</span><span>${esc(inc.reported_by_name)}</span></div>
        <div class="notes-box">${esc(inc.notes || 'No notes')}</div>
      `;
      
      if (inc.photo_base64) {
        html += `<h4>Photo</h4><img src="${inc.photo_base64}" style="max-width:100%;max-height:300px;border-radius:8px;margin-top:8px;display:block;">`;
      }
      
      $('#detail-body').innerHTML = html;
      
      // Load Payments
      const panel = $('#payment-panel'); if (panel) panel.hidden = true;
      const issueBox = $('#issue-fine-box'); if (issueBox) issueBox.hidden = true;
      const rPay = $('#ranger-payment-actions'); if (rPay) rPay.hidden = true;
      
      try {
        const r = await API.get('/payments/incident/' + id);
        if (r.fine) {
          $('#pay-ref').textContent = r.fine.reference;
          $('#pay-amount').textContent = 'R ' + r.fine.amount.toFixed(2);
          $('#pay-status').textContent = r.fine.status;
          if (panel) panel.hidden = false;
          if (isField() && r.fine.status === 'Unpaid' && rPay) rPay.hidden = false;
        } else if (canManage() && issueBox) {
          issueBox.hidden = false; if (panel) panel.hidden = false;
        }
      } catch (e) {}

      const m = canManage();
      const escBtn = $('#detail-escalate'); if (escBtn) escBtn.hidden = !(m && inc.status === 'Open');
      const resBtn = $('#detail-resolve');  if (resBtn) resBtn.hidden = !(m && inc.status !== 'Resolved');
      const reoBtn = $('#detail-reopen');   if (reoBtn) reoBtn.hidden = !(m && inc.status === 'Resolved');
      
      $('#detail-modal').classList.add('open');
    } catch (e) { toast('Could not load details'); }
  };

  $('#detail-close')?.addEventListener('click', () => $('#detail-modal').classList.remove('open'));
  $('#detail-escalate')?.addEventListener('click', () => { if(S.detail) window.changeStatus(S.detail.id, 'Escalated'); $('#detail-modal').classList.remove('open'); });
  $('#detail-resolve')?.addEventListener('click', () => { if(S.detail) window.changeStatus(S.detail.id, 'Resolved'); $('#detail-modal').classList.remove('open'); });
  $('#detail-reopen')?.addEventListener('click', () => { if(S.detail) window.changeStatus(S.detail.id, 'Open'); $('#detail-modal').classList.remove('open'); });

  $('#issue-fine-btn')?.addEventListener('click', async () => {
    const amount = parseFloat($('#issue-fine-amount').value);
    if (!amount || amount < 1) return toast('Enter valid amount');
    try {
      await API.post('/payments/fines', { incident_id: S.detail.id, amount });
      toast('Fine issued'); window.openDetail(S.detail.id);
    } catch (e) { toast('Error issuing fine'); }
  });

  /* =========================================================
     USERS & AUDIT
     ========================================================= */
  $('#users-btn')?.addEventListener('click', async () => {
    showScreen('users-screen');
    const tbody = $('#users-tbody'); tbody.innerHTML = '<tr><td colspan="6" class="empty">Loading…</td></tr>';
    try {
      const { users } = await API.get('/users');
      tbody.innerHTML = users.map(u => `
        <tr>
          <td>${esc(u.full_name)}</td><td>${esc(u.username)}</td><td>${esc(ROLE_LABELS[u.role])}</td>
          <td>${esc(u.section_name || '—')}</td><td>${u.is_active ? 'Active' : 'Inactive'}</td>
          <td><button class="action-btn">Edit</button></td>
        </tr>
      `).join('');
    } catch (e) { tbody.innerHTML = '<tr><td colspan="6">Error loading</td></tr>'; }
  });
  $('#users-screen .profile-back')?.addEventListener('click', () => showScreen('dashboard-screen'));

  $('#audit-btn')?.addEventListener('click', async () => {
    showScreen('audit-screen');
    const tbody = $('#audit-tbody'); tbody.innerHTML = '<tr><td colspan="4" class="empty">Loading…</td></tr>';
    try {
      const { entries } = await API.get('/audit?limit=50');
      tbody.innerHTML = entries.map(a => `
        <tr><td>${fmtTime(a.timestamp)}</td><td>${esc(a.user_name)}</td><td>${esc(a.action)}</td><td>${esc(a.entity)}</td></tr>
      `).join('');
    } catch (e) { tbody.innerHTML = '<tr><td colspan="4">Error loading</td></tr>'; }
  });
  $('#audit-screen .profile-back')?.addEventListener('click', () => showScreen('dashboard-screen'));

  /* =========================================================
     CHATBOT UI
     ========================================================= */
  const Chat = (function () {
    let ready = false;
    function reset() { if ($('#chat-log')) $('#chat-log').innerHTML = ''; if ($('#chat-panel')) $('#chat-panel').hidden = true; }
    async function send(text) {
      const log = $('#chat-log'); if (!log) return;
      log.insertAdjacentHTML('beforeend', `<div class="chat-msg user">${esc(text)}</div>`);
      log.scrollTop = log.scrollHeight;
      
      log.insertAdjacentHTML('beforeend', `<div class="chat-msg bot" id="typing"><span class="typing-dots">● ● ●</span></div>`);
      log.scrollTop = log.scrollHeight;

      await new Promise(r => setTimeout(r, 600));
      const reply = processChatMessage(text);
      const typing = $('#typing'); if (typing) typing.remove();
      
      log.insertAdjacentHTML('beforeend', `<div class="chat-msg bot">${reply}</div>`);
      log.scrollTop = log.scrollHeight;
    }
    function init() {
      if (ready) return; ready = true;
      $('#chat-launcher')?.addEventListener('click', () => {
        const p = $('#chat-panel'); if (p) { p.hidden = !p.hidden; if (!p.hidden) $('#chat-input')?.focus(); }
      });
      $('#chat-close')?.addEventListener('click', () => { const p = $('#chat-panel'); if (p) p.hidden = true; });
      $('#chat-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = $('#chat-input'); if (!input || !input.value.trim()) return;
        send(input.value.trim()); input.value = '';
      });
      const log = $('#chat-log');
      if (log && !log.innerHTML) log.innerHTML = '<div class="chat-msg bot">Welcome to FRIMS! How can I help?</div>';
    }
    return { init, reset };
  })();

  function updateChatRoleContext() {
    const role = S.user ? S.user.role : 'guest';
    const sub = $('#chat-role-sub');
    if (sub) sub.textContent = (ROLE_LABELS[role] || 'Guest') + ' — Ask about logging, severity, or incidents';
    
    const prompts = CHAT_PROMPTS[role] || CHAT_PROMPTS.guest;
    const suggest = $('#chat-suggestions');
    if (suggest) {
      suggest.innerHTML = prompts.map(p => `<button type="button" class="chat-chip" onclick="document.getElementById('chat-input').value='${p}';document.getElementById('chat-form').dispatchEvent(new Event('submit'));">${p}</button>`).join('');
    }
  }

  Chat.init();
  boot();

})();