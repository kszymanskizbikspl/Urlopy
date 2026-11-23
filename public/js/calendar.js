/* Kalendarz wyboru urlopu. Wymaga holidays.js (globalny obiekt PL).
   Użycie:
     const cal = new LeaveCalendar(el, {
       months: 2,                       // ile miesięcy obok siebie
       events: [{from, to, status: 'approved'|'pending', label}],
       extraOff: new Map([['2026-11-10', 'Dzień wolny za 15 sierpnia']]),
       minDate: '2026-11-23',           // dni wcześniejsze są nieaktywne
       onSelect(from, to) {}            // wywoływane po kliknięciu dnia
     });
   Pierwsze kliknięcie: początek, drugie: koniec, trzecie: nowy wybór. */
const PL_MONTHS = ['Styczeń', 'Luty', 'Marzec', 'Kwiecień', 'Maj', 'Czerwiec', 'Lipiec', 'Sierpień', 'Wrzesień', 'Październik', 'Listopad', 'Grudzień'];
const PL_MONTHS_GEN = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia'];
const PL_DOW = ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd'];

class LeaveCalendar {
  constructor(el, opts = {}) {
    this.el = el;
    this.o = Object.assign({ months: 2, heading: '', events: [], extraOff: new Map(), minDate: null, onSelect() {} }, opts);
    const t = new Date();
    this.today = PL.iso(t);
    this.view = new Date(t.getFullYear(), t.getMonth(), 1);
    this.start = null;
    this.end = null;
    this.indexEvents();
    el.addEventListener('click', e => this.onClick(e));
    this.render();
  }

  indexEvents() {
    this.ev = new Map();
    for (const e of this.o.events)
      for (let d = PL.parse(e.from), end = PL.parse(e.to); d <= end; d = PL.addDays(d, 1)) this.ev.set(PL.iso(d), e);
  }

  setEvents(events) { this.o.events = events; this.indexEvents(); this.render(); }

  setRange(from, to) {
    this.start = from || null;
    this.end = to || null;
    if (from) { const d = PL.parse(from); this.view = new Date(d.getFullYear(), d.getMonth(), 1); }
    this.render();
  }

  clear() { this.start = this.end = null; this.render(); this.o.onSelect(null, null); }

  /** Czy w zakresie są dni z innych wniosków */
  overlaps(from, to) {
    for (let d = PL.parse(from), end = PL.parse(to); d <= end; d = PL.addDays(d, 1)) if (this.ev.has(PL.iso(d))) return true;
    return false;
  }

  onClick(e) {
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      this.view = new Date(this.view.getFullYear(), this.view.getMonth() + Number(nav.dataset.nav), 1);
      this.render();
      return;
    }
    const b = e.target.closest('button[data-date]');
    if (!b || b.disabled) return;
    const d = b.dataset.date;
    if (!this.start || this.end) { this.start = d; this.end = null; }
    else if (d < this.start) { this.end = this.start; this.start = d; }
    else this.end = d;
    this.render();
    this.o.onSelect(this.start, this.end || this.start);
    this.el.querySelector(`button[data-date="${d}"]`)?.focus();
  }

  describe(iso) {
    const parts = [];
    const h = PL.holidayName(iso); if (h) parts.push(h);
    const off = this.o.extraOff.get(iso); if (off) parts.push(off);
    const ev = this.ev.get(iso); if (ev) parts.push(ev.label);
    return parts.join(', ');
  }

  classes(iso, date) {
    const c = ['day'];
    const dow = date.getDay();
    if (dow === 0 || dow === 6) c.push('is-weekend');
    if (PL.holidayName(iso)) c.push('is-holiday');
    else if (this.o.extraOff.has(iso)) c.push('is-off');
    const ev = this.ev.get(iso);
    if (ev) c.push('ev-' + ev.status);
    const end = this.end || this.start;
    if (this.start && iso >= this.start && iso <= end) {
      c.push('in-range');
      if (iso === this.start) c.push('range-start');
      if (iso === end) c.push('range-end');
    }
    if (iso === this.today) c.push('is-today');
    return c.join(' ');
  }

  month(y, m) {
    const offset = (new Date(y, m, 1).getDay() + 6) % 7; // poniedziałek jako pierwszy
    const days = new Date(y, m + 1, 0).getDate();
    let h = `<div class="cal-month"><h3>${PL_MONTHS[m]} ${y}</h3><div class="cal-grid">`;
    h += PL_DOW.map((d, i) => `<div class="cal-dow${i === 6 ? ' sun' : ''}" aria-hidden="true">${d}</div>`).join('');
        for (let d = 1; d <= days; d++) {
      const date = new Date(y, m, d);
      const iso = PL.iso(date);
      const desc = this.describe(iso);
      const disabled = this.o.minDate && iso < this.o.minDate;
      const pos = d === 1 && offset ? ` style="grid-column-start: ${offset + 1}"` : '';
      h += `<button type="button" class="${this.classes(iso, date)}" data-date="${iso}"${pos}`
        + (desc ? ` title="${desc}"` : '')
        + ` aria-label="${d} ${PL_MONTHS_GEN[m]} ${y}${desc ? ', ' + desc : ''}"`
        + (disabled ? ' disabled' : '') + `>${d}</button>`;
    }
    return h + '</div></div>';
  }

  render() {
    const free = [];
    let months = '';
    for (let i = 0; i < this.o.months; i++) {
      const d = new Date(this.view.getFullYear(), this.view.getMonth() + i, 1);
      const y = d.getFullYear(), m = d.getMonth(), prefix = `${y}-${String(m + 1).padStart(2, '0')}`;
      months += this.month(y, m);
      for (const [iso, name] of PL.holidays(y)) if (iso.startsWith(prefix)) free.push([iso, name]);
      for (const [iso, name] of this.o.extraOff) if (iso.startsWith(prefix)) free.push([iso, name]);
    }
    free.sort((a, b) => a[0].localeCompare(b[0]));
    const fmt = iso => { const d = PL.parse(iso); return `${d.getDate()} ${PL_MONTHS_GEN[d.getMonth()]}`; };
    const chev = d => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"></path></svg>`;
    this.el.innerHTML = `
      <div class="cal-bar">
        <div class="cal-head">${this.o.heading}</div>
        <div class="cal-nav">
          <button type="button" class="btn btn-ghost icon-btn" data-nav="-1" aria-label="Poprzedni miesiąc">${chev('M15 6l-6 6 6 6')}</button>
          <button type="button" class="btn btn-ghost icon-btn" data-nav="1" aria-label="Następny miesiąc">${chev('M9 6l6 6-6 6')}</button>
        </div>
      </div>
      <div class="cal-months">${months}</div>
      <ul class="holiday-list">${free.length
        ? free.map(([iso, n]) => `<li><time datetime="${iso}">${fmt(iso)}</time><span>${n}</span></li>`).join('')
        : '<li class="muted">W tych miesiącach nie ma świąt ani dni wolnych.</li>'}</ul>`;
  }
}
