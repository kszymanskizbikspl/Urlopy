// Saldo urlopu (PLAN.md, sekcja 4). Zaległy liczony na bieżąco, bez „zamykania roku”:
//   zalegly(Y) = carry_override(Y) ?? max(0, wymiar(Y-1) + zalegly(Y-1) - wykorzystane(Y-1))
//   saldo(Y)   = wymiar(Y) + zalegly(Y) - wykorzystane(Y) - oczekujace(Y)
// „Wykorzystane” = zatwierdzone wnioski z puli wypoczynkowego (wypoczynkowy, na_zadanie).
const db = require('./db');

const POOL_TYPES = "('wypoczynkowy','na_zadanie')";
const q = {
  allowance: db.prepare('SELECT days, carry_override FROM allowances WHERE user_id = ? AND year = ?'),
  firstYear: db.prepare('SELECT MIN(year) FROM allowances WHERE user_id = ?').pluck(),
  // cancel_requested = nadal zatwierdzony, dopóki przełożony nie zgodzi się na anulowanie
  used: db.prepare(`SELECT COALESCE(SUM(days), 0) FROM leave_requests
                    WHERE user_id = ? AND substr(date_from, 1, 4) = ? AND type IN ${POOL_TYPES}
                      AND status IN ('approved', 'cancel_requested')`).pluck(),
  pending: db.prepare(`SELECT COALESCE(SUM(days), 0) FROM leave_requests
                       WHERE user_id = ? AND substr(date_from, 1, 4) = ? AND type IN ${POOL_TYPES} AND status = 'pending'`).pluck(),
};

const used = (userId, year) => q.used.get(userId, String(year));
const pending = (userId, year) => q.pending.get(userId, String(year));

/** Zaległy wyliczony automatycznie (bez ręcznej korekty w roku `year`).
    withPending — „najgorszy wypadek”: czekające wnioski z wcześniejszych lat liczone tak, jakby były zatwierdzone. */
function carryAuto(userId, year, { withPending = false } = {}) {
  const first = q.firstYear.get(userId);
  if (first == null || year <= first) return 0;
  let carry = 0; // zaległy wchodzący w rok y
  for (let y = first; y < year; y++) {
    const a = q.allowance.get(userId, y);
    const carryIn = a && a.carry_override != null ? a.carry_override : carry;
    const taken = used(userId, y) + (withPending ? pending(userId, y) : 0);
    carry = Math.max(0, (a ? a.days : 0) + carryIn - taken);
  }
  return carry;
}

/** Saldo z samymi zatwierdzonymi wnioskami plus dodatkowe dni (extra: { rok: dni }) — bez innych czekających.
    Używane przy zatwierdzaniu: „co, jeśli zatwierdzę tylko ten wniosek”. Uwzględnia zaległy przenoszony na kolejne lata. */
function leftWith(userId, year, extra = {}) {
  const a = q.allowance.get(userId, year);
  if (!a) return null;
  const takenIn = y => used(userId, y) + (extra[y] || 0);
  let carried = a.carry_override;
  if (carried == null) {
    const first = q.firstYear.get(userId);
    carried = 0;
    for (let y = first; y < year; y++) {
      const ay = q.allowance.get(userId, y);
      const carryIn = ay && ay.carry_override != null ? ay.carry_override : carried;
      carried = Math.max(0, (ay ? ay.days : 0) + carryIn - takenIn(y));
    }
  }
  return a.days + carried - takenIn(year);
}

/** Saldo „w najgorszym wypadku”: zaległy pomniejszony także o czekające wnioski z wcześniejszych lat.
    Używane przy składaniu wniosku, żeby wniosek na jeden rok nie zabrał zaległego, na którym opiera się następny. */
function safeLeft(userId, year) {
  const a = q.allowance.get(userId, year);
  if (!a) return null;
  const carried = a.carry_override != null ? a.carry_override : carryAuto(userId, year, { withPending: true });
  return a.days + carried - used(userId, year) - pending(userId, year);
}

