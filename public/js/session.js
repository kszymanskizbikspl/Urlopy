/* Strony po zalogowaniu: dane użytkownika w nagłówku, menu według roli, wywołania API z tokenem CSRF.
   Użycie w stronie:  meReady.then(me => ...);  const data = await api('/api/...', { method: 'POST', body: {...} }); */
(function () {
  const ROLE_LINKS = {
    'admin-wnioski.html': ['manager', 'admin'],
    'admin-pracownicy.html': ['admin'],
    'admin-ustawienia.html': ['admin'],
  };
  const navLinks = [...document.querySelectorAll('.nav a')].filter(a => ROLE_LINKS[a.getAttribute('href')]);
  navLinks.forEach(a => (a.hidden = true)); // pokażemy po sprawdzeniu roli

  let csrf = null;

  /** fetch do API: JSON w obie strony, X-CSRF-Token, 401 → strona logowania */
  window.api = async function (url, opts = {}) {
    const o = { method: 'GET', credentials: 'same-origin', ...opts, headers: { Accept: 'application/json', ...opts.headers } };
    if (o.body !== undefined && typeof o.body !== 'string') {
      o.body = JSON.stringify(o.body);
      o.headers['Content-Type'] = 'application/json';
    }
    if (o.method !== 'GET' && csrf) o.headers['X-CSRF-Token'] = csrf;
    const r = await fetch(url, o);
    if (r.status === 401) {
      location.href = '/login.html?next=' + encodeURIComponent(location.pathname);
      throw new Error('Sesja wygasła');
    }
    const data = (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
    if (!r.ok) throw Object.assign(new Error((data && data.error) || `Błąd ${r.status}`), { status: r.status, data });
    return data;
  };

  /** Licznik przy „Wnioski”: ile wniosków czeka na decyzję zalogowanej osoby (0 = ukryty) */
  window.setNavCount = n => {
    const el = document.getElementById('nav-count');
    if (el) { el.textContent = n || ''; el.hidden = !n; }
  };

  window.meReady = api('/api/me').then(me => {
    csrf = me.csrf;
    window.ME = me;
    const name = `${me.first_name} ${me.last_name}`.trim() || me.email;
    const initials = ((me.first_name[0] || '') + (me.last_name[0] || '')).toUpperCase() || me.email[0].toUpperCase();
    document.querySelectorAll('.user-name').forEach(e => (e.textContent = name));
    document.querySelectorAll('.avatar').forEach(e => (e.textContent = initials));
    navLinks.forEach(a => (a.hidden = !ROLE_LINKS[a.getAttribute('href')].includes(me.role)));
    setNavCount(me.pending_count);
    return me;
  });
})();
