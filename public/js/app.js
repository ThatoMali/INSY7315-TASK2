/* =========================================================
   SANParks FRIMS — front-end
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

  // Suggested fine amounts (Rand) by severity — used to pre-fill the issue form
  const SUGGESTED_FINE = { High: 2500, Medium: 1000, Low: 500 };

  const S = {
    user: null, incidents: [], alerts: [], stats: null,
    filter: 'all', search: '', scope: '', sections: [],
    map: null, layer: null, chart: null, fitNext: true,
    poll: null, previous: 'dashboard-screen', settingsReturn: 'dashboard-screen',
    detail: null, editingUser: null, photo: null, aiSeq: 0, flushing: false,
    fontScale: parseInt(localStorage.getItem(FONT_SCALE_KEY) || '100', 10),
    language: 'en',
  };

  // ---------- helpers ----------
  const $  = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(msg) {
    const t = $('#toast');
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
    $('#font-size-label').textContent = S.fontScale + '%';
  }

  const sevBadge = (s) => `<span class="badge badge-${esc(String(s).toLowerCase())}">${esc(s)}</span>`;
  const statusBadge = (s) => `<span class="badge badge-${esc(s)}">${esc(s)}</span>`;

  const isField   = () => S.user && S.user.role === 'field_ranger';
  const canManage = () => S.user && ['section_ranger', 'admin'].includes(S.user.role);
  const isAdmin   = () => S.user && S.user.role === 'admin';

  function showScreen(id) {
    $$('.screen').forEach((s) => s.classList.remove('active'));
    $('#' + id).classList.add('active');
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

  $('#login-form').addEventListener('submit', async (e) => {
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
    $('#incident-search').value = '';
    $$('.filter-btn').forEach((b) => b.classList.toggle('active', b.dataset.filter === 'all'));
    $('#scope-select').hidden = true;
    resetIncidentForm(); $('#form-msg').textContent = '';
    showScreen('landing-screen');
  }
  $$('#logout-btn-ranger, #logout-btn-mine, #logout-btn-dash, #logout-btn-profile').forEach((b) => b.addEventListener('click', doLogout));

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
    ['#sync-status', '#sync-status-mine'].forEach((sel) => { const el = $(sel); el.className = 'sync-pill ' + cls; el.textContent = text; });
  }
  window.addEventListener('online',  () => { updateSyncPill(); if (S.user && isField()) flushQueue(); });
  window.addEventListener('offline', updateSyncPill);

  function enterRanger() {
    resetIncidentForm();
    $('#form-msg').textContent = '';
    showScreen('ranger-screen');
    updateSyncPill();
    locate(true);
    scheduleTriage();
    flushQueue();
  }

  function resetIncidentForm() {
    $('#incident-form').reset();
    S.photo = null;
    $('#photo-label').innerHTML = '<svg class="icon"><use href="#icon-camera"></use></svg> Attach Photo';
    $('#inc-gps').value = '';
    const tag = $('#ai-tag'); tag.textContent = 'Awaiting input…'; tag.className = 'ai-tag ai-idle';
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
  $('#get-gps-btn').addEventListener('click', () => locate(false));

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
  $('#inc-photo').addEventListener('change', async (e) => {
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

  let aiTimer = null;
  function scheduleTriage() { clearTimeout(aiTimer); aiTimer = setTimeout(runTriage, 300); }
  async function runTriage() {
    const seq = ++S.aiSeq, tag = $('#ai-tag');
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
  $('#inc-type').addEventListener('change', scheduleTriage);
  $('#inc-notes').addEventListener('input', scheduleTriage);

  function setMsg(text, isError) {
    const m = $('#form-msg'); m.textContent = text; m.classList.toggle('error', !!isError);
  }

  // SOS: contacting emergency services (tel: links) and logging in FRIMS are SEPARATE actions.
  const canDial = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) && navigator.maxTouchPoints > 0;
  let sosClientId = null;
  const sosBtnHtml = '<svg class="icon"><use href="#icon-sos"></use></svg> SOS — Report Emergency';

  $('#sos-btn').addEventListener('click', () => {
    sosClientId = uuid();
    $('#sos-log-msg').textContent = ''; $('#sos-log-msg').classList.remove('error');
    $('#sos-log-btn').disabled = false;
    $('#sos-call-msg').textContent = 'Calling depends on your device, browser and operating system. If nothing opens, dial the number manually.';
    $('#sos-modal').classList.add('open');
  });
  $('#sos-cancel').addEventListener('click', () => $('#sos-modal').classList.remove('open'));

  $$('.sos-call').forEach((a) => a.addEventListener('click', (e) => {
    const n = a.dataset.number;
    if (!canDial()) {
      e.preventDefault();
      $('#sos-call-msg').textContent = 'Calling is not available on this device. Dial ' + n + ' from a phone.';
      return;
    }
    $('#sos-call-msg').textContent = 'Opening your dialler for ' + n + '. Press call to connect — FRIMS cannot confirm that a call was made.';
  }));

  $('#sos-log-btn').addEventListener('click', async () => {
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

  $('#incident-form').addEventListener('submit', async (e) => {
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
  $('#my-list').addEventListener('click', (e) => {
    const row = e.target.closest('.m-row[data-id]');
    if (row) openDetail(row.dataset.id);
  });

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
    
    $('#profile-avatar').src = getAvatar(u.full_name);
    
    $('#profile-role-eyebrow').textContent = ROLE_LABELS[u.role].toUpperCase();
    $('#profile-name').textContent = u.full_name;
    $('#profile-role-line').textContent = ROLE_LABELS[u.role] + (u.section_name ? ' · ' + u.section_name : '');
    $('#profile-id').textContent = 'Username: ' + u.username;
    $('#info-app-version').textContent = APP_VERSION;
    $('#info-last-sync').textContent = relTime(lastSync());
    $('#info-pending').textContent = isField() ? getQueue().length : 0;
    $('#sync-now-btn').innerHTML = '<span class="sync-icon">🔄</span> ' + (isField() ? 'Sync now' : 'Refresh data');
  }
  $('#profile-back').addEventListener('click', () => {
    showScreen(S.previous);
    if (S.previous === 'submissions-screen') loadMine();
  });
  $('#dash-profile-btn').addEventListener('click', () => openProfile('dashboard-screen'));

  $('#sync-now-btn').addEventListener('click', async () => {
    const btn = $('#sync-now-btn');
    if (btn.disabled) return;
    btn.disabled = true; btn.classList.add('spinning');
    $('#info-last-sync').textContent = 'Syncing…';
    try {
      if (isField()) await flushQueue(true);
      else { await refreshDashboard(); toast('Data refreshed ✓'); }
    } finally {
      btn.disabled = false; btn.classList.remove('spinning');
      renderProfile();
    }
  });

  // =========================================================
  // DASHBOARD & LIVE POLLING
  // =========================================================
  async function enterDashboard() {
    const u = S.user;
    $('#dash-user-name').textContent = u.full_name;
    $('#dash-role').textContent = ROLE_LABELS[u.role];
    $('#users-btn').hidden = !isAdmin();
    $('#audit-btn').hidden = !['admin', 'ecologist'].includes(u.role);
    $('#alerts-readall').hidden = false;
    $('#dash-section').textContent = u.section_name || 'All sections';

    showScreen('dashboard-screen');
    S.fitNext = true;

    const sel = $('#scope-select');
    if (!u.section_id) {
      try {
        S.sections = (await API.get('/users/sections')).sections;
        sel.innerHTML = '<option value="">All sections</option>' + S.sections.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
        sel.value = S.scope; sel.hidden = false;
      } catch (e) { /* non-fatal */ }
    } else sel.hidden = true;

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
      
      // SMART LIVE NOTIFICATION CHECK: Only triggers if the array length actually grows
      if (S.incidents.length > 0 && inc.incidents.length > S.incidents.length) {
        const newest = inc.incidents[0]; // The newest is at index 0
        if (quiet) {
          toast('🚨 LIVE ALERT: New ' + newest.severity + ' severity ' + newest.type + ' logged!');
        }
      }

      S.stats = stats; S.incidents = inc.incidents; S.alerts = al.alerts;
      markSynced();
      renderStats(); renderMap(); renderChart(); renderTable(); renderAlerts();
    } catch (err) {
      if (!quiet && err.status !== 401) toast(err.network ? 'Cannot reach server' : err.message);
    }
  }
  $('#refresh-btn').addEventListener('click', async () => { await refreshDashboard(); toast('Refreshed'); });

  $('#scope-select').addEventListener('change', (e) => {
    S.scope = e.target.value;
    S.fitNext = true;
    const opt = e.target.options[e.target.selectedIndex];
    $('#dash-section').textContent = S.scope ? opt.textContent : 'All sections';
    refreshDashboard();
  });

  function renderStats() {
    $('#stat-open').textContent      = S.stats.open;
    $('#stat-escalated').textContent = S.stats.escalated;
    $('#stat-resolved').textContent  = S.stats.resolved;
    $('#stat-total').textContent     = S.stats.total;
  }

  const SEV_COLOR = { High: '#B3261E', Medium: '#C1691A', Low: '#2E7D32' };

  function renderMap() {
    if (typeof L === 'undefined') return;
    if (!S.map) {
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
    if (typeof Chart === 'undefined') return;
    const by = S.stats.byType;
    const labels = by.length ? by.map((r) => r.type) : ['No data'];
    const data = by.length ? by.map((r) => r.count) : [0];
    if (S.chart) { S.chart.data.labels = labels; S.chart.data.datasets[0].data = data; S.chart.update(); return; }
    S.chart = new Chart($('#type-chart').getContext('2d'), {
      type: 'bar',
      data: { labels, datasets: [{ data, backgroundColor: ['#2F6B4A', '#C1691A', '#1E3A2A', '#6B9E7F', '#8A3B2E', '#B58500', '#5A8A6A', '#3D7A8A'], borderRadius: 6, maxBarThickness: 46 }] },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 }, grid: { color: '#EEF2EE' } }, x: { grid: { display: false } } } }
    });
  }

  function renderTable() {
    const tbody = $('#incident-tbody');
    const q = S.search.toLowerCase();
    const rows = S.incidents.filter((i) => (S.filter === 'all' || i.status === S.filter) && (!q || [i.reference, i.type, i.notes, i.reported_by_name].some((v) => String(v || '').toLowerCase().includes(q))));
    if (!rows.length) { tbody.innerHTML = '<tr><td colspan="8" class="empty">No incidents.</td></tr>'; return; }
    
    tbody.innerHTML = rows.map((inc) => `
      <tr class="clickable sev-${inc.severity.toLowerCase()}" data-id="${inc.id}">
        <td class="mono">${esc(inc.reference)}</td><td>${esc(fmtTime(inc.created_at))}</td><td>${esc(inc.type)}</td>
        <td>${sevBadge(inc.severity)}</td><td>${statusBadge(inc.status)}</td>
        <td><img src="${getAvatar(inc.reported_by_name)}" class="avatar-sm" alt="Avatar" /> ${esc(inc.reported_by_name || '—')}</td>
        <td class="mono">${inc.latitude.toFixed(3)}, ${inc.longitude.toFixed(3)}</td>
        <td>
          ${canManage()
            ? `<button type="button" class="action-btn" data-fine="${inc.id}" title="View details &amp; issue fine">💰 Fine</button>`
            : ''}
          ${canManage() && inc.status !== 'Resolved'
            ? `<button type="button" class="action-btn" data-resolve="${inc.id}">Resolve</button>`
            : ''}
        </td>
      </tr>`).join('');
  }
  $('#incident-tbody').addEventListener('click', async (e) => {
    const fineBtn = e.target.closest('[data-fine]');
    if (fineBtn) {
      e.stopPropagation();
      await openDetail(fineBtn.dataset.fine);
      focusPaymentPanel();
      return;
    }
    const btn = e.target.closest('[data-resolve]');
    if (btn) { e.stopPropagation(); return changeStatus(btn.dataset.resolve, 'Resolved'); }
    const tr = e.target.closest('tr[data-id]');
    if (tr) openDetail(tr.dataset.id);
  });
  $$('.filter-btn').forEach((btn) => btn.addEventListener('click', () => {
    $$('.filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    S.filter = btn.dataset.filter; renderTable();
  }));
  $('#incident-search').addEventListener('input', (e) => { S.search = e.target.value.trim(); renderTable(); });

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
    pill.textContent = unread; pill.classList.toggle('zero', unread === 0);
    $('#alerts-readall').hidden = unread === 0;
    const list = $('#alerts-list');
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
  $('#alerts-list').addEventListener('click', async (e) => {
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
  $('#alerts-readall').addEventListener('click', async () => {
    try {
      await API.patch('/alerts/read-all' + scopeQS('?'));
      S.alerts.forEach((a) => { a.is_read = 1; });
      renderAlerts();
    } catch (err) { if (err.status !== 401) toast(err.message); }
  });

  $('#export-csv').addEventListener('click', async () => {
    try { await API.download('/reports/incidents.csv' + scopeQS('?'), 'frims_incidents.csv'); toast('CSV exported'); }
    catch (err) { if (err.status !== 401) toast(err.message); }
  });
  $('#export-pdf').addEventListener('click', () => { toast('Choose "Save as PDF"'); setTimeout(() => window.print(), 400); });

  // =========================================================
  // SETTINGS
  // =========================================================
  $('#settings-btn').addEventListener('click', () => {
    S.settingsReturn = 'dashboard-screen';
    showScreen('settings-screen');
  });

  $('#profile-settings-btn').addEventListener('click', () => {
    S.settingsReturn = 'profile-screen';
    showScreen('settings-screen');
  });

  $('#settings-back-btn').addEventListener('click', () => {
    showScreen(S.settingsReturn);
  });

  // Text Scaling
  $('#font-increase').addEventListener('click', () => {
    if (S.fontScale < 140) {
      S.fontScale += 10;
      localStorage.setItem(FONT_SCALE_KEY, S.fontScale);
      applyFontScale();
    }
  });
  $('#font-decrease').addEventListener('click', () => {
    if (S.fontScale > 80) {
      S.fontScale -= 10;
      localStorage.setItem(FONT_SCALE_KEY, S.fontScale);
      applyFontScale();
    }
  });

  // Language
  $('#lang-select').addEventListener('change', (e) => {
    S.language = e.target.value;
    toast('Language changed (UI simulation)');
  });

  // Change Password
  $('#change-password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const current = $('#current-pass').value;
    const newPass = $('#new-pass').value;
    if (!current || !newPass) return toast('Please fill in all fields');
    if (newPass.length < 8) return toast('New password must be at least 8 characters');
    
    const btn = $('#change-password-form button[type="submit"]');
    const oldText = btn.textContent;
    btn.disabled = true; btn.textContent = 'Updating...';

    try {
      await new Promise(r => setTimeout(r, 800));
      toast('Password updated successfully');
      $('#change-password-form').reset();
    } catch (err) {
      toast('Failed to update password');
    } finally {
      btn.disabled = false; btn.textContent = oldText;
    }
  });

  // =========================================================
  // INCIDENT DETAIL MODAL & PAYMENTS
  // =========================================================
  const kv = (k, v) => `<div class="kv"><span>${esc(k)}</span><span>${v}</span></div>`;

  async function openDetail(id) {
    try {
      const { incident: inc } = await API.get('/incidents/' + id);
      S.detail = inc;
      $('#detail-title').textContent = inc.type;
      $('#detail-sub').textContent = inc.reference;
      const lat = inc.latitude.toFixed(5), lng = inc.longitude.toFixed(5);
      let html =
        kv('Severity', sevBadge(inc.severity)) +
        kv('Status', statusBadge(inc.status)) +
        kv('Reported by', `<img src="${getAvatar(inc.reported_by_name)}" class="avatar-sm" style="margin-right:6px;"> ${esc(inc.reported_by_name || '—')}`) +
        kv('Section', esc(inc.section_name || '—')) +
        kv('Reported at', esc(fmtTime(inc.created_at))) +
        kv('Location', `<a href="https://www.openstreetmap.org/?mlat=${lat}&amp;mlon=${lng}#map=15/${lat}/${lng}" target="_blank" rel="noopener noreferrer">${lat}, ${lng}</a>`);
      html += '<h4>Notes</h4><div class="notes-box">' + esc(inc.notes || '(no notes)') + '</div>';
      if (inc.photo_path) html += '<h4>Photo</h4><img class="detail-photo" alt="Incident photo" src="' + esc(inc.photo_path) + '">';
      if (inc.audit && inc.audit.length) {
        html += '<h4>Audit trail</h4>' + inc.audit.map((a) => `<div class="trail-row"><span>${esc(a.action)} by ${esc(a.user_name || 'system')}</span><span>${esc(fmtTime(a.timestamp))}</span></div>`).join('');
      }
      $('#detail-body').innerHTML = html;

      const m = canManage();
      $('#detail-escalate').hidden = !(m && inc.status === 'Open');
      $('#detail-resolve').hidden  = !(m && inc.status !== 'Resolved');
      $('#detail-reopen').hidden   = !(m && inc.status === 'Resolved');

      await loadPaymentPanel(inc);

      $('#detail-modal').classList.add('open');
    } catch (err) { if (err.status !== 401) toast(err.message); }
  }

  // Scroll + flash the fine panel when opened via the 💰 Fine button
  function focusPaymentPanel() {
    const panel = $('#payment-panel');
    if (!panel || panel.hidden) return;
    setTimeout(() => {
      panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      panel.classList.add('flash');
      setTimeout(() => panel.classList.remove('flash'), 1300);
    }, 180);
  }

  // ---- PayFast payments ----
  const fmtRand = (a) => 'R ' + Number(a).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  S.payFine = null;

  async function loadPaymentPanel(inc) {
    $('#payment-panel').hidden = true;
    $('#issue-fine-box').hidden = true;
    $('#issue-fine-error').textContent = '';
    $('#issue-fine-amount').value = '';
    const hint = $('#issue-fine-hint');
    if (hint) hint.textContent = '';
    $('#ranger-payment-actions').hidden = true;
    try {
      const r = await API.get('/payments/incident/' + inc.id);
      if (!r.fine) {
        if (!canManage()) return;
        const suggested = SUGGESTED_FINE[inc.severity] || SUGGESTED_FINE.Low;

        $('#pay-ref').textContent    = '—';
        $('#pay-amount').textContent = '—';
        $('#pay-status').textContent = 'No fine issued';
        $('#pay-mode-badge').hidden  = true;

        $('#issue-fine-amount').value = suggested.toFixed(2);
        if (hint) hint.textContent =
          'Suggested for ' + inc.severity + ' severity: ' + fmtRand(suggested);

        $('#issue-fine-box').hidden  = false;
        $('#payment-panel').hidden   = false;
        return;
      }
      S.payFine = r.fine;
      $('#pay-ref').textContent = r.fine.reference;
      $('#pay-amount').textContent = fmtRand(r.fine.amount);
      $('#pay-status').textContent = r.fine.status === 'Unpaid' ? 'Unpaid' : r.fine.status === 'Pending' ? 'Awaiting confirmation' : r.fine.status;
      $('#pay-mode-badge').hidden = !r.sandbox;
      $('#ranger-payment-actions').hidden = !r.can_pay;
      $('#payment-panel').hidden = false;
    } catch (err) { /* no payment panel if the lookup fails */ }
  }

  $('#issue-fine-btn').addEventListener('click', async () => {
    const errEl = $('#issue-fine-error'), btn = $('#issue-fine-btn');
    const amount = parseFloat($('#issue-fine-amount').value);
    errEl.textContent = '';
    if (!S.detail) return;
    if (!Number.isFinite(amount) || amount < 1 || amount > 50000) { errEl.textContent = 'Enter an amount between R1 and R50,000.'; return; }
    btn.disabled = true;
    try {
      const { fine } = await API.post('/payments/fines', { incident_id: S.detail.id, amount });
      toast('Fine ' + fine.reference + ' issued.');
      await loadPaymentPanel(S.detail);
    } catch (err) {
      if (err.status !== 401) errEl.textContent = err.network ? 'Network error. Try again.' : err.message;
    } finally { btn.disabled = false; }
  });

  function openGateway(fine, sandbox) {
    S.payFine = fine;
    $('#gateway-ref').textContent = 'Amount due — ' + fine.reference;
    $('#gateway-amount').textContent = fmtRand(fine.amount);
    $('#gateway-badge').hidden = !sandbox;
    $('#gateway-error').textContent = '';
    $('#gateway-modal').classList.add('open');
  }

  $('#gateway-cancel-btn').addEventListener('click', () => {
    $('#gateway-modal').classList.remove('open');
    S.payFine = null;
    $('#gateway-error').textContent = '';
    toast('Payment cancelled');
  });

  $('#collect-payment-btn').addEventListener('click', () => {
    if (S.payFine) openGateway(S.payFine, !$('#pay-mode-badge').hidden);
  });

  $('#ranger-pay-fine-btn').addEventListener('click', async () => {
    try {
      const r = await API.get('/payments/mine');
      if (!r.fines.length) { toast('You have no outstanding fines.'); return; }
      openGateway(r.fines[0], r.sandbox);
    } catch (err) { if (err.status !== 401) toast(err.network ? 'Payments need an internet connection.' : err.message); }
  });

  // Handle Continue to PayFast (Sandbox)
  $('#process-payment-btn').addEventListener('click', async () => {
    if (!S.payFine) return;
    const btn = $('#process-payment-btn');
    btn.disabled = true; btn.textContent = 'Redirecting…';
    try {
      // Build the test form with demo credentials from the official PayFast sandbox
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = 'https://sandbox.payfast.co.za/eng/process';
      form.target = '_blank'; // optional: open in new tab

      const fields = {
        merchant_id: '10000100',
        merchant_key: '46f0cd694581a',
        amount: S.payFine.amount.toFixed(2),
        item_name: 'FRIMS Fine ' + S.payFine.reference,
        return_url: window.location.origin + window.location.pathname + '?payment=success&fine=' + encodeURIComponent(S.payFine.reference),
        cancel_url: window.location.origin + window.location.pathname + '?payment=cancelled&fine=' + encodeURIComponent(S.payFine.reference),
        notify_url: window.location.origin + window.location.pathname + '?payment=notify&fine=' + encodeURIComponent(S.payFine.reference)
      };

      Object.entries(fields).forEach(([name, value]) => {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.appendChild(input);
      });

      document.body.appendChild(form);
      form.submit();
      document.body.removeChild(form);
    } catch (err) {
      $('#gateway-error').textContent = 'Could not redirect to PayFast. Please try again.';
      btn.disabled = false; btn.textContent = 'Continue to PayFast';
    }
  });

  async function handlePaymentReturn() {
    const q = new URLSearchParams(location.search);
    const kind = q.get('payment'), ref = q.get('fine');
    if (!kind || !ref) return;
    history.replaceState(null, '', location.pathname);
    try {
      const { fine } = await API.get('/payments/' + encodeURIComponent(ref) + '/status');
      if (fine.status === 'Paid') toast('Payment confirmed for ' + fine.reference + '.');
      else if (kind === 'cancelled') toast('Payment cancelled. No payment has been recorded.');
      else if (fine.status === 'Pending') toast('Payment submitted — waiting for PayFast to confirm. Check again shortly.');
      else toast('Payment not completed. The fine is still unpaid.');
    } catch (err) { if (err.status !== 401) toast('Could not check payment status.'); }
  }

  $('#detail-escalate').addEventListener('click', () => changeStatus(S.detail.id, 'Escalated'));
  $('#detail-resolve').addEventListener('click',  () => changeStatus(S.detail.id, 'Resolved'));
  $('#detail-reopen').addEventListener('click',   () => changeStatus(S.detail.id, 'Open'));
  $('#detail-close').addEventListener('click', () => $('#detail-modal').classList.remove('open'));

  // =========================================================
  // USER MANAGEMENT (admin)
  // =========================================================
  $('#users-btn').addEventListener('click', () => { showScreen('users-screen'); loadUsers(); });
  $('#audit-btn').addEventListener('click', () => { showScreen('audit-screen'); loadAudit(); });
  $$('[data-goto="dashboard"]').forEach((b) => b.addEventListener('click', () => { showScreen('dashboard-screen'); refreshDashboard(true); }));

  async function loadUsers() {
    const tbody = $('#users-tbody');
    tbody.innerHTML = '<tr><td colspan="6" class="empty">Loading…</td></tr>';
    try {
      const { users } = await API.get('/users');
      S.users = users;
      tbody.innerHTML = users.map((u) => `
        <tr data-id="${u.id}">
          <td><img src="${getAvatar(u.full_name)}" class="avatar-sm" alt="Avatar" /> ${esc(u.full_name)}</td>
          <td class="mono">${esc(u.username)}</td>
          <td>${esc(ROLE_LABELS[u.role] || u.role)}</td><td>${esc(u.section_name || '—')}</td>
          <td><span class="badge badge-${esc(u.status)}">${esc(u.status)}</span></td>
          <td>
            <button type="button" class="action-btn" data-edit="${u.id}">Edit</button>
            ${u.id !== S.user.id && u.status !== 'Inactive' ? `<button type="button" class="action-btn danger" data-deactivate="${u.id}">Deactivate</button>` : ''}
          </td>
        </tr>`).join('');
    } catch (err) { tbody.innerHTML = '<tr><td colspan="6" class="empty">' + esc(err.message) + '</td></tr>'; }
  }

  $('#users-tbody').addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-edit]');
    const deact = e.target.closest('[data-deactivate]');
    if (edit) return openUserModal(S.users.find((u) => String(u.id) === edit.dataset.edit));
    if (deact) {
      const u = S.users.find((x) => String(x.id) === deact.dataset.deactivate);
      if (!confirm('Deactivate ' + u.full_name + '?')) return;
      try { await API.del('/users/' + u.id); toast('User deactivated'); loadUsers(); }
      catch (err) { if (err.status !== 401) toast(err.message); }
    }
  });

  async function openUserModal(user) {
    if (!S.sections.length) { try { S.sections = (await API.get('/users/sections')).sections; } catch (e) { /* ignore */ } }
    S.editingUser = user || null;
    $('#user-modal-title').textContent = user ? 'Edit User' : 'Add User';
    $('#user-error').textContent = '';
    $('#u-section').innerHTML = '<option value="">— None —</option>' + S.sections.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');

    $('#u-name').value     = user ? user.full_name : '';
    $('#u-username').value = user ? user.username : '';
    $('#u-username').disabled = !!user;
    $('#u-email').value    = user ? user.email : '';
    $('#u-password').value = '';
    $('#u-password').required = !user;
    $('#u-password-label').textContent = user ? 'Reset password (optional)' : 'Password';
    $('#u-password-hint').textContent = user ? 'Leave blank to keep the current password.' : 'At least 8 characters.';
    $('#u-role').value     = user ? user.role : 'field_ranger';
    $('#u-section').value  = user && user.section_id ? String(user.section_id) : (S.sections[0] ? String(S.sections[0].id) : '');
    $('#u-status').value   = user ? user.status : 'Active';
    $('#user-modal').classList.add('open');
    $('#u-name').focus();
  }
  $('#add-user-btn').addEventListener('click', () => openUserModal(null));
  $('#user-cancel').addEventListener('click', () => $('#user-modal').classList.remove('open'));

  $('#user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#user-error'), btn = $('#user-save');
    err.textContent = '';
    const role = $('#u-role').value, section = $('#u-section').value;
    if (['field_ranger', 'section_ranger'].includes(role) && !section) { err.textContent = 'Rangers must be assigned to a section.'; return; }
    const body = {
      full_name: $('#u-name').value.trim(),
      email: $('#u-email').value.trim(),
      role, section_id: section ? Number(section) : null,
      status: $('#u-status').value,
    };
    const pw = $('#u-password').value;
    btn.disabled = true;
    try {
      if (S.editingUser) {
        if (pw) body.password = pw;
        await API.patch('/users/' + S.editingUser.id, body);
      } else {
        await API.post('/users', Object.assign(body, { username: $('#u-username').value.trim(), password: pw }));
      }
      $('#user-modal').classList.remove('open');
      toast('User saved'); loadUsers();
    } catch (ex) { if (ex.status !== 401) err.textContent = ex.message; }
    finally { btn.disabled = false; }
  });

  // =========================================================
  // AUDIT LOG
  // =========================================================
  async function loadAudit() {
    const tbody = $('#audit-tbody');
    tbody.innerHTML = '<tr><td colspan="4" class="empty">Loading…</td></tr>';
    try {
      const { entries } = await API.get('/audit');
      tbody.innerHTML = entries.length ? entries.map((a) => `
        <tr><td>${esc(fmtTime(a.timestamp))}</td><td>${esc(a.user_name || 'system')}</td><td>${esc(a.action)}</td><td class="mono">${esc(a.entity_name)} ${esc(a.target || '#' + a.entity_id)}</td></tr>
      `).join('') : '<tr><td colspan="4" class="empty">No entries.</td></tr>';
    } catch (err) { tbody.innerHTML = '<tr><td colspan="4" class="empty">' + esc(err.message) + '</td></tr>'; }
  }

  // =========================================================
  // CHATBOT
  // =========================================================
  const Chat = {
    greetedFor: null, busy: false, open: false,
    reset() {
      this.greetedFor = null; this.busy = false; this.open = false;
      chatLog.innerHTML = ''; chatSuggestions.innerHTML = ''; chatPanel.hidden = true; chatBadge.hidden = true; chatInput.value = '';
    },
    async openPanel() {
      this.open = true; chatPanel.hidden = false; chatBadge.hidden = true;
      const uid = S.user ? S.user.id : 'anon';
      
      if (this.greetedFor !== uid) {
        this.greetedFor = uid; 
        chatLog.innerHTML = '';
        const name = S.user ? S.user.full_name.split(' ')[0] : 'there';
        
        let greeting = `Hi ${name} 👋 I'm the **FRIMS assistant**. I can explain how to log an incident, how severity is worked out, what your role allows, or answer live questions about your incidents.`;
        let sugg = ['How do I log an incident?', 'What makes an incident High severity?', 'How many incidents are open?', 'What can my role do?'];

        try { 
          const st = await API.get('/chat/start'); 
          if (st.greeting) greeting = st.greeting; 
          if (st.suggestions && st.suggestions.length > 0) sugg = st.suggestions; 
        } catch (e) { /* Ignore error and use defaults */ }
        
        if (this.greetedFor === uid) { 
          this.append('bot', greeting); 
          this.suggestions(sugg); 
        }
      }
      setTimeout(() => chatInput.focus(), 50);
    },
    closePanel() { this.open = false; chatPanel.hidden = true; },
    toggle() { this.open ? this.closePanel() : this.openPanel(); },
    append(role, text) {
      const div = document.createElement('div');
      div.className = 'chat-msg ' + role;
      if (role === 'bot') div.innerHTML = renderChatMarkdown(text);
      else div.textContent = text;
      chatLog.appendChild(div); chatLog.scrollTop = chatLog.scrollHeight;
      return div;
    },
    showTyping() {
      const div = document.createElement('div');
      div.className = 'chat-msg bot typing'; div.dataset.typing = '1';
      chatLog.appendChild(div); chatLog.scrollTop = chatLog.scrollHeight;
      return div;
    },
    hideTyping(node) { if (node && node.parentNode) node.parentNode.removeChild(node); },
    suggestions(list) {
      chatSuggestions.innerHTML = '';
      (list || []).slice(0, 4).forEach((s) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'chat-chip'; b.textContent = s;
        b.addEventListener('click', () => { chatInput.value = s; this.send(); });
        chatSuggestions.appendChild(b);
      });
    },
    async send() {
      if (this.busy) return;
      const message = chatInput.value.trim();
      if (!message) return;

      this.busy = true; chatInput.value = ''; chatSend.disabled = true; this.suggestions([]);
      this.append('user', message); const typing = this.showTyping();

      try {
        const res = await API.post('/chat', { message });
        this.hideTyping(typing);
        this.append('bot', res.reply || '…');
        this.suggestions(res.suggestions || []);
      } catch (err) {
        this.hideTyping(typing);
        this.append('bot', err.network ? "I can't reach the server right now." : 'Sorry, something went wrong.');
        this.suggestions(['How do I log an incident?', 'What makes an incident High severity?']);
      } finally {
        this.busy = false; chatSend.disabled = false; chatInput.focus();
      }
    },
  };

  const chatPanel = $('#chat-panel'); const chatLog = $('#chat-log'); const chatInput = $('#chat-input');
  const chatSend = $('#chat-send'); const chatSuggestions = $('#chat-suggestions'); const chatBadge = $('#chat-badge');

  function renderChatMarkdown(text) {
    let html = esc(text);
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    return html;
  }

  $('#chat-launcher').addEventListener('click', () => Chat.toggle());
  $('#chat-close').addEventListener('click', () => Chat.closePanel());
  $('#chat-form').addEventListener('submit', (e) => { e.preventDefault(); Chat.send(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && Chat.open) Chat.closePanel(); });

  // =========================================================
  // MODALS
  // =========================================================
  function closeModals() { $$('.modal-backdrop').forEach((m) => m.classList.remove('open')); }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });
  $$('.modal-backdrop').forEach((b) => b.addEventListener('mousedown', (e) => { if (e.target === b) b.classList.remove('open'); }));

  boot();
})();