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

/** Zaległy wyliczony automatycznie (bez ręcznej korekty w roku `year`) */
function carryAuto(userId, year) {
  const first = q.firstYear.get(userId);
  if (first == null || year <= first) return 0;
  let carry = 0; // zaległy wchodzący w rok y
  for (let y = first; y < year; y++) {
    const a = q.allowance.get(userId, y);
    const carryIn = a && a.carry_override != null ? a.carry_override : carry;
    carry = Math.max(0, (a ? a.days : 0) + carryIn - used(userId, y));
  }
  return carry;
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

module.exports = { balance, carryAuto };