/** Saldo na rok albo null, gdy na ten rok nie ustawiono wymiaru */
function balance(userId, year) {
  const a = q.allowance.get(userId, year);
  if (!a) return null;
  const auto = carryAuto(userId, year);
  const carried = a.carry_override != null ? a.carry_override : auto;
  const u = used(userId, year), p = pending(userId, year);
  return {
    days: a.days,
    carryAuto: auto,
    carryOverride: a.carry_override,
    carried,
    used: u,
    pending: p,
    left: a.days + carried - u - p,
  };
}

/** Pierwszy rok z wymiarem (punkt startowy liczenia zaległego) albo null */
const firstYear = userId => q.firstYear.get(userId);

// ---------- wnioski (PLAN.md, sekcja 4: liczenie dni, limity, walidacja) ----------
// Ten sam plik co w przeglądarce — serwer liczy dni robocze identycznie, ale zawsze sam
const PL = require('../public/js/holidays.js');

const TYPES = ['wypoczynkowy', 'na_zadanie', 'okolicznosciowy', 'opieka_188', 'sila_wyzsza', 'bezplatny'];
const TYPE_LABELS = {
  wypoczynkowy: 'Wypoczynkowy', na_zadanie: 'Na żądanie', okolicznosciowy: 'Okolicznościowy',
  opieka_188: 'Opieka nad dzieckiem (art. 188)', sila_wyzsza: 'Siła wyższa (art. 148¹)', bezplatny: 'Bezpłatny',
};
const POOL = ['wypoczynkowy', 'na_zadanie'];                    // z puli urlopu wypoczynkowego
const LIMITS = { na_zadanie: 4, opieka_188: 2, sila_wyzsza: 2 }; // dni w roku
const ACTIVE = "('pending', 'approved', 'cancel_requested')";     // wnioski, które „zajmują” termin i limit

const rq = {
  daysOff: db.prepare('SELECT date, name FROM company_days_off WHERE date BETWEEN ? AND ? ORDER BY date'),
  typeUsed: db.prepare(`SELECT COALESCE(SUM(days), 0) FROM leave_requests
                        WHERE user_id = ? AND substr(date_from, 1, 4) = ? AND type = ? AND status IN ${ACTIVE}`).pluck(),
  overlap: db.prepare(`SELECT date_from, date_to FROM leave_requests
                       WHERE user_id = ? AND status IN ${ACTIVE} AND date_from <= ? AND date_to >= ? LIMIT 1`),
  laterYears: db.prepare('SELECT year FROM allowances WHERE user_id = ? AND year > ? ORDER BY year').pluck(),
  insert: db.prepare(`INSERT INTO leave_requests (user_id, type, date_from, date_to, days, status, substitute_id, note)
                      VALUES (@user_id, @type, @date_from, @date_to, @days, 'pending', @substitute_id, @note)`),
};

/** Dni wolne w firmie w zakresie dat → Map 'rrrr-mm-dd' → nazwa */
const companyDaysOff = (from, to) => new Map(rq.daysOff.all(from, to).map(r => [r.date, r.name]));

/** Dni robocze: pn–pt bez świąt ustawowych i bez dni wolnych w firmie */
const workingDays = (from, to) => PL.countWorkingDays(from, to, companyDaysOff(from, to));

/** Wykorzystanie rodzajów z limitem w roku (zatwierdzone + czekające + prośby o anulowanie) */
const typeUsage = (userId, year) => Object.fromEntries(Object.keys(LIMITS).map(t => [t, rq.typeUsed.get(userId, String(year), t)]));

/** „Dzisiaj” jako data lokalna (TZ=Europe/Warsaw) */
const today = () => PL.iso(new Date());

const isIsoDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && PL.iso(PL.parse(s)) === s;

class RequestError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; this.expose = true; } }
const plDays = n => (n === 1 ? '1 dzień' : `${n} dni`);
const fmt = s => s.split('-').reverse().join('/');

/**
 * Nowy wniosek — walidacja i zapis w jednej transakcji (dwa wnioski naraz nie przekroczą salda ani limitu).
 * input: { date_from, date_to, type, substitute_id, note } → wiersz wniosku
 */
