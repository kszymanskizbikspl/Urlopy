// /api/admin/requests — wnioski do rozpatrzenia i historia dla przełożonych i administratorów (krok 6).
const express = require('express');
const db = require('../db');
const audit = require('../audit');
const leave = require('../leave');
const approvals = require('../approvals');
const { requireApi } = require('../auth');

const router = express.Router();
const deciders = requireApi(['manager', 'admin']);

const badRequest = msg => Object.assign(new Error(msg), { status: 400, expose: true });
const notFound = () => Object.assign(new Error('Nie znaleziono'), { status: 404, expose: true });

// Filtry na stronie: „Do rozpatrzenia” to także prośby o anulowanie (wymagają decyzji)
const FILTERS = {
  pending: ['pending', 'cancel_requested'],
  approved: ['approved', 'cancel_requested'],
  rejected: ['rejected'],
  cancelled: ['cancelled'],
  all: ['pending', 'approved', 'rejected', 'cancelled', 'cancel_requested'],
};

const listQ = db.prepare(`
  SELECT r.id, r.user_id, r.type, r.date_from, r.date_to, r.days, r.status, r.note, r.created_at,
         r.substitute_id, r.decided_at, r.decision_note,
         trim(u.first_name || ' ' || u.last_name) AS employee,
         trim(s.first_name || ' ' || s.last_name) AS substitute,
         trim(d.first_name || ' ' || d.last_name) AS decided_by
  FROM leave_requests r
  JOIN users u ON u.id = r.user_id
  LEFT JOIN users s ON s.id = r.substitute_id
  LEFT JOIN users d ON d.id = r.decided_by
  WHERE r.status IN (SELECT value FROM json_each(@statuses))
    AND (@year IS NULL OR substr(r.date_from, 1, 4) = @year)
  -- najpierw wymagające decyzji (od najbliższego terminu), potem rozpatrzone (od najnowszego)
  ORDER BY CASE WHEN r.status IN ('pending', 'cancel_requested') THEN 0 ELSE 1 END,
           CASE WHEN r.status IN ('pending', 'cancel_requested') THEN r.date_from END ASC,
           r.date_from DESC, r.id DESC`);

// Kto inny jest nieobecny w tym czasie (zatwierdzone, czekające i prośby o anulowanie) — ostrzeżenia przy decyzji
const overlapQ = db.prepare(`
  SELECT r.user_id, trim(u.first_name || ' ' || u.last_name) AS name, r.date_from, r.date_to, r.status
  FROM leave_requests r JOIN users u ON u.id = r.user_id
  WHERE r.status IN ('pending', 'approved', 'cancel_requested') AND r.user_id <> ? AND u.state = 'active'
    AND r.date_from <= ? AND r.date_to >= ?
  ORDER BY r.date_from, name`);

/** Wnioski, które ten użytkownik może rozpatrzyć (przełożony: swoi ludzie; admin: wszystkie poza własnymi) */
function visible(user, statuses, year) {
  const rows = listQ.all({ statuses: JSON.stringify(statuses), year: year == null ? null : String(year) });
  const cache = new Map(); // ownerId → { can, routed }
  const info = ownerId => {
    if (!cache.has(ownerId)) {
      const routed = approvals.approversFor(ownerId);
      cache.set(ownerId, { can: approvals.canDecide(user, ownerId), routed });
    }
    return cache.get(ownerId);
  };
  return rows.filter(r => info(r.user_id).can).map(r => {
    const { routed } = info(r.user_id);
    return { ...r, routed_to: routed.map(approvals.fullName), mine: routed.some(a => a.id === user.id) };
  });
}

/** Ile wniosków czeka na decyzję właśnie tej osoby (licznik w menu) */
const pendingCount = user => visible(user, FILTERS.pending, null).filter(r => r.mine).length;

router.get('/', deciders, (req, res) => {
  const filter = Object.hasOwn(FILTERS, req.query.filter) ? req.query.filter : 'pending';
  let year = null;
  if (filter !== 'pending') {
    year = req.query.year == null || req.query.year === '' ? new Date().getFullYear() : Number(req.query.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw badRequest('Nieprawidłowy rok.');
  }
  const balances = new Map();
  const requests = visible(req.user, FILTERS[filter], year).map(r => {
    const y = Number(r.date_from.slice(0, 4)), key = `${r.user_id}:${y}`;
    if (!balances.has(key)) balances.set(key, leave.balance(r.user_id, y));
    const b = balances.get(key);
    const overlaps = overlapQ.all(r.user_id, r.date_to, r.date_from);
    return {
      ...r,
      left: b ? b.left : null,  // pula wypoczynkowego w roku wniosku (czekające już odjęte)
      overlaps,                  // kto inny jest wtedy nieobecny
      substitute_away: r.substitute_id ? overlaps.find(o => o.user_id === r.substitute_id) || null : null,
    };
  });
  res.set('Cache-Control', 'no-store').json({ filter, year, today: leave.today(), requests, pending_count: pendingCount(req.user) });
});

// Decyzje: approve (czekający → zatwierdzony), reject { reason } (→ odrzucony),
// cancel { reason } (prośba o anulowanie → anulowany; zatwierdzony → anulowany przez przełożonego, powód wymagany),
// keep { reason } (prośba o anulowanie → nadal zatwierdzony)
for (const action of ['approve', 'reject', 'cancel', 'keep']) {
  router.post(`/:id/${action}`, deciders, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw notFound();
    const out = approvals.decideRequest(req.user, id, action, (req.body || {}).reason);
    audit(req.user.id, `request_${action}`, { id, owner: out.owner, from: out.from, to: out.status, reason: out.reason, self: out.self || undefined });
    res.json({ id, status: out.status });
  });
}

module.exports = router;
module.exports.pendingCount = pendingCount;
