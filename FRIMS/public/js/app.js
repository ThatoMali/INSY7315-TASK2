/* =========================================================
   SANParks FRIMS — front-end
   login → (field ranger: log / my reports / profile)
         → (section ranger, ecologist, admin: dashboard → detail / users / audit / profile)
   All data comes from the REST API (js/api.js). Nothing is stored locally except
   the session and the ranger's offline queue.
   ========================================================= */
(function () {
  'use strict';

  const API = FRIMS.api;
  const APP_VERSION = '2.0.0';
  const LAST_SYNC_KEY = 'frims_last_sync';

  const ROLE_LABELS = {
    field_ranger: 'Field Ranger',
    section_ranger: 'Section Ranger',
    ecologist: 'Regional Ecologist',
    admin: 'System Administrator',
  };

  const S = {
    user: null,
    incidents: [], alerts: [], stats: null,
    filter: 'all', search: '', scope: '',
    sections: [],
    map: null, layer: null, chart: null, fitNext: true,
    poll: null, previous: 'dashboard-screen',
    detail: null, editingUser: null,
    photo: null, aiSeq: 0, flushing: false,
  };

  // ---------- helpers ----------
  const $  = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 2800);
  }

  // The API stores UTC as "YYYY-MM-DD HH:MM:SS"
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
    $('#incident-search').value = '';
    $$('.filter-btn').forEach((b) => b.classList.toggle('active', b.dataset.filter === 'all'));
    $('#scope-select').hidden = true;
    resetIncidentForm(); $('#form-msg').textContent = '';
    showScreen('login-screen');
  }
  $$('#logout-btn-ranger, #logout-btn-mine, #logout-btn-dash, #logout-btn-profile').forEach((b) => b.addEventListener('click', doLogout));

  async function boot() {
    const cached = FRIMS.getUser();
    if (!FRIMS.getToken() || !cached) return showScreen('login-screen');
    try {
      const { user } = await API.get('/auth/me');
      FRIMS.setUser(user); S.user = user; route();
    } catch (err) {
      if (err.network) { S.user = cached; route(); toast('Offline — using saved session'); }
      else showScreen('login-screen');
    }
  }

  // =========================================================
  // FIELD RANGER — log incident (with offline queue)
  // =========================================================
  const queueKey = () => 'frims_queue_' + S.user.id;
  function getQueue() { try { return JSON.parse(localStorage.getItem(queueKey()) || '[]'); } catch (e) { return []; } }
  function setQueue(q) {
    try { localStorage.setItem(queueKey(), JSON.stringify(q)); return true; }
    catch (e) { return false; }                 // storage full
  }

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
    $('#photo-label').textContent = '[ Attach Photo ]';
    $('#inc-gps').value = '';
    const tag = $('#ai-tag'); tag.textContent = 'Awaiting input…'; tag.className = 'ai-tag ai-idle';
  }

  // ---- GPS ----
  function parseGPS(str) {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(str || '');
    if (!m) return null;
    const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
  }
  function locate(silent) {
    const input = $('#inc-gps');
    if (!navigator.geolocation) { if (!silent) toast('GPS not available — type coordinates as "lat, lng"'); return; }
    input.placeholder = 'Locating…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        input.value = pos.coords.latitude.toFixed(5) + ', ' + pos.coords.longitude.toFixed(5);
        input.placeholder = '-25.10230, 31.51820';
        if (!silent) toast('GPS location captured');
      },
      () => {
        input.placeholder = '-25.10230, 31.51820';
        if (!silent) toast('Could not get GPS — allow location access or type "lat, lng"');
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  }
  $('#get-gps-btn').addEventListener('click', () => locate(false));

  // ---- photo (downscaled before upload so it works on poor connections) ----
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
      $('#photo-label').textContent = '📷 ' + file.name + ' ✓';
    } catch (err) {
      S.photo = null;
      $('#photo-label').textContent = '[ Attach Photo ]';
      toast('Could not read that image');
    }
  });

  // ---- live severity tag (server-side triage) ----
  let aiTimer = null;
  function scheduleTriage() { clearTimeout(aiTimer); aiTimer = setTimeout(runTriage, 300); }
  async function runTriage() {
    const seq = ++S.aiSeq, tag = $('#ai-tag');
    try {
      const r = await API.post('/incidents/triage', { type: $('#inc-type').value, notes: $('#inc-notes').value });
      if (seq !== S.aiSeq) return;
      tag.textContent = r.severity + ' — auto-flagged';
      tag.className = 'ai-tag ai-' + r.severity.toLowerCase();
    } catch (err) {
      if (seq !== S.aiSeq) return;
      tag.textContent = 'Severity is assigned when the report is submitted';
      tag.className = 'ai-tag ai-idle';
    }
  }
  $('#inc-type').addEventListener('change', scheduleTriage);
  $('#inc-notes').addEventListener('input', scheduleTriage);

  // ---- submit ----
  function setMsg(text, isError) {
    const m = $('#form-msg'); m.textContent = text; m.classList.toggle('error', !!isError);
  }

  $('#incident-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const gps = parseGPS($('#inc-gps').value);
    if (!gps) return setMsg('Capture GPS first (or type "lat, lng")', true);

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
          setMsg('No connection — saved on this device and will sync automatically.');
          toast('Saved offline');
          resetIncidentForm(); locate(true);
          updateSyncPill();
        } else {
          setMsg('Device storage is full — could not save this report.', true);
        }
      } else if (err.status !== 401) {
        setMsg(err.message, true);
      }
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
        try {
          await API.post('/incidents', q[0]);
          sent++;
        } catch (err) {
          const retryable = err.network || err.status === 401 || err.status === 429 || err.status >= 500;
          if (retryable) break;
          dropped++;                                // the server rejected this report for good
        }
        q.shift(); setQueue(q);
      }
      if (sent) markSynced();
    } finally {
      S.flushing = false;
    }
    updateSyncPill();
    const left = getQueue().length;
    if (manual || sent || dropped) {
      if (sent) toast(sent + ' report' + (sent > 1 ? 's' : '') + ' synced ✓');
      else if (dropped) toast(dropped + ' report(s) were rejected by the server and removed');
      else if (left) toast('Still offline — ' + left + ' report(s) waiting');
      else toast('Everything is up to date ✓');
    }
    return { sent, left };
  }

  // ---- my reports ----
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
    if (failed) html = '<div class="empty">Could not load your reports (offline?).</div>' + pending;
    else if (!html) html = '<div class="empty">You have not submitted any reports yet.</div>';
    list.innerHTML = html;
  }
  $('#my-list').addEventListener('click', (e) => {
    const row = e.target.closest('.m-row[data-id]');
    if (row) openDetail(row.dataset.id);
  });

  // ---- bottom tabs (log / my reports / profile) ----
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
    $('#profile-role-eyebrow').textContent = ROLE_LABELS[u.role].toUpperCase();
    $('#profile-name').textContent = u.full_name;
    $('#profile-role-line').textContent = ROLE_LABELS[u.role] + (u.section_name ? ' · ' + u.section_name : '');
    $('#profile-id').textContent = 'ID: ' + u.username;
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
  // DASHBOARD (section ranger / ecologist / admin)
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
    if (!u.section_id) {                         // ecologist / admin can narrow to one section
      try {
        S.sections = (await API.get('/users/sections')).sections;
        sel.innerHTML = '<option value="">All sections</option>' +
          S.sections.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
        sel.value = S.scope; sel.hidden = false;
      } catch (e) { /* non-fatal */ }
    } else {
      sel.hidden = true;
    }

    await refreshDashboard();
    clearInterval(S.poll);
    S.poll = setInterval(() => {
      if ($('#dashboard-screen').classList.contains('active') && !document.hidden &&
          !document.querySelector('.modal-backdrop.open')) refreshDashboard(true);
    }, 30000);
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
      S.stats = stats; S.incidents = inc.incidents; S.alerts = al.alerts;
      markSynced();
      renderStats(); renderMap(); renderChart(); renderTable(); renderAlerts();
    } catch (err) {
      if (!quiet && err.status !== 401) toast(err.network ? 'Cannot reach the server' : err.message);
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

  const SEV_COLOR = { High: '#b3261e', Medium: '#c1691a', Low: '#2e7d32' };

  function renderMap() {
    if (typeof L === 'undefined') return;
    if (!S.map) {
      S.map = L.map('map', { scrollWheelZoom: false }).setView([-23.9884, 31.5547], 6);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors', maxZoom: 18,
      }).addTo(S.map);
      L.rectangle([[-25.7, 31.2], [-22.3, 32.0]], { color: '#2f6b4a', weight: 2, fill: false, dashArray: '4 4' })
        .addTo(S.map).bindPopup('Kruger National Park (approx.)');
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
      L.circleMarker(ll, { radius: 8, color: '#fff', weight: 2, fillColor: SEV_COLOR[inc.severity] || '#666', fillOpacity: 1 })
        .addTo(S.layer)
        .bindPopup(
          `<strong>${esc(inc.type)}</strong><br>Severity: <b>${esc(inc.severity)}</b><br>` +
          `Status: ${esc(inc.status)}<br>By: ${esc(inc.reported_by_name || '—')}<br>` +
          `<small>${esc(fmtTime(inc.created_at))}</small><br>` +
          `<button type="button" class="action-btn" data-open="${inc.id}">Details</button>`
        );
    });
    if (S.fitNext && pts.length) { S.map.fitBounds(pts, { padding: [40, 40], maxZoom: 10 }); S.fitNext = false; }
  }

  function renderChart() {
    if (typeof Chart === 'undefined') return;
    const by = S.stats.byType;
    const labels = by.length ? by.map((r) => r.type) : ['No data'];
    const data = by.length ? by.map((r) => r.count) : [0];
    if (S.chart) {
      S.chart.data.labels = labels; S.chart.data.datasets[0].data = data; S.chart.update();
      return;
    }
    S.chart = new Chart($('#type-chart').getContext('2d'), {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: ['#2f6b4a', '#c1691a', '#1e3a2a', '#6b9e7f', '#8a3b2e', '#b58500', '#5a8a6a', '#3d7a8a'],
          borderRadius: 6, maxBarThickness: 46,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { stepSize: 1, precision: 0 }, grid: { color: '#eef2ee' } },
          x: { grid: { display: false } },
        },
      },
    });
  }

  function renderTable() {
    const tbody = $('#incident-tbody');
    const q = S.search.toLowerCase();
    const rows = S.incidents.filter((i) =>
      (S.filter === 'all' || i.status === S.filter) &&
      (!q || [i.reference, i.type, i.notes, i.reported_by_name].some((v) => String(v || '').toLowerCase().includes(q)))
    );
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">No incidents to display.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((inc) => `
      <tr class="clickable" data-id="${inc.id}">
        <td class="mono">${esc(inc.reference)}</td>
        <td>${esc(fmtTime(inc.created_at))}</td>
        <td>${esc(inc.type)}</td>
        <td>${sevBadge(inc.severity)}</td>
        <td>${statusBadge(inc.status)}</td>
        <td>${esc(inc.reported_by_name || '—')}</td>
        <td class="mono">${inc.latitude.toFixed(3)}, ${inc.longitude.toFixed(3)}</td>
        <td>${canManage() && inc.status !== 'Resolved' ? `<button type="button" class="action-btn" data-resolve="${inc.id}">Resolve</button>` : ''}</td>
      </tr>`).join('');
  }
  $('#incident-tbody').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-resolve]');
    if (btn) { e.stopPropagation(); return changeStatus(btn.dataset.resolve, 'Resolved'); }
    const tr = e.target.closest('tr[data-id]');
    if (tr) openDetail(tr.dataset.id);
  });
  $$('.filter-btn').forEach((btn) => btn.addEventListener('click', () => {
    $$('.filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    S.filter = btn.dataset.filter;
    renderTable();
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

  // ---- alerts ----
  function renderAlerts() {
    const unread = S.alerts.filter((a) => !a.is_read).length;
    const pill = $('#alert-count');
    pill.textContent = unread; pill.classList.toggle('zero', unread === 0);
    $('#alerts-readall').hidden = unread === 0;
    const list = $('#alerts-list');
    if (!S.alerts.length) { list.innerHTML = '<div class="empty">No alerts.</div>'; return; }
    list.innerHTML = S.alerts.slice(0, 6).map((a) => `
      <div class="alert-row${a.is_read ? '' : ' unread'}" data-alert="${a.id}" data-incident="${a.incident_id}">
        <div><div>⚠ ${esc(a.message)}</div>
        <div class="a-meta">Reported by ${esc(a.reported_by_name || '—')} · ${esc(fmtTime(a.created_at))}</div></div>
        <span class="a-meta">${a.is_read ? 'Read' : 'New'}</span>
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

  // ---- exports ----
  $('#export-csv').addEventListener('click', async () => {
    try { await API.download('/reports/incidents.csv' + scopeQS('?'), 'frims_incidents.csv'); toast('CSV exported'); }
    catch (err) { if (err.status !== 401) toast(err.message); }
  });
  $('#export-pdf').addEventListener('click', () => {
    toast('Choose "Save as PDF" in the print dialog');
    setTimeout(() => window.print(), 400);
  });

  // =========================================================
  // INCIDENT DETAIL MODAL (managers and the ranger's own reports)
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
        kv('Reported by', esc(inc.reported_by_name || '—')) +
        kv('Section', esc(inc.section_name || '—')) +
        kv('Reported at', esc(fmtTime(inc.created_at))) +
        kv('Location', `<a href="https://www.openstreetmap.org/?mlat=${lat}&amp;mlon=${lng}#map=15/${lat}/${lng}" target="_blank" rel="noopener noreferrer">${lat}, ${lng}</a>`);
      html += '<h4>Notes</h4><div class="notes-box">' + esc(inc.notes || '(no notes)') + '</div>';
      if (inc.photo_path) html += '<h4>Photo</h4><img class="detail-photo" alt="Incident photo" src="' + esc(inc.photo_path) + '">';
      if (inc.audit && inc.audit.length) {
        html += '<h4>Audit trail</h4>' + inc.audit.map((a) =>
          `<div class="trail-row"><span>${esc(a.action)} by ${esc(a.user_name || 'system')}</span><span>${esc(fmtTime(a.timestamp))}</span></div>`
        ).join('');
      }
      $('#detail-body').innerHTML = html;

      const m = canManage();
      $('#detail-escalate').hidden = !(m && inc.status === 'Open');
      $('#detail-resolve').hidden  = !(m && inc.status !== 'Resolved');
      $('#detail-reopen').hidden   = !(m && inc.status === 'Resolved');
      $('#detail-modal').classList.add('open');
    } catch (err) { if (err.status !== 401) toast(err.message); }
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
  $$('[data-goto="dashboard"]').forEach((b) => b.addEventListener('click', () => {
    showScreen('dashboard-screen'); refreshDashboard(true);
  }));

  async function loadUsers() {
    const tbody = $('#users-tbody');
    tbody.innerHTML = '<tr><td colspan="6" class="empty">Loading…</td></tr>';
    try {
      const { users } = await API.get('/users');
      S.users = users;
      tbody.innerHTML = users.map((u) => `
        <tr data-id="${u.id}">
          <td>${esc(u.full_name)}</td>
          <td class="mono">${esc(u.username)}</td>
          <td>${esc(ROLE_LABELS[u.role] || u.role)}</td>
          <td>${esc(u.section_name || '—')}</td>
          <td><span class="badge badge-${esc(u.status)}">${esc(u.status)}</span></td>
          <td>
            <button type="button" class="action-btn" data-edit="${u.id}">Edit</button>
            ${u.id !== S.user.id && u.status !== 'Inactive'
              ? `<button type="button" class="action-btn danger" data-deactivate="${u.id}">Deactivate</button>` : ''}
          </td>
        </tr>`).join('');
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">' + esc(err.message) + '</td></tr>';
    }
  }

  $('#users-tbody').addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-edit]');
    const deact = e.target.closest('[data-deactivate]');
    if (edit) return openUserModal(S.users.find((u) => String(u.id) === edit.dataset.edit));
    if (deact) {
      const u = S.users.find((x) => String(x.id) === deact.dataset.deactivate);
      if (!confirm('Deactivate ' + u.full_name + '? They will be signed out and unable to log in.')) return;
      try { await API.del('/users/' + u.id); toast('User deactivated'); loadUsers(); }
      catch (err) { if (err.status !== 401) toast(err.message); }
    }
  });

  async function openUserModal(user) {
    if (!S.sections.length) { try { S.sections = (await API.get('/users/sections')).sections; } catch (e) { /* ignore */ } }
    S.editingUser = user || null;
    $('#user-modal-title').textContent = user ? 'Edit User' : 'Add User';
    $('#user-error').textContent = '';
    $('#u-section').innerHTML = '<option value="">— None —</option>' +
      S.sections.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');

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
    if (['field_ranger', 'section_ranger'].includes(role) && !section) {
      err.textContent = 'Rangers must be assigned to a section.'; return;
    }
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
      toast('User saved');
      loadUsers();
    } catch (ex) {
      if (ex.status !== 401) err.textContent = ex.message;
    } finally {
      btn.disabled = false;
    }
  });

  // =========================================================
  // AUDIT LOG (admin / ecologist)
  // =========================================================
  async function loadAudit() {
    const tbody = $('#audit-tbody');
    tbody.innerHTML = '<tr><td colspan="4" class="empty">Loading…</td></tr>';
    try {
      const { entries } = await API.get('/audit');
      tbody.innerHTML = entries.length ? entries.map((a) => `
        <tr>
          <td>${esc(fmtTime(a.timestamp))}</td>
          <td>${esc(a.user_name || 'system')}</td>
          <td>${esc(a.action)}</td>
          <td class="mono">${esc(a.entity_name)} ${esc(a.target || '#' + a.entity_id)}</td>
        </tr>`).join('') : '<tr><td colspan="4" class="empty">No entries.</td></tr>';
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty">' + esc(err.message) + '</td></tr>';
    }
  }

  // =========================================================
  // MODALS: Esc / backdrop
  // =========================================================
  function closeModals() { $$('.modal-backdrop').forEach((m) => m.classList.remove('open')); }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });
  $$('.modal-backdrop').forEach((b) => b.addEventListener('mousedown', (e) => { if (e.target === b) b.classList.remove('open'); }));

  // =========================================================
  boot();
})();