const createRequest = db.transaction((userId, input, { isActiveUser }) => {
  const { date_from: from, date_to: to, type } = input;
  if (!isIsoDate(from) || !isIsoDate(to)) throw new RequestError('Podaj daty od i do.');
  if (from > to) throw new RequestError('Data końcowa jest wcześniejsza niż początkowa.');
  const year = Number(from.slice(0, 4));
  if (to.slice(0, 4) !== from.slice(0, 4)) throw new RequestError('Wniosek nie może obejmować dwóch lat. Złóż osobny na każdy rok.');
  const cy = new Date().getFullYear();
  if (year < cy - 1 || year > cy + 1) throw new RequestError(`Wniosek można złożyć na ${cy - 1}, ${cy} albo ${cy + 1} r.`);
  if (!TYPES.includes(type)) throw new RequestError('Wybierz rodzaj urlopu.');

  // Zastępca: liczba całkowita albo tekst z cyframi (z formularza); true, " 3 " itp. — błąd, nie ciche zamienienie
  const rawSub = input.substitute_id;
  let sub = null;
  if (rawSub !== null && rawSub !== undefined && rawSub !== '') {
    sub = Number.isInteger(rawSub) ? rawSub : typeof rawSub === 'string' && /^\d+$/.test(rawSub) ? Number(rawSub) : NaN;
    if (!Number.isInteger(sub) || sub === userId || !isActiveUser(sub)) throw new RequestError('Wybierz zastępcę z listy.');
  }
  if (input.note != null && typeof input.note !== 'string') throw new RequestError('Nieprawidłowe uwagi.');
  const note = (input.note || '').trim().slice(0, 500) || null;

  const days = workingDays(from, to);
  if (days === 0) throw new RequestError('W tym terminie nie ma dni roboczych.');

  const clash = rq.overlap.get(userId, to, from);
  if (clash) throw new RequestError(`Ten termin pokrywa się z Twoim wnioskiem ${fmt(clash.date_from)}${clash.date_to !== clash.date_from ? ' – ' + fmt(clash.date_to) : ''}.`, 409);

  const inPool = POOL.includes(type);
  let laterBefore = [];
  if (inPool) {
    const b = balance(userId, year);
    if (!b) throw new RequestError(`Nie masz jeszcze ustawionej puli urlopu na ${year} r. Skontaktuj się z administratorem.`, 409);
    // Saldo „w najgorszym wypadku”: czekające wnioski z poprzedniego roku mogą jeszcze zmniejszyć zaległy
    const left = Math.min(b.left, safeLeft(userId, year));
    if (days > left) {
      const why = left < b.left ? ` (czekające wnioski z ${year - 1} r. zmniejszą zaległy urlop przenoszony na ${year} r.)` : '';
      throw new RequestError(`Brakuje ${plDays(days - left)}. Do wykorzystania w ${year} r. masz ${plDays(Math.max(0, left))}${why}.`, 409);
    }
    // Kolejne lata z ustawioną pulą — ich zaległy zależy od tego roku
    laterBefore = rq.laterYears.all(userId, year).map(y => [y, safeLeft(userId, y)]);
  }
  if (LIMITS[type]) {
    const usedT = rq.typeUsed.get(userId, String(year), type);
    if (usedT + days > LIMITS[type]) {
      throw new RequestError(`Limit dla tego rodzaju urlopu to ${plDays(LIMITS[type])} w roku. Wykorzystano już ${plDays(usedT)}.`, 409);
    }
  }

  const row = { user_id: userId, type, date_from: from, date_to: to, days, substitute_id: sub, note };
  const id = Number(rq.insert.run(row).lastInsertRowid);
  // Po zapisie (w tej samej transakcji): wniosek nie może sprawić, że w kolejnym roku zabraknie dni na urlop
  // już zatwierdzony lub czekający. Błąd = wycofanie całej transakcji, więc wniosek nie zostaje zapisany.
  for (const [y, before] of laterBefore) {
    const after = safeLeft(userId, y);
    if (after < 0 && after < before) {
      throw new RequestError(`Ten wniosek zmniejszy zaległy urlop przenoszony na ${y} r., a na ${y} r. masz już zaplanowany urlop — zabrakłoby ${plDays(-after)}.`, 409);
    }
  }
  return { id, ...row, status: 'pending' };
});

module.exports = {
  balance, carryAuto, firstYear, safeLeft, leftWith,
  TYPES, TYPE_LABELS, POOL, LIMITS, companyDaysOff, workingDays, typeUsage, today, isIsoDate, createRequest, RequestError,
};
