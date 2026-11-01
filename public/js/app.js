/* =========================================================
   SANParks FRIMS — front-end (Refactored)
   ========================================================= */
(function () {
  'use strict';

  const API = FRIMS.api;
  const APP_VERSION = '2.0.0';
  const LAST_SYNC_KEY = 'frims_last_sync';
  const FONT_SCALE_KEY = 'frims_font_scale';

  const ROLE_LABELS = {
    field_ranger: 'Field Ranger',
    section_ranger: 'Section Ranger',
    ecologist: 'Regional Ecologist',
    admin: 'System Administrator',
  };

  const S = {
    user: null, incidents: [], alerts: [], stats: null,
    filter: 'all', search: '', scope: '', sections: [],
    map: null, layer: null, chart: null, fitNext: true,
    poll: null, previous: 'dashboard-screen', settingsReturn: 'dashboard-screen',
    detail: null, editingUser: null, photo: null, aiSeq: 0, flushing: false,
    fontScale: parseInt(localStorage.getItem(FONT_SCALE_KEY) || '100', 10),
    language: 'en',
  };

  // ---------- Helpers ----------
  const $  = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(msg) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 3500);
  }

  function parseDate(s) {
    if (!s) return null;
    return new Date(/[TZ]/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  }
  function fmtTime(s) {
    const d = parseDate(s);
    return d ? d.toLocaleString('en-ZA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  }
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
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'c-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  
  function getAvatar(name) {
    const seed = encodeURIComponent(name || 'User');
    return `https://ui-avatars.com/api/?name=${seed}&background=2F6B4A&color=fff&size=128&font-size=0.4`;
  }

  function applyFontScale() {
    document.documentElement.style.setProperty('--base-font-size', S.fontScale + '%');
    const el = $('#font-size-label');
    if (el) el.textContent = S.fontScale + '%';
  }

  const sevBadge = (s) => `<span class="badge badge-${esc(String(s).toLowerCase())}">${esc(s)}</span>`;
  const statusBadge = (s) => `<span class="badge badge-${esc(s)}">${esc(s)}</span>`;

  const isField   = () => S.user && S.user.role === 'field_ranger';
  const canManage = () => S.user && ['section_ranger', 'admin'].includes(S.user.role);
  const isAdmin   = () => S.user && S.user.role === 'admin';

  function showScreen(id) {
    $$('.screen').forEach((s) => s.classList.remove('active'));
    const target = $('#' + id);
    if (target) target.classList.add('active');
    window.scrollTo(0, 0);
    if (id === 'dashboard-screen' && S.map) setTimeout(() => S.map.invalidateSize(), 50);
  }

  function lastSync() { return localStorage.getItem(LAST_SYNC_KEY); }
  function markSynced() { localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString()); }

  // =========================================================
  // SESSION / LOGIN
  // =========================================================
  FRIMS.onUnauthorized(() => {
    if (!S.user) return;
    toast('Session expired — please sign in again');
    doLogout();
  });

  ['#enter-system-btn', '#hero-signin-btn'].forEach((sel) => {
    const el = $(sel);
    if (el) el.addEventListener('click', () => showScreen('login-screen'));
  });
  
  const backLanding = $('#back-to-landing');
  if (backLanding) backLanding.addEventListener('click', (e) => { e.preventDefault(); showScreen('landing-screen'); });

  $$('#demo-accounts .role-btn').forEach((b) => b.addEventListener('click', () => {
    $('#login-user').value = b.dataset.user;
    $('#login-pass').value = b.dataset.pass;
    $$('#demo-accounts .role-btn').forEach((x) => x.classList.toggle('active', x === b));
  }));

  const loginForm = $('#login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#login-error'), btn = $('#login-btn');
      err.textContent = '';
      btn.disabled = true; btn.textContent = 'Signing in…';
      try {
        S.user = await FRIMS.login($('#login-user').value.trim(), $('#login-pass').value);
        markSynced();
        $('#login-pass').value = '';
        route();
      } catch (ex) {
        err.textContent = ex.network ? 'Cannot reach the server. Check your connection.' : ex.message;
      } finally {
        btn.disabled = false; btn.textContent = 'Sign In';
      }
    });
  }

  function route() {
    if (isField()) enterRanger(); else enterDashboard();
  }

  function doLogout() {
    clearInterval(S.poll); S.poll = null;
    FRIMS.clearSession();
    S.user = null; S.scope = ''; S.filter = 'all'; S.search = '';
    S.incidents = []; S.alerts = []; S.stats = null; S.fitNext = true;
    closeModals();
    Chat.reset();
    const searchInput = $('#incident-search');
    if (searchInput) searchInput.value = '';
    $$('.filter-btn').forEach((b) => b.classList.toggle('active', b.dataset.filter === 'all'));
    const scopeSelect = $('#scope-select');
    if (scopeSelect) scopeSelect.hidden = true;
    resetIncidentForm(); 
    const formMsg = $('#form-msg');
    if (formMsg) formMsg.textContent = '';
    showScreen('landing-screen');
  }

  $$('#logout-btn-ranger, #logout-btn-mine, #logout-btn-dash, #logout-btn-profile').forEach((b) => {
    if (b) b.addEventListener('click', doLogout);
  });

  async function boot() {
    applyFontScale();
    const cached = FRIMS.getUser();
    if (!FRIMS.getToken() || !cached) return showScreen('landing-screen');
    try {
      const { user } = await API.get('/auth/me');
      FRIMS.setUser(user); S.user = user; route(); handlePaymentReturn();
    } catch (err) {
      if (err.network) { S.user = cached; route(); toast('Offline — using saved session'); }
      else showScreen('landing-screen');
    }
  }

  // =========================================================
  // FIELD RANGER
  // =========================================================
  const queueKey = () => 'frims_queue_' + S.user.id;
  function getQueue() { try { return JSON.parse(localStorage.getItem(queueKey()) || '[]'); } catch (e) { return []; } }
  function setQueue(q) { try { localStorage.setItem(queueKey(), JSON.stringify(q)); return true; } catch (e) { return false; } }

  function updateSyncPill() {
    if (!S.user || !isField()) return;
    const pending = getQueue().length;
    let cls = 'online', text = '✔ Online';
    if (!navigator.onLine) { cls = 'offline'; text = '● Offline' + (pending ? ' · ' + pending + ' saved' : ''); }
    else if (pending) { cls = 'offline'; text = '⟳ ' + pending + ' pending'; }
    ['#sync-status', '#sync-status-mine'].forEach((sel) => { 
      const el = $(sel); 
      if (el) { el.className = 'sync-pill ' + cls; el.textContent = text; }
    });
  }

  window.addEventListener('online',  () => { updateSyncPill(); if (S.user && isField()) flushQueue(); });
  window.addEventListener('offline', updateSyncPill);

  function enterRanger() {
    resetIncidentForm();
    const msg = $('#form-msg');
    if (msg) msg.textContent = '';
    showScreen('ranger-screen');
    updateSyncPill();
    locate(true);
    scheduleTriage();
    flushQueue();
  }

  function resetIncidentForm() {
    const form = $('#incident-form');
    if (form) form.reset();
    S.photo = null;
    const photoLabel = $('#photo-label');
    if (photoLabel) photoLabel.innerHTML = '<svg class="icon"><use href="#icon-camera"></use></svg> Attach Photo';
    const gps = $('#inc-gps');
    if (gps) gps.value = '';
    const tag = $('#ai-tag'); 
    if (tag) { tag.textContent = 'Awaiting input…'; tag.className = 'ai-tag ai-idle'; }
  }

  function parseGPS(str) {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(str || '');
    if (!m) return null;
    const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
  }
  
  function locate(silent) {
    const input = $('#inc-gps');
    if (!input) return;
    if (!navigator.geolocation) { if (!silent) toast('GPS not available'); return; }
    input.placeholder = 'Locating…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        input.value = pos.coords.latitude.toFixed(5) + ', ' + pos.coords.longitude.toFixed(5);
        input.placeholder = '-25.10230, 31.51820';
        if (!silent) toast('GPS location captured');
      },
      () => {
        input.placeholder = '-25.10230, 31.51820';
        if (!silent) toast('Could not get GPS');
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  }
  
  const gpsBtn = $('#get-gps-btn');
  if (gpsBtn) gpsBtn.addEventListener('click', () => locate(false));

  function downscale(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable image')); };
      img.src = url;
    });
  }

  const incPhoto = $('#inc-photo');
  if (incPhoto) {
    incPhoto.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        S.photo = await downscale(file, 1280, 0.8);
        $('#photo-label').innerHTML = '<svg class="icon"><use href="#icon-camera"></use></svg> ' + file.name + ' ✓';
      } catch (err) {
        S.photo = null;
        $('#photo-label').innerHTML = '<svg class="icon"><use href="#icon-camera"></use></svg> Attach Photo';
        toast('Could not read that image');
      }
    });
  }

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

  const incType = $('#inc-type');
  const incNotes = $('#inc-notes');
  if (incType) incType.addEventListener('change', scheduleTriage);
  if (incNotes) incNotes.addEventListener('input', scheduleTriage);

  function setMsg(text, isError) {
    const m = $('#form-msg'); 
    if (!m) return;
    m.textContent = text; m.classList.toggle('error', !!isError);
  }

  // SOS logic
  const canDial = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) && navigator.maxTouchPoints > 0;
  let sosClientId = null;
  const sosBtnHtml = '<svg class="icon"><use href="#icon-sos"></use></svg> SOS — Report Emergency';

  const sosBtn = $('#sos-btn');
  if (sosBtn) {
    sosBtn.addEventListener('click', () => {
      sosClientId = uuid();
      const msg = $('#sos-log-msg');
      if (msg) { msg.textContent = ''; msg.classList.remove('error'); }
      const logBtn = $('#sos-log-btn');
      if (logBtn) logBtn.disabled = false;
      const callMsg = $('#sos-call-msg');
      if (callMsg) callMsg.textContent = 'Calling depends on your device, browser and operating system. If nothing opens, dial the number manually.';
      $('#sos-modal').classList.add('open');
    });
  }

  const sosCancel = $('#sos-cancel');
  if (sosCancel) sosCancel.addEventListener('click', () => $('#sos-modal').classList.remove('open'));

  $$('.sos-call').forEach((a) => a.addEventListener('click', (e) => {
    const n = a.dataset.number;
    if (!canDial()) {
      e.preventDefault();
      $('#sos-call-msg').textContent = 'Calling is not available on this device. Dial ' + n + ' from a phone.';
      return;
    }
    $('#sos-call-msg').textContent = 'Opening your dialler for ' + n + '. Press call to connect — FRIMS cannot confirm that a call was made.';
  }));

  const sosLogBtn = $('#sos-log-btn');
  if (sosLogBtn) {
    sosLogBtn.addEventListener('click', async () => {
      const msg = (t, err) => { const m = $('#sos-log-msg'); m.textContent = t; m.classList.toggle('error', !!err); };
      let gps = parseGPS($('#inc-gps').value);
      if (!gps && navigator.geolocation) {
        try {
          const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 8000 }));
          gps = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        } catch { /* fall through */ }
      }
      if (!gps) { msg('Logging needs a GPS location — tap Locate first. You can still call using the buttons above.', true); return; }

      const payload = {
        type: 'Poaching activity',
        notes: 'SOS — URGENT. Immediate field response requested.',
        latitude: gps.lat, longitude: gps.lng,
        client_id: sosClientId || uuid(), captured_at: new Date().toISOString(),
      };
      $('#sos-log-btn').disabled = true;
      try {
        const { incident } = await API.post('/incidents', payload);
        toast('SOS logged — ' + incident.reference + ' (' + incident.severity + ')');
        msg('Logged ' + incident.reference + ' (' + incident.severity + ') and alerted your section. Police/ambulance have NOT been contacted by FRIMS — use the call buttons.');
        setMsg('SOS logged: ' + incident.reference + ' — ' + incident.severity + ' severity');
        $('#sos-btn').innerHTML = '<svg class="icon"><use href="#icon-sos"></use></svg> SOS sent — ' + incident.reference;
        setTimeout(() => { $('#sos-btn').innerHTML = sosBtnHtml; }, 5000);
      } catch (err) {
        if (err.network) {
          const q = getQueue().concat(payload);
          if (setQueue(q)) { toast('Offline — SOS saved'); updateSyncPill(); msg('Offline: SOS saved on this device and will be logged when you reconnect. Not sent yet — call now using the buttons above.', true); }
          else { toast('Storage full — SOS not saved'); msg('Storage full — SOS not saved. Call now.', true); $('#sos-log-btn').disabled = false; }
        } else if (err.status !== 401) {
          msg('SOS logging failed: ' + err.message, true); $('#sos-log-btn').disabled = false;
        }
      }
    });
  }

  const incidentForm = $('#incident-form');
  if (incidentForm) {
    incidentForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const gps = parseGPS($('#inc-gps').value);
      if (!gps) return setMsg('Capture GPS first', true);

      const payload = {
        type: $('#inc-type').value,
        notes: $('#inc-notes').value.trim(),
        latitude: gps.lat, longitude: gps.lng,
        client_id: uuid(), captured_at: new Date().toISOString(),
      };
      if (S.photo) payload.photo_base64 = S.photo;

      const btn = $('#submit-btn');
      btn.disabled = true; setMsg('Submitting…');
      try {
        const { incident } = await API.post('/incidents', payload);
        markSynced();
        setMsg(incident.reference + ' logged — ' + incident.severity + ' severity ✓');
        toast('Incident logged (' + incident.severity + ' severity)');
        resetIncidentForm(); locate(true);
        updateSyncPill();
        if (getQueue().length) flushQueue();
      } catch (err) {
        if (err.network) {
          if (setQueue(getQueue().concat(payload))) {
            setMsg('No connection — saved locally.');
            toast('Saved offline');
            resetIncidentForm(); locate(true);
            updateSyncPill();
          } else setMsg('Device storage is full.', true);
        } else if (err.status !== 401) setMsg(err.message, true);
      } finally {
        btn.disabled = false;
      }
    });
  }

  async function flushQueue(manual) {
    if (S.flushing || !S.user || !isField()) return { sent: 0, left: 0 };
    S.flushing = true;
    let sent = 0, dropped = 0;
    try {
      const q = getQueue();
      while (q.length && navigator.onLine) {
        try { await API.post('/incidents', q[0]); sent++; }
        catch (err) {
          const retryable = err.network || err.status === 401 || err.status === 429 || err.status >= 500;
          if (retryable) break;
          dropped++;
        }
        q.shift(); setQueue(q);
      }
      if (sent) markSynced();
    } finally { S.flushing = false; }
    updateSyncPill();
    const left = getQueue().length;
    if (manual || sent || dropped) {
      if (sent) toast(sent + ' report(s) synced ✓');
      else if (dropped) toast(dropped + ' report(s) rejected');
      else if (left) toast('Still offline — ' + left + ' waiting');
      else toast('Up to date ✓');
    }
  }

  async function loadMine() {
    const list = $('#my-list');
    if (!list) return;
    list.innerHTML = '<div class="empty">Loading…</div>';
    let rows = [], failed = false;
    try { rows = (await API.get('/incidents?limit=100')).incidents; } catch (e) { failed = true; }

    const pending = getQueue().map((p) => `
      <div class="m-row" data-pending="1">
        <div><div class="m-title">${esc(p.type)}</div>
        <div class="m-meta">Waiting to sync · ${esc(fmtTime(p.captured_at))}</div></div>
        <span class="badge badge-Pending">Pending</span>
      </div>`).join('');

    const sent = rows.map((r) => `
      <div class="m-row" data-id="${r.id}">
        <div><div class="m-title">${esc(r.type)}</div>
        <div class="m-meta"><span class="mono">${esc(r.reference)}</span> · ${esc(fmtTime(r.created_at))}</div></div>
        <div>${statusBadge(r.status)}</div>
      </div>`).join('');

    let html = pending + sent;
    if (failed) html = '<div class="empty">Could not load reports.</div>' + pending;
    else if (!html) html = '<div class="empty">No reports yet.</div>';
    list.innerHTML = html;
  }

  const myList = $('#my-list');
  if (myList) {
    myList.addEventListener('click', (e) => {
      const row = e.target.closest('.m-row[data-id]');
      if (row) openDetail(row.dataset.id);
    });
  }

  $$('.mobile-tab').forEach((tab) => tab.addEventListener('click', () => {
    const t = tab.dataset.tab;
    if (t === 'log') { showScreen('ranger-screen'); updateSyncPill(); }
    else if (t === 'mine') { showScreen('submissions-screen'); updateSyncPill(); loadMine(); }
    else if (t === 'profile') openProfile($('#submissions-screen').classList.contains('active') ? 'submissions-screen' : 'ranger-screen');
  }));

  // =========================================================
  // PROFILE
  // =========================================================
  function openProfile(from) {
    S.previous = from;
    renderProfile();
    showScreen('profile-screen');
  }

  function renderProfile() {
    const u = S.user;
    if (!u) return;
    
    const avatar = $('#profile-avatar');
    if (avatar) avatar.src = getAvatar(u.full_name);
    
    const roleEyebrow = $('#profile-role-eyebrow');
    if (roleEyebrow) roleEyebrow.textContent = (ROLE_LABELS[u.role] || u.role).toUpperCase();
    
    const name = $('#profile-name');
    if (name) name.textContent = u.full_name;
    
    const roleLine = $('#profile-role-line');
    if (roleLine) roleLine.textContent = (ROLE_LABELS[u.role] || u.role) + (u.section_name ? ' · ' + u.section_name : '');
    
    const id = $('#profile-id');
    if (id) id.textContent = 'Username: ' + u.username;
    
    const ver = $('#info-app-version');
    if (ver) ver.textContent = APP_VERSION;
    
    const sync = $('#info-last-sync');
    if (sync) sync.textContent = relTime(lastSync());
    
    const pending = $('#info-pending');
    if (pending) pending.textContent = isField() ? getQueue().length : 0;
    
    const syncBtn = $('#sync-now-btn');
    if (syncBtn) syncBtn.innerHTML = '<span class="sync-icon">🔄</span> ' + (isField() ? 'Sync now' : 'Refresh data');
  }

  const profileBack = $('#profile-back');
  if (profileBack) {
    profileBack.addEventListener('click', () => {
      showScreen(S.previous);
      if (S.previous === 'submissions-screen') loadMine();
    });
  }

  const dashProfileBtn = $('#dash-profile-btn');
  if (dashProfileBtn) dashProfileBtn.addEventListener('click', () => openProfile('dashboard-screen'));

  const syncNowBtn = $('#sync-now-btn');
  if (syncNowBtn) {
    syncNowBtn.addEventListener('click', async () => {
      const btn = $('#sync-now-btn');
      if (btn.disabled) return;
      btn.disabled = true; btn.classList.add('spinning');
      const syncInfo = $('#info-last-sync');
      if (syncInfo) syncInfo.textContent = 'Syncing…';
      try {
        if (isField()) await flushQueue(true);
        else { await refreshDashboard(); toast('Data refreshed ✓'); }
      } finally {
        btn.disabled = false; btn.classList.remove('spinning');
        renderProfile();
      }
    });
  }

  // =========================================================
  // DASHBOARD & LIVE POLLING
  // =========================================================
  async function enterDashboard() {
    const u = S.user;
    const name = $('#dash-user-name');
    if (name) name.textContent = u.full_name;
    
    const role = $('#dash-role');
    if (role) role.textContent = ROLE_LABELS[u.role];
    
    const usersBtn = $('#users-btn');
    if (usersBtn) usersBtn.hidden = !isAdmin();
    
    const auditBtn = $('#audit-btn');
    if (auditBtn) auditBtn.hidden = !['admin', 'ecologist'].includes(u.role);
    
    const readall = $('#alerts-readall');
    if (readall) readall.hidden = false;
    
    const dashSection = $('#dash-section');
    if (dashSection) dashSection.textContent = u.section_name || 'All sections';

    showScreen('dashboard-screen');
    S.fitNext = true;

    const sel = $('#scope-select');
    if (sel) {
      if (!u.section_id) {
        try {
          S.sections = (await API.get('/users/sections')).sections;
          sel.innerHTML = '<option value="">All sections</option>' + S.sections.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
          sel.value = S.scope; sel.hidden = false;
        } catch (e) { /* non-fatal */ }
      } else sel.hidden = true;
    }

    await refreshDashboard();
    clearInterval(S.poll);
    
    // LIVE POLLING EVERY 15 SECONDS
    S.poll = setInterval(() => {
      if ($('#dashboard-screen').classList.contains('active') && !document.hidden && !document.querySelector('.modal-backdrop.open')) {
        refreshDashboard(true);
      }
    }, 15000);
  }

  const scopeQS = (prefix) => (S.scope ? prefix + 'section_id=' + encodeURIComponent(S.scope) : '');

  async function refreshDashboard(quiet) {
    if (!S.user || isField()) return;
    try {
      const [stats, inc, al] = await Promise.all([
        API.get('/incidents/stats' + scopeQS('?')),
        API.get('/incidents?limit=500' + scopeQS('&')),
        API.get('/alerts' + scopeQS('?')),
      ]);
      
      // LIVE NOTIFICATION CHECK
      if (S.incidents.length > 0 && inc.incidents.length > 0) {
        const oldIds = new Set(S.incidents.map(i => i.id));
        const newIncidents = inc.incidents.filter(i => !oldIds.has(i.id));
        
        if (newIncidents.length > 0) {
          const newest = newIncidents[0];
          if (quiet) {
            toast('🚨 LIVE ALERT: New ' + newest.severity + ' severity ' + newest.type + ' logged!');
          }
        }
      }

      S.stats = stats; S.incidents = inc.incidents; S.alerts = al.alerts;
      markSynced();
      renderStats(); renderMap(); renderChart(); renderTable(); renderAlerts();
    } catch (err) {
      if (!quiet && err.status !== 401) toast(err.network ? 'Cannot reach server' : err.message);
    }
  }

  const refreshBtn = $('#refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => { await refreshDashboard(); toast('Refreshed'); });
  }

  const scopeSelect = $('#scope-select');
  if (scopeSelect) {
    scopeSelect.addEventListener('change', (e) => {
      S.scope = e.target.value;
      S.fitNext = true;
      const opt = e.target.options[e.target.selectedIndex];
      $('#dash-section').textContent = S.scope ? opt.textContent : 'All sections';
      refreshDashboard();
    });
  }

  function renderStats() {
    if (!S.stats) return;
    const open = $('#stat-open'); if (open) open.textContent = S.stats.open;
    const esc = $('#stat-escalated'); if (esc) esc.textContent = S.stats.escalated;
    const res = $('#stat-resolved'); if (res) res.textContent = S.stats.resolved;
    const total = $('#stat-total'); if (total) total.textContent = S.stats.total;
  }

  const SEV_COLOR = { High: '#B3261E', Medium: '#C1691A', Low: '#2E7D32' };

  function renderMap() {
    if (typeof L === 'undefined') return;
    if (!S.map) {
      const mapEl = $('#map');
      if (!mapEl) return;
      S.map = L.map('map', { scrollWheelZoom: false }).setView([-23.9884, 31.5547], 6);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 18 }).addTo(S.map);
      L.rectangle([[-25.7, 31.2], [-22.3, 32.0]], { color: '#2F6B4A', weight: 2, fill: false, dashArray: '4 4' }).addTo(S.map).bindPopup('Kruger National Park');
      S.layer = L.layerGroup().addTo(S.map);
      S.map.on('popupopen', (e) => {
        const b = e.popup.getElement().querySelector('[data-open]');
        if (b) b.onclick = () => { S.map.closePopup(); openDetail(b.dataset.open); };
      });
    }
    S.map.invalidateSize();
    S.layer.clearLayers();
    const pts = [];
    S.incidents.forEach((inc) => {
      const ll = [inc.latitude, inc.longitude];
      pts.push(ll);
      L.circleMarker(ll, { radius: 8, color: '#fff', weight: 2, fillColor: SEV_COLOR[inc.severity] || '#666', fillOpacity: 1 }).addTo(S.layer).bindPopup(
        `<strong>${esc(inc.type)}</strong><br>Severity: <b>${esc(inc.severity)}</b><br>Status: ${esc(inc.status)}<br>By: ${esc(inc.reported_by_name || '—')}<br><button type="button" class="action-btn" data-open="${inc.id}">Details</button>`
      );
    });
    if (S.fitNext && pts.length) { S.map.fitBounds(pts, { padding: [40, 40], maxZoom: 10 }); S.fitNext = false; }
  }

  function renderChart() {
    if (typeof Chart === 'undefined' || !S.stats) return;
    const canvas = $('#type-chart');
    if (!canvas) return;
    
    const by = S.stats.byType || [];
    const labels = by.length ? by.map((r) => r.type) : ['No data'];
    const data = by.length ? by.map((r) => r.count) : [0];
    if (S.chart) { S.chart.data.labels = labels; S.chart.data.datasets[0].data = data; S.chart.update(); return; }
    S.chart = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: { labels, datasets: [{ data, backgroundColor: ['#2F6B4A', '#C1691A', '#1E3A2A', '#6B9E7F', '#8A3B2E', '#B58500', '#5A8A6A', '#3D7A8A'], borderRadius: 6, maxBarThickness: 46 }] },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 }, grid: { color: '#EEF2EE' } }, x: { grid: { display: false } } } }
    });
  }

  function renderTable() {
    const tbody = $('#incident-tbody');
    if (!tbody) return;
    const q = S.search.toLowerCase();
    const rows = S.incidents.filter((i) => (S.filter === 'all' || i.status === S.filter) && (!q || [i.reference, i.type, i.notes, i.reported_by_name].some((v) => String(v || '').toLowerCase().includes(q))));
    
    if (!rows.length) { tbody.innerHTML = '<tr><td colspan="8" class="empty">No incidents.</td></tr>'; return; }
    
    tbody.innerHTML = rows.map((inc) => `
      <tr class="clickable sev-${(inc.severity || '').toLowerCase()}" data-id="${inc.id}">
        <td class="mono">${esc(inc.reference)}</td><td>${esc(fmtTime(inc.created_at))}</td><td>${esc(inc.type)}</td>
        <td>${sevBadge(inc.severity)}</td><td>${statusBadge(inc.status)}</td>
        <td><img src="${getAvatar(inc.reported_by_name)}" class="avatar-sm" alt="Avatar" /> ${esc(inc.reported_by_name || '—')}</td>
        <td class="mono">${inc.latitude.toFixed(3)}, ${inc.longitude.toFixed(3)}</td>
        <td>${canManage() && inc.status !== 'Resolved' ? `<button type="button" class="action-btn" data-resolve="${inc.id}">Resolve</button>` : ''}</td>
      </tr>`).join('');
  }

  const incidentTbody = $('#incident-tbody');
  if (incidentTbody) {
    incidentTbody.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-resolve]');
      if (btn) { e.stopPropagation(); return changeStatus(btn.dataset.resolve, 'Resolved'); }
      const tr = e.target.closest('tr[data-id]');
      if (tr) openDetail(tr.dataset.id);
    });
  }

  $$('.filter-btn').forEach((btn) => btn.addEventListener('click', () => {
    $$('.filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    S.filter = btn.dataset.filter; renderTable();
  }));

  const searchInp = $('#incident-search');
  if (searchInp) {
    searchInp.addEventListener('input', (e) => { S.search = e.target.value.trim(); renderTable(); });
  }

  async function changeStatus(id, status) {
    try {
      await API.patch('/incidents/' + id, { status });
      toast('Incident marked ' + status);
      await refreshDashboard(true);
      if ($('#detail-modal').classList.contains('open')) openDetail(id);
    } catch (err) { if (err.status !== 401) toast(err.message); }
  }

  function renderAlerts() {
    const unread = S.alerts.filter((a) => !a.is_read).length;
    const pill = $('#alert-count');
    if (pill) { pill.textContent = unread; pill.classList.toggle('zero', unread === 0); }
    
    const readall = $('#alerts-readall');
    if (readall) readall.hidden = unread === 0;
    
    const list = $('#alerts-list');
    if (!list) return;
    if (!S.alerts.length) { list.innerHTML = '<div class="empty">No alerts.</div>'; return; }
    
    list.innerHTML = S.alerts.slice(0, 6).map((a) => `
      <div class="alert-row${a.is_read ? '' : ' unread'}" data-alert="${a.id}" data-incident="${a.incident_id}">
        <div>
          <div class="a-title">⚠ ${esc(a.message)}</div>
          <div class="a-meta">Reported by ${esc(a.reported_by_name || '—')} · ${esc(fmtTime(a.created_at))}</div>
        </div>
        <span class="${a.is_read ? 'a-meta' : 'a-badge-new'}">${a.is_read ? 'Read' : 'New'}</span>
      </div>`).join('');
  }

  const alertsList = $('#alerts-list');
  if (alertsList) {
    alertsList.addEventListener('click', async (e) => {
      const row = e.target.closest('.alert-row');
      if (!row) return;
      if (row.classList.contains('unread')) {
        try { await API.patch('/alerts/' + row.dataset.alert + '/read'); } catch (err) { /* ignore */ }
        const a = S.alerts.find((x) => String(x.id) === row.dataset.alert);
        if (a) a.is_read = 1;
        renderAlerts();
      }
      openDetail(row.dataset.incident);
    });
  }

  const alertsReadAll = $('#alerts-readall');
  if (alertsReadAll) {
    alertsReadAll.addEventListener('click', async () => {
      try {
        await API.patch('/alerts/read-all' + scopeQS('?'));
        S.alerts.forEach((a) => { a.is_read = 1; });
        renderAlerts();
      } catch (err) { if (err.status !== 401) toast(err.message); }
    });
  }

  const exportCsv = $('#export-csv');
  if (exportCsv) {
    exportCsv.addEventListener('click', async () => {
      try { await API.download('/reports/incidents.csv' + scopeQS('?'), 'frims_incidents.csv'); toast('CSV exported'); }
      catch (err) { if (err.status !== 401) toast(err.message); }
    });
  }

  const exportPdf = $('#export-pdf');
  if (exportPdf) {
    exportPdf.addEventListener('click', () => { toast('Choose "Save as PDF"'); setTimeout(() => window.print(), 400); });
  }

  // =========================================================
  // SETTINGS
  // =========================================================
  const settingsBtn = $('#settings-btn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      S.settingsReturn = 'dashboard-screen';
      showScreen('settings-screen');
    });
  }

  const profileSettingsBtn = $('#profile-settings-btn');
  if (profileSettingsBtn) {
    profileSettingsBtn.addEventListener('click', () => {
      S.settingsReturn = 'profile-screen';
      showScreen('settings-screen');
    });
  }

  const settingsBackBtn = $('#settings-back-btn');
  if (settingsBackBtn) {
    settingsBackBtn.addEventListener('click', () => {
      showScreen(S.settingsReturn);
    });
  }

  // Text Scaling
  const fontInc = $('#font-increase');
  if (fontInc) {
    fontInc.addEventListener('click', () => {
      if (S.fontScale < 140) {
        S.fontScale += 10;
        localStorage.setItem(FONT_SCALE_KEY, S.fontScale);
        applyFontScale();
      }
    });
  }

  const fontDec = $('#font-decrease');
  if (fontDec) {
    fontDec.addEventListener('click', () => {
      if (S.fontScale > 80) {
        S.fontScale -= 10;
        localStorage.setItem(FONT_SCALE_KEY, S.fontScale);
        applyFontScale();
      }
    });
  }

  // Change Password
  const changePassForm = $('#change-password-form');
  if (changePassForm) {
    changePassForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const current = $('#current-pass').value;
      const newPass = $('#new-pass').value;
      if (!current || !newPass) return toast('Please fill in all fields');
      if (newPass.length < 8) return toast('New password must be at least 8 characters');
      
      const btn = changePassForm.querySelector('button[type="submit"]');
      const oldText = btn.textContent;
      btn.disabled = true; btn.textContent = 'Updating...';

      try {
        await API.post('/auth/change-password', { current_password: current, new_password: newPass });
        toast('Password updated successfully');
        changePassForm.reset();
      } catch (err) {
        toast(err.message || 'Failed to update password');
      } finally {
        btn.disabled = false; btn.textContent = oldText;
      }
    });
  }

  // =========================================================
  // INCIDENT DETAIL MODAL & PAYMENTS
  // =========================================================
  const kv = (k, v) => `<div class="kv"><span>${esc(k)}</span><span>${v}</span></div>`;

  async function openDetail(id) {
    try {
      const { incident: inc } = await API.get('/incidents/' + id);
      S.detail = inc;
      
      const title = $('#detail-title'); if (title) title.textContent = inc.type;
      const sub = $('#detail-sub'); if (sub) sub.textContent = inc.reference;
      
      const lat = inc.latitude.toFixed(5), lng = inc.longitude.toFixed(5);
      
      let html =
        kv('Severity', sevBadge(inc.severity)) +
        kv('Status', statusBadge(inc.status)) +
        kv('Reported by', `<img src="${getAvatar(inc.reported_by_name)}" class="avatar-sm" style="margin-right:6px;"> ${esc(inc.reported_by_name || '—')}`) +
        kv('Section', esc(inc.section_name || '—')) +
        kv('Reported at', esc(fmtTime(inc.created_at))) +
        kv('Location', `<a href="https://www.openstreetmap.org/?mlat=${lat}&amp;mlon=${lng}#map=15/${lat}/${lng}" target="_blank" rel="noopener noreferrer">${lat}, ${lng}</a>`);
      html += '<h4>Notes</h4><div class="notes-box">' + esc(inc.notes || '(no notes)') + '</div>';
      if (inc.photo_path) html += '<h4>Photo</h4><img class="detail-photo" alt="Incident photo" src="' + esc(inc.photo_path) + '" style="max-width:100%; border-radius:8px;">';
      if (inc.audit && inc.audit.length) {
        html += '<h4>Audit trail</h4>' + inc.audit.map((a) => `<div class="trail-row" style="display:flex; justify-content:space-between; padding:4px 0; font-size:0.85rem; border-bottom:1px solid #eee;"><span>${esc(a.action)} by ${esc(a.user_name || 'system')}</span><span>${esc(fmtTime(a.timestamp))}</span></div>`).join('');
      }
      
      const body = $('#detail-body'); if (body) body.innerHTML = html;

      const m = canManage();
      const escBtn = $('#detail-escalate'); if (escBtn) escBtn.hidden = !(m && inc.status === 'Open');
      const resBtn = $('#detail-resolve'); if (resBtn) resBtn.hidden = !(m && inc.status !== 'Resolved');
      const reoBtn = $('#detail-reopen'); if (reoBtn) reoBtn.hidden = !(m && inc.status === 'Resolved');

      await loadPaymentPanel(inc);

      $('#detail-modal').classList.add('open');
    } catch (err) { if (err.status !== 401) toast(err.message); }
  }

  // ---- PayFast payments ----
  const fmtRand = (a) => 'R ' + Number(a).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  S.payFine = null;

  async function loadPaymentPanel(inc) {
    const panel = $('#payment-panel'); if (panel) panel.hidden = true;
    const issueBox = $('#issue-fine-box'); if (issueBox) issueBox.hidden = true;
    const issueErr = $('#issue-fine-error'); if (issueErr) issueErr.textContent = '';
    const issueAmt = $('#issue-fine-amount'); if (issueAmt) issueAmt.value = '';
    const rangerActions = $('#ranger-payment-actions'); if (rangerActions) rangerActions.hidden = true;
    
    try {
      const r = await API.get('/payments/incident/' + inc.id);
      if (!r.fine) {
        if (!canManage()) return;
        const ref = $('#pay-ref'); if (ref) ref.textContent = '—';
        const amt = $('#pay-amount'); if (amt) amt.textContent = '—';
        const status = $('#pay-status'); if (status) status.textContent = 'No fine issued';
        const mode = $('#pay-mode-badge'); if (mode) mode.hidden = true;
        if (issueBox) issueBox.hidden = false;
        if (panel) panel.hidden = false;
        return;
      }
      S.payFine = r.fine;
      
      const ref = $('#pay-ref'); if (ref) ref.textContent = r.fine.reference;
      const amt = $('#pay-amount'); if (amt) amt.textContent = fmtRand(r.fine.amount);
      const status = $('#pay-status'); if (status) status.textContent = r.fine.status === 'Unpaid' ? 'Unpaid' : r.fine.status === 'Pending' ? 'Awaiting confirmation' : r.fine.status;
      const mode = $('#pay-mode-badge'); if (mode) mode.hidden = !r.sandbox;
      if (rangerActions) rangerActions.hidden = !r.can_pay;
      if (panel) panel.hidden = false;
    } catch (err) { /* no payment panel if the lookup fails */ }
  }

  const issueFineBtn = $('#issue-fine-btn');
  if (issueFineBtn) {
    issueFineBtn.addEventListener('click', async () => {
      const errEl = $('#issue-fine-error'), btn = $('#issue-fine-btn');
      const amount = parseFloat($('#issue-fine-amount').value);
      if (errEl) errEl.textContent = '';
      if (!S.detail) return;
      if (!Number.isFinite(amount) || amount < 1 || amount > 50000) { if (errEl) errEl.textContent = 'Enter an amount between R1 and R50,000.'; return; }
      btn.disabled = true;
      try {
        const { fine } = await API.post('/payments/fines', { incident_id: S.detail.id, amount });
        toast('Fine ' + fine.reference + ' issued.');
        await loadPaymentPanel(S.detail);
      } catch (err) {
        if (err.status !== 401 && errEl) errEl.textContent = err.network ? 'Network error. Try again.' : err.message;
      } finally { btn.disabled = false; }
    });
  }

  function openGateway(fine, sandbox) {
    S.payFine = fine;
    const ref = $('#gateway-ref'); if (ref) ref.textContent = 'Amount due — ' + fine.reference;
    const amt = $('#gateway-amount'); if (amt) amt.textContent = fmtRand(fine.amount);
    const badge = $('#gateway-badge'); if (badge) badge.hidden = !sandbox;
    const err = $('#gateway-error'); if (err) err.textContent = '';
    $('#gateway-modal').classList.add('open');
  }

  const collectPayBtn = $('#collect-payment-btn');
  if (collectPayBtn) {
    collectPayBtn.addEventListener('click', () => {
      if (S.payFine) openGateway(S.payFine, !$('#pay-mode-badge').hidden);
    });
  }

  const rangerPayFineBtn = $('#ranger-pay-fine-btn');
  if (rangerPayFineBtn) {
    rangerPayFineBtn.addEventListener('click', async () => {
      try {
        const r = await API.get('/payments/mine');
        if (!r.fines.length) { toast('You have no outstanding fines.'); return; }
        const fine = r.fines.find((f) => f.status === 'Unpaid') || r.fines[0];
        if (fine.status !== 'Unpaid') {
          toast('Fine ' + fine.reference + ' is already ' + String(fine.status).toLowerCase() + '.');
          return;
        }
        openGateway(fine, !!r.sandbox);
      } catch (err) {
        if (err.status !== 401) toast(err.network ? 'Network error — try again' : err.message);
      }
    });
  }

  // ---- PayFast gateway modal ----
  const closeGateway = () => $('#gateway-modal').classList.remove('open');

  const gatewayCancel = $('#gateway-cancel');
  if (gatewayCancel) gatewayCancel.addEventListener('click', closeGateway);

  const gatewayPayBtn = $('#process-payment-btn');
  if (gatewayPayBtn) {
    gatewayPayBtn.addEventListener('click', async () => {
      const errEl = $('#gateway-error'), btn = $('#process-payment-btn');
      if (!S.payFine) return;
      if (errEl) errEl.textContent = '';
      btn.disabled = true; btn.textContent = 'Redirecting…';
      try {
        const r = await API.post('/payments/checkout', { fine_id: S.payFine.id });
        if (r && r.redirect_url) {
          window.location.href = r.redirect_url;
          return;
        }
        toast('Payment initiated — ' + S.payFine.reference);
        closeGateway();
        if (S.detail) await loadPaymentPanel(S.detail);
      } catch (err) {
        if (err.status !== 401 && errEl) {
          errEl.textContent = err.network ? 'Network error — the payment was not started.' : err.message;
        }
      } finally {
        btn.disabled = false; btn.textContent = 'Continue to PayFast';
      }
    });
  }

  async function handlePaymentReturn() {
    const qs = new URLSearchParams(location.search);
    const status = qs.get('payment_status') || qs.get('payment');
    if (!status) return;
    const ref = qs.get('m_payment_id') || qs.get('reference');
    const clean = () => history.replaceState({}, '', location.pathname + location.hash);

    if (/complete|success|paid/i.test(status)) {
      toast('Payment received' + (ref ? ' for ' + ref : '') + ' ✓');
      try {
        await API.post('/payments/confirm', {
          reference: ref,
          payment_status: status,
          pf_payment_id: qs.get('pf_payment_id'),
        });
      } catch (e) { /* ignore */ }
    } else if (/cancel/i.test(status)) {
      toast('Payment cancelled' + (ref ? ' — ' + ref : ''));
    } else {
      toast('Payment status: ' + status);
    }
    clean();
    if (S.user && !isField()) refreshDashboard(true);
  }

  // =========================================================
  // MODALS (shared behaviour)
  // =========================================================
  function closeModals() {
    $$('.modal-backdrop.open').forEach((m) => m.classList.remove('open'));
    S.detail = null;
    S.payFine = null;
  }

  $$('.modal-backdrop').forEach((bd) => bd.addEventListener('click', (e) => {
    if (e.target === bd) { bd.classList.remove('open'); S.detail = null; S.payFine = null; }
  }));
  
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => {
    const bd = b.closest('.modal-backdrop');
    if (bd) bd.classList.remove('open');
    S.detail = null; S.payFine = null;
  }));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.querySelector('.modal-backdrop.open')) closeModals();
  });

  const detailClose = $('#detail-close');
  if (detailClose) detailClose.addEventListener('click', () => { $('#detail-modal').classList.remove('open'); S.detail = null; });

  const detailEscalate = $('#detail-escalate');
  if (detailEscalate) detailEscalate.addEventListener('click', () => S.detail && changeStatus(S.detail.id, 'Escalated'));

  const detailResolve = $('#detail-resolve');
  if (detailResolve) detailResolve.addEventListener('click', () => S.detail && changeStatus(S.detail.id, 'Resolved'));

  const detailReopen = $('#detail-reopen');
  if (detailReopen) detailReopen.addEventListener('click', () => S.detail && changeStatus(S.detail.id, 'Open'));

  // =========================================================
  // USERS (admin only)
  // =========================================================
  async function openUsers() {
    S.previous = 'dashboard-screen';
    showScreen('users-screen');
    await loadUsers();
  }

  async function loadUsers() {
    const tbody = $('#users-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" class="empty">Loading…</td></tr>';
    try {
      const { users } = await API.get('/users');
      if (!users.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty">No users.</td></tr>'; return; }
      tbody.innerHTML = users.map((u) => {
        const statusLabel = u.is_active ? 'Active' : 'Inactive';
        return `
        <tr>
          <td><img src="${getAvatar(u.full_name)}" class="avatar-sm" alt="" /> ${esc(u.full_name)}</td>
          <td>${esc(u.username)}</td>
          <td>${esc(ROLE_LABELS[u.role] || u.role)}</td>
          <td>${esc(u.section_name || '—')}</td>
          <td><span class="badge badge-${statusLabel}">${statusLabel}</span></td>
          <td><button type="button" class="action-btn" data-edit-user="${u.id}">Edit</button></td>
        </tr>`;
      }).join('');
    } catch (err) {
      if (err.status !== 401) tbody.innerHTML = '<tr><td colspan="6" class="empty">Could not load users.</td></tr>';
    }
  }

  const usersBtn = $('#users-btn');
  if (usersBtn) usersBtn.addEventListener('click', openUsers);

  const usersBack = $('#users-screen .profile-back');
  if (usersBack) usersBack.addEventListener('click', () => showScreen('dashboard-screen'));

  // Add User Button
  const addUserBtn = $('#add-user-btn');
  if (addUserBtn) {
    addUserBtn.addEventListener('click', () => {
      S.editingUser = null;
      const form = $('#user-form');
      if (form) form.reset();
      
      $('#user-modal-title').textContent = 'Add User';
      $('#u-password-label').textContent = 'Password';
      $('#u-password-hint').style.display = 'block';
      
      const sectionSelect = $('#u-section');
      if (sectionSelect) {
        sectionSelect.innerHTML = '<option value="">— No section —</option>' + S.sections.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
      }
      
      const err = $('#user-error'); if (err) err.textContent = '';
      $('#user-modal').classList.add('open');
    });
  }

  const usersTbody = $('#users-tbody');
  if (usersTbody) {
    usersTbody.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-edit-user]');
      if (!btn) return;
      S.editingUser = btn.dataset.editUser;
      const userForm = $('#user-form');
      if (!userForm) return;
      try {
        const { users } = await API.get('/users');
        const u = users.find((x) => String(x.id) === String(S.editingUser));
        if (!u) return;
        
        $('#u-name').value = u.full_name || '';
        $('#u-username').value = u.username || '';
        $('#u-email').value = u.email || '';
        $('#u-role').value = u.role || 'field_ranger';
        $('#u-status').value = u.is_active ? 'Active' : 'Inactive';
        
        const sectionSelect = $('#u-section');
        if (sectionSelect) {
          sectionSelect.innerHTML = '<option value="">— No section —</option>' + S.sections.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
          sectionSelect.value = u.section_id || '';
        }
        
        $('#u-password').value = '';
        $('#u-password-label').textContent = 'New Password (optional)';
        $('#u-password-hint').style.display = 'none';
        
        $('#user-modal-title').textContent = 'Edit User';
        $('#user-error').textContent = '';
        $('#user-modal').classList.add('open');
      } catch (err) { if (err.status !== 401) toast(err.message); }
    });
  }

  const userForm = $('#user-form');
  if (userForm) {
    userForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = $('#user-error'), btn = $('#user-save');
      if (errEl) errEl.textContent = '';
      
      const body = {
        full_name: $('#u-name').value.trim(),
        username: $('#u-username').value.trim(),
        email: $('#u-email').value.trim(),
        role: $('#u-role').value,
        section_id: $('#u-section').value || null,
        is_active: $('#u-status').value === 'Active' ? 1 : 0,
      };
      
      const pass = $('#u-password').value;
      if (pass) body.password = pass;
      if (!S.editingUser && !pass) {
        if (errEl) errEl.textContent = 'Password is required for new users.';
        return;
      }

      btn.disabled = true;
      try {
        if (S.editingUser) await API.patch('/users/' + S.editingUser, body);
        else await API.post('/users', body);
        
        toast(S.editingUser ? 'User updated ✓' : 'User created ✓');
        $('#user-modal').classList.remove('open');
        S.editingUser = null;
        await loadUsers();
      } catch (err) {
        if (err.status !== 401 && errEl) errEl.textContent = err.network ? 'Network error — try again.' : err.message;
      } finally { btn.disabled = false; }
    });
  }

  const userCancel = $('#user-cancel');
  if (userCancel) userCancel.addEventListener('click', () => $('#user-modal').classList.remove('open'));

  // =========================================================
  // AUDIT LOG (admin + ecologist)
  // =========================================================
  async function openAudit() {
    S.previous = 'dashboard-screen';
    showScreen('audit-screen');
    const tbody = $('#audit-tbody');
    if (!tbody) return;
    
    tbody.innerHTML = '<tr><td colspan="4" class="empty">Loading…</td></tr>';
    try {
      const { entries } = await API.get('/audit?limit=200');
      if (!entries.length) { tbody.innerHTML = '<tr><td colspan="4" class="empty">No audit entries.</td></tr>'; return; }
      
      tbody.innerHTML = entries.map((a) => `
        <tr>
          <td>${esc(fmtTime(a.timestamp))}</td>
          <td>${esc(a.user_name || 'System')}</td>
          <td>${esc(a.action)}</td>
          <td>${esc(a.entity || '—')}${a.entity_id ? ' #' + esc(a.entity_id) : ''}</td>
        </tr>`).join('');
    } catch (err) {
      if (err.status !== 401) tbody.innerHTML = '<tr><td colspan="4" class="empty">Could not load the audit log.</td></tr>';
    }
  }

  const auditBtn = $('#audit-btn');
  if (auditBtn) auditBtn.addEventListener('click', openAudit);

  const auditBack = $('#audit-screen .profile-back');
  if (auditBack) auditBack.addEventListener('click', () => showScreen('dashboard-screen'));

  // =========================================================
  // SUPPORT CHAT
  // =========================================================
  const Chat = (function () {
    let ready = false;
    const log = [];

    function render() {
      const box = $('#chat-log');
      if (!box) return;
      if (!log.length) {
        box.innerHTML = '<div class="chat-msg bot">Ask about a reference, a status, or how to log an incident.</div>';
        return;
      }
      box.innerHTML = log.map((m) =>
        `<div class="chat-msg ${m.from}">${esc(m.text)}</div>`).join('');
      box.scrollTop = box.scrollHeight;
    }

    function reset() {
      log.length = 0;
      ready = false;
      const input = $('#chat-input'); if (input) input.value = '';
      const panel = $('#chat-panel'); if (panel) panel.hidden = true;
      render();
    }

    function push(from, text) { log.push({ from, text }); render(); }

    async function send(text) {
      const msg = String(text || '').trim();
      if (!msg) return;
      push('user', msg);
      try {
        const r = await API.post('/chat', { message: msg });
        push('bot', r.reply || 'Thanks — your section ranger has been notified.');
      } catch (err) {
        push('bot', err.network
          ? 'You appear to be offline. Your question will be answered when you reconnect.'
          : 'Sorry — I could not answer that right now.');
      }
    }

    function init() {
      if (ready) return; ready = true;
      const launcher = $('#chat-launcher');
      const panel = $('#chat-panel');
      const closeBtn = $('#chat-close');
      const form = $('#chat-form');
      const input = $('#chat-input');
      
      if (launcher && panel) {
        launcher.addEventListener('click', () => {
          panel.hidden = !panel.hidden;
          if (!panel.hidden) { render(); if (input) input.focus(); }
        });
      }
      
      if (closeBtn && panel) {
        closeBtn.addEventListener('click', () => { panel.hidden = true; });
      }
      
      if (form) {
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          if (!input) return;
          const v = input.value; input.value = '';
          send(v);
        });
      }
      render();
    }

    return { init, reset, send };
  })();

  // =========================================================
  // BOOT
  // =========================================================
  Chat.init();
  boot();
})();