/* FRIMS — API client + session helpers.
   Attaches the JWT to every request, normalises errors, and tells the app when the
   session is no longer valid. Network failures are flagged with err.network = true
   so the ranger app can fall back to its offline queue. */
(function (global) {
  'use strict';
  const TOKEN_KEY = 'frims_token';
  const USER_KEY  = 'frims_user';
  let unauthorizedHandler = null;

  const getToken = () => localStorage.getItem(TOKEN_KEY);
  const getUser = () => {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch (e) { return null; }
  };
  const setSession = (token, user) => {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  };
  const setUser = (user) => localStorage.setItem(USER_KEY, JSON.stringify(user));
  const clearSession = () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  };

  async function raw(method, path, body) {
    const headers = {};
    const token = getToken();
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers['Authorization'] = 'Bearer ' + token;

    let res;
    try {
      res = await fetch('/api' + path, {
        method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      const err = new Error('Network unavailable');
      err.network = true;
      throw err;
    }
    if (!res.ok) {
      let msg = 'Request failed (' + res.status + ')';
      try { const d = await res.json(); if (d && d.error) msg = d.error; } catch (e) { /* not JSON */ }
      if (res.status === 401 && token && unauthorizedHandler) unauthorizedHandler();
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  const json = async (method, path, body) => (await raw(method, path, body)).json();

  async function download(path, fallbackName) {
    const res = await raw('GET', path);
    const blob = await res.blob();
    const cd = res.headers.get('content-disposition') || '';
    const m = /filename="?([^";]+)"?/i.exec(cd);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = m ? m[1] : fallbackName;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  global.FRIMS = {
    getToken, getUser, setUser, setSession, clearSession,
    onUnauthorized: (fn) => { unauthorizedHandler = fn; },
    login: async (username, password) => {
      clearSession();                       // never send a stale token to the login endpoint
      const data = await json('POST', '/auth/login', { username, password });
      setSession(data.token, data.user);
      return data.user;
    },
    api: {
      get:   (p)    => json('GET', p),
      post:  (p, b) => json('POST', p, b),
      patch: (p, b) => json('PATCH', p, b),
      del:   (p)    => json('DELETE', p),
      download,
    },
  };
})(window);
