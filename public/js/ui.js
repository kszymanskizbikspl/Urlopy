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

  // Daty w aplikacji: dd/mm/rrrr. W kodzie i w API zawsze rrrr-mm-dd.
  window.fmtDate = s => { const [y, m, d] = s.slice(0, 10).split('-'); return `${d}/${m}/${y}`; };
  /** Znacznik czasu z bazy (SQLite datetime('now') = UTC, „rrrr-mm-dd gg:mm:ss”) → data lokalna rrrr-mm-dd */
  window.localDate = s => {
    const d = new Date(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
    if (isNaN(d)) return String(s).slice(0, 10);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  window.fmtRange = (a, b) => (!b || a === b ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`);
  /** „28/12/2026”, „28/12/2026 – 30/12/2026” */
  window.fmtNice = fmtRange;
  window.plDays = n => (n === 1 ? '1 dzień' : `${n} dni`);
  window.esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  window.STATUS = {
    pending: ['Czeka', 'p-pending'],
    approved: ['Zatwierdzony', 'p-approved'],
    rejected: ['Odrzucony', 'p-rejected'],
    cancelled: ['Wycofany', 'p-cancelled'],
    cancel_requested: ['Prośba o anulowanie', 'p-pending'],   // zatwierdzony, czeka na zgodę przełożonego na anulowanie
  };
  window.badge = (s, text) => `<span class="pill ${STATUS[s][1]}">${text || STATUS[s][0]}</span>`;

  /** Pola daty: <input type="text" data-date> → pole dd/mm/rrrr z polskim kalendarzem (flatpickr).
      Oryginalne pole zostaje ukryte i trzyma rrrr-mm-dd — kod strony czyta .value jak wcześniej,
      a wybór daty wywołuje na nim zdarzenia change i input. min/max z atrybutów (rrrr-mm-dd). */
  window.datePickers = (root = document) => {
    if (!window.flatpickr) return;
    root.querySelectorAll('input[data-date]').forEach(el => {
      if (el._flatpickr) return;
      const fp = flatpickr(el, {
        locale: 'pl',
        dateFormat: 'Y-m-d',
        altInput: true,
        altFormat: 'd/m/Y',
        allowInput: true,          // można też wpisać ręcznie dd/mm/rrrr
        disableMobile: true,       // także na telefonie ten sam format zamiast natywnego pola
        minDate: el.getAttribute('min') || null,
        maxDate: el.getAttribute('max') || null,
        altInputClass: `${el.className} date-input`.trim(),
      });
      fp.altInput.placeholder = 'dd/mm/rrrr';
      fp.altInput.autocomplete = 'off';
      // Etykieta <label for> wskazuje ukryte pole — przenosimy jej sens na widoczne
      const label = el.id && document.querySelector(`label[for="${el.id}"]`);
      if (label) {
        fp.altInput.setAttribute('aria-label', label.textContent.trim());
        label.addEventListener('click', e => { e.preventDefault(); fp.altInput.focus(); });
      }
    });
  };
  /** Ustawienie daty z kodu (rrrr-mm-dd albo ''), bez wywoływania change */
  window.setDateValue = (el, v) => (el._flatpickr ? el._flatpickr.setDate(v || null, false) : (el.value = v || ''));
  datePickers();
})();
