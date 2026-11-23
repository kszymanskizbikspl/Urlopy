/* Wspólne pomocniki: dzisiejsza data na „kartce kalendarza”, aktywny link w menu, formatowanie. */
(function () {
  const MONTHS_GEN = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];
  const WD = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
  const t = new Date();
  document.querySelectorAll('[data-today-day]').forEach(e => (e.textContent = t.getDate()));
  document.querySelectorAll('[data-today-month]').forEach(e => (e.textContent = MONTHS_GEN[t.getMonth()]));
  document.querySelectorAll('[data-today-wd]').forEach(e => (e.textContent = WD[t.getDay()]));

  const page = location.pathname.split('/').pop() || 'panel.html';
  document.querySelectorAll('.nav a').forEach(a => { if (a.getAttribute('href') === page) a.setAttribute('aria-current', 'page'); });

  window.fmtDate = s => { const [y, m, d] = s.split('-'); return `${d}.${m}.${y}`; };
  window.fmtRange = (a, b) => (a === b ? fmtDate(a) : `${fmtDate(a)}–${fmtDate(b)}`);
  window.plDays = n => (n === 1 ? '1 dzień' : `${n} dni`);
  window.esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  window.STATUS = {
    pending: ['Czeka', 'p-pending'],
    approved: ['Zatwierdzony', 'p-approved'],
    rejected: ['Odrzucony', 'p-rejected'],
    cancelled: ['Wycofany', 'p-cancelled'],
  };
  window.badge = (s, text) => `<span class="pill ${STATUS[s][1]}">${text || STATUS[s][0]}</span>`;
  const G = MONTHS_GEN;
  const pd = s => { const [y, m, d] = s.split('-').map(Number); return [d, m - 1]; };
  /** „28–30 grudnia”, „30 listopada – 2 grudnia”, „7 kwietnia” */
  window.fmtNice = (a, b) => { const [d1, m1] = pd(a), [d2, m2] = pd(b || a);
    if (a === b || !b) return `${d1} ${G[m1]}`;
    return m1 === m2 ? `${d1}–${d2} ${G[m1]}` : `${d1} ${G[m1]} – ${d2} ${G[m2]}`; };
})();
