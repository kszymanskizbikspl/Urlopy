// API pracownika (krok 5): saldo, własne wnioski, składanie i wycofywanie, kalendarz, lista osób do zastępstwa.
const express = require('express');
const db = require('../db');
const audit = require('../audit');
const settings = require('../settings');
const leave = require('../leave');
const approvals = require('../approvals');
const { requireApi } = require('../auth');

const router = express.Router();
const anyUser = requireApi();

const badRequest = msg => Object.assign(new Error(msg), { status: 400, expose: true });
const conflict = msg => Object.assign(new Error(msg), { status: 409, expose: true });
const notFound = () => Object.assign(new Error('Nie znaleziono'), { status: 404, expose: true });

const thisYear = () => new Date().getFullYear();
function parseYear(v) {
  const y = v == null || v === '' ? thisYear() : Number(v);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw badRequest('Nieprawidłowy rok.');
  return y;
}
const noStore = res => res.set('Cache-Control', 'no-store');

// ---------- saldo ----------
router.get('/me/balance', anyUser, (req, res) => {
  const year = parseYear(req.query.year);
  const b = leave.balance(req.user.id, year);
  noStore(res).json({
    year,
    balance: b,
    // zaległy zużywany jako pierwszy (PLAN.md, sekcja 4)
    carriedLeft: b ? Math.max(0, b.carried - b.used - b.pending) : 0,
    // ile można jeszcze wnioskować w tym roku: saldo pomniejszone, jeśli czekające wnioski z poprzedniego roku
    // mogą zmniejszyć zaległy (to samo sprawdza POST /api/requests)
    available: b ? Math.min(b.left, leave.safeLeft(req.user.id, year)) : null,
    typeUsed: leave.typeUsage(req.user.id, year),
    limits: leave.LIMITS,
  });
});

// ---------- własne wnioski ----------
const myRequestsQ = db.prepare(`
  SELECT r.id, r.type, r.date_from, r.date_to, r.days, r.status, r.note, r.created_at,
         r.decided_at, r.decision_note,
         trim(s.first_name || ' ' || s.last_name) AS substitute,
         trim(d.first_name || ' ' || d.last_name) AS decided_by
  FROM leave_requests r
  LEFT JOIN users s ON s.id = r.substitute_id
  LEFT JOIN users d ON d.id = r.decided_by
  WHERE r.user_id = ?
  ORDER BY r.date_from DESC, r.id DESC`);

// Wszystkie lata naraz — kalendarz pokazuje też przełom roku; lista na stronie i tak jest krótka
router.get('/me/requests', anyUser, (req, res) => {
  noStore(res).json({ today: leave.today(), requests: myRequestsQ.all(req.user.id) });
});

// ---------- nowy wniosek ----------
const activeUser = db.prepare("SELECT 1 FROM users WHERE id = ? AND state = 'active'");

router.post('/requests', anyUser, (req, res) => {
  const r = leave.createRequest(req.user.id, req.body || {}, { isActiveUser: id => !!activeUser.get(id) });
  audit(req.user.id, 'request_created', { id: r.id, type: r.type, from: r.date_from, to: r.date_to, days: r.days });
  approvals.notifyApprovers(r.id, 'request_new');
  res.status(201).json({ request: r });
});

// ---------- wycofanie ----------
const ownRequest = db.prepare('SELECT id, user_id, status, date_from, date_to FROM leave_requests WHERE id = ?');
const setStatus = db.prepare('UPDATE leave_requests SET status = ? WHERE id = ? AND status = ?');

// Czekający → wycofany od razu. Zatwierdzony w przyszłości → prośba o anulowanie (decyduje przełożony, krok 6).
// Zatwierdzony, który już się zaczął, zmienia tylko przełożony.
router.post('/requests/:id/cancel', anyUser, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw notFound();
  const out = db.transaction(() => {
    const r = ownRequest.get(id);
    if (!r || r.user_id !== req.user.id) throw notFound();   // cudze wnioski — jak nieistniejące
    let next;
    if (r.status === 'pending') next = 'cancelled';
    else if (r.status === 'approved' && r.date_from > leave.today()) next = 'cancel_requested';
    else if (r.status === 'approved') throw conflict('Ten urlop już się zaczął. O zmianie porozmawiaj z przełożonym.');
    else if (r.status === 'cancel_requested') throw conflict('Prośba o anulowanie już czeka na decyzję przełożonego.');
    else throw conflict('Tego wniosku nie można już wycofać.');
    setStatus.run(next, id, r.status);
    return { id, from: r.status, status: next };
  })();
  audit(req.user.id, out.status === 'cancelled' ? 'request_cancelled' : 'request_cancel_requested', out);
  // Przełożony dostał wcześniej e-mail o wniosku albo teraz prośbę o anulowanie — informujemy w obu przypadkach
  approvals.notifyApprovers(id, out.status === 'cancel_requested' ? 'cancel_request' : 'request_withdrawn');
  res.json({ id, status: out.status });
});

// ---------- kalendarz ----------
// Dni wolne w firmie i — jeśli admin włączył „Pokazuj pracownikom, kto ma urlop” — zatwierdzone urlopy innych
// (bez rodzaju urlopu i uwag: tylko kto i kiedy). Święta ustawowe liczy przeglądarka z holidays.js.
const absentQ = db.prepare(`
  SELECT trim(u.first_name || ' ' || u.last_name) AS name, r.date_from, r.date_to
  FROM leave_requests r JOIN users u ON u.id = r.user_id
  WHERE r.status IN ('approved', 'cancel_requested') AND r.user_id <> ? AND u.state = 'active'
    AND r.date_from <= ? AND r.date_to >= ?
  ORDER BY r.date_from, name`);

router.get('/calendar', anyUser, (req, res) => {
  const { from, to } = req.query;
  if (!leave.isIsoDate(from) || !leave.isIsoDate(to) || from > to) throw badRequest('Podaj zakres dat from i to (rrrr-mm-dd).');
  if ((Date.parse(to) - Date.parse(from)) / 864e5 > 1100) throw badRequest('Zakres dat może mieć najwyżej 3 lata.');
  const showAbsent = settings.getAll().show_absent === '1';
  noStore(res).json({
    daysOff: [...leave.companyDaysOff(from, to)].map(([date, name]) => ({ date, name })),
    showAbsent,
    absent: showAbsent ? absentQ.all(req.user.id, to, from) : [],
  });
});

// ---------- osoby do zastępstwa ----------
const peopleQ = db.prepare(`SELECT id, trim(first_name || ' ' || last_name) AS name FROM users
                            WHERE state = 'active' AND id <> ? ORDER BY last_name, first_name`);
const collator = new Intl.Collator('pl', { sensitivity: 'base' });

router.get('/people', anyUser, (req, res) => {
  const people = peopleQ.all(req.user.id).sort((a, b) => collator.compare(a.name, b.name));
  noStore(res).json({ people });
});

module.exports = router;
