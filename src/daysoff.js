// Dni wolne w firmie (krok 7): dzień wolny w zamian za święto w sobotę (art. 130 § 2 KP) i inne dni wolne.
// Tabela company_days_off: date, name, for_holiday (data święta w sobotę, za które jest ten dzień; NULL = inny dzień wolny).
// Zapis roku zastępuje wszystkie jego dni i w tej samej transakcji przelicza dni robocze we wnioskach.
const db = require('./db');
const leave = require('./leave');
const PL = require('../public/js/holidays.js');

class DaysOffError extends Error { constructor(msg) { super(msg); this.status = 400; this.expose = true; } }
const fail = msg => { throw new DaysOffError(msg); };
const fmt = s => s.split('-').reverse().join('/');
const WD = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
const MAX_EXTRA = 30;

const q = {
  year: db.prepare("SELECT date, name, for_holiday FROM company_days_off WHERE substr(date, 1, 4) = ? ORDER BY date"),
  clearYear: db.prepare("DELETE FROM company_days_off WHERE substr(date, 1, 4) = ?"),
  insert: db.prepare('INSERT INTO company_days_off (date, name, for_holiday) VALUES (?, ?, ?)'),
};

/** { year, saturdays: [{ date, name, replacement }], extra: [{ date, name }] } */
function get(year) {
  const rows = q.year.all(String(year));
  const bySat = new Map(rows.filter(r => r.for_holiday).map(r => [r.for_holiday, r.date]));
  return {
    year,
    saturdays: PL.saturdayHolidays(year).map(s => ({ ...s, replacement: bySat.get(s.date) || null })),
    extra: rows.filter(r => !r.for_holiday).map(r => ({ date: r.date, name: r.name })),
  };
}

/** Dzień, który może być dniem wolnym: w tym roku, poniedziałek–piątek, nie święto */
function checkDay(date, year, label) {
  if (!leave.isIsoDate(date)) fail(`${label}: wybierz datę.`);
  if (date.slice(0, 4) !== String(year)) fail(`${label}: data musi być w ${year} r.`);
  const d = PL.parse(date);
  if (!PL.isWorkingDay(d)) {
    fail(`${label}: ${fmt(date)} to ${PL.holidayName(date) ? `święto (${PL.holidayName(date)})` : WD[d.getDay()]} — wybierz dzień roboczy.`);
  }
}

/**
 * Zapis dni wolnych roku. input: { replacements: { 'rrrr-mm-dd (sobota)': 'rrrr-mm-dd' | '' }, extra: [{ date, name }] }
 * Zwraca { ...get(year), changed: przeliczone wnioski (zero: true = nie obejmuje już żadnego dnia roboczego),
 *          problems: [{ kind: 'pool', year, left } | { kind: 'limit', type, used, limit }] — skutki przeliczenia }
 */
const save = db.transaction((year, input) => {
  const body = input || {};
  const reps = body.replacements ?? {};
  if (typeof reps !== 'object' || Array.isArray(reps)) fail('Nieprawidłowe dane.');
  const extra = body.extra ?? [];
  if (!Array.isArray(extra)) fail('Nieprawidłowe dane.');

  const sats = new Map(PL.saturdayHolidays(year).map(s => [s.date, s.name]));
  const rows = [];   // [date, name, for_holiday]
  for (const [sat, date] of Object.entries(reps)) {
    if (!sats.has(sat)) fail(`${fmt(sat)} nie jest świętem w sobotę w ${year} r.`);
    if (date == null || date === '') continue; // jeszcze nie wyznaczony
    checkDay(date, year, `Dzień wolny za ${sats.get(sat)}`);
    rows.push([date, `Dzień wolny za ${sats.get(sat)} (${fmt(sat)})`, sat]);
  }
  // Każdy element musi być obiektem — inaczej np. ['2026-12-31'] po cichu skasowałby dni wolne roku
  if (extra.some(x => !x || typeof x !== 'object' || Array.isArray(x) || (x.name != null && typeof x.name !== 'string'))) fail('Nieprawidłowe dane.');
  const filled = extra.filter(x => String(x.date ?? '').trim() || String(x.name ?? '').trim()); // puste wiersze z formularza pomijamy
  if (filled.length > MAX_EXTRA) fail(`Najwyżej ${MAX_EXTRA} innych dni wolnych w roku.`);
  for (const x of filled) {
    const name = String(x.name ?? '').trim().replace(/\s+/g, ' ');
    if (name.length > 100) fail('Opis dnia wolnego: najwyżej 100 znaków.');
    checkDay(x.date, year, name || 'Inny dzień wolny');
    rows.push([x.date, name || 'Dzień wolny w firmie', null]);
  }
  const seen = new Set();
  for (const [date] of rows) {
    if (seen.has(date)) fail(`${fmt(date)} jest wpisany więcej niż raz.`);
    seen.add(date);
  }

  // Stan przed zmianą — żeby zgłaszać tylko problemy, które spowodowało to przeliczenie
  const before = new Map(leave.recalcUsers(year).map(id => [id, snapshot(id, year)]));
  q.clearYear.run(String(year));
  for (const r of rows) q.insert.run(...r);
  const changed = leave.recalcYear(year).map(c => ({ ...c, zero: c.days === 0 }));
  return { ...get(year), changed, problems: problems(changed, before, year) };
});

const laterYears = db.prepare('SELECT year FROM allowances WHERE user_id = ? AND year >= ? ORDER BY year').pluck();

/** Pula „w najgorszym wypadku” w roku zapisu i kolejnych (zaległy) oraz wykorzystanie rodzajów z limitem */
function snapshot(userId, year) {
  return {
    pools: new Map(laterYears.all(userId, year).map(y => [y, leave.safeLeft(userId, y)])),
    types: leave.typeUsage(userId, year),
  };
}

/** Skutki przeliczenia do pokazania adminowi: pula na minusie (także w kolejnych latach przez mniejszy zaległy)
    i przekroczone limity (na żądanie / opieka / siła wyższa). Tylko to, co się pogorszyło. */
function problems(changed, before, year) {
  const out = [];
  for (const id of new Set(changed.map(c => c.user_id))) {
    const employee = changed.find(c => c.user_id === id).employee;
    const prev = before.get(id) || { pools: new Map(), types: {} };
    const now = snapshot(id, year);
    for (const [y, left] of now.pools) {
      const was = prev.pools.get(y);
      if (left != null && left < 0 && (was == null || left < was)) out.push({ kind: 'pool', user_id: id, employee, year: y, left });
    }
    for (const [type, used] of Object.entries(now.types)) {
      const limit = leave.LIMITS[type];
      if (used > limit && used > (prev.types[type] ?? 0)) out.push({ kind: 'limit', user_id: id, employee, type, used, limit });
    }
  }
  return out;
}

module.exports = { get, save, DaysOffError };
