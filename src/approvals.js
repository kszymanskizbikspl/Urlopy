// Akceptacja wniosków (krok 6): kto zatwierdza, kto może decydować, e-maile do przełożonego i do pracownika.
//
// Do kogo trafia wniosek (ustawienie „Kto zatwierdza wnioski”):
//   manager — przełożony z pola „Przełożony” (aktywny, rola Przełożony / Administrator), a gdy go nie ma — administratorzy;
//   admins  — administratorzy.
// Własny wniosek nigdy nie trafia do autora — chyba że to jedyny aktywny administrator (wtedy zatwierdza sam, w logu).
// Administrator może rozpatrzyć każdy wniosek oprócz własnego (np. gdy przełożony jest na urlopie).
const db = require('./db');
const mail = require('./mail');
const settings = require('./settings');
const templates = require('./mail-templates');
const leave = require('./leave');

const APPROVER_ROLES = ['manager', 'admin'];
const q = {
  user: db.prepare('SELECT id, email, first_name, last_name, role, state, manager_id FROM users WHERE id = ?'),
  admins: db.prepare("SELECT id, email, first_name, last_name, role, state FROM users WHERE role = 'admin' AND state = 'active' ORDER BY id"),
  request: db.prepare(`
    SELECT r.*, trim(u.first_name || ' ' || u.last_name) AS employee, u.first_name AS employee_first, u.email AS employee_email,
           trim(s.first_name || ' ' || s.last_name) AS substitute
    FROM leave_requests r JOIN users u ON u.id = r.user_id LEFT JOIN users s ON s.id = r.substitute_id
    WHERE r.id = ?`),
};

const fullName = u => `${u.first_name} ${u.last_name}`.trim() || u.email;

/** Osoby, do których trafia wniosek pracownika ownerId (tablica wierszy users) */
function approversFor(ownerId) {
  const owner = q.user.get(ownerId);
  if (!owner) return [];
  if (settings.getAll().approver === 'manager' && owner.manager_id) {
    const m = q.user.get(owner.manager_id);
    if (m && m.id !== owner.id && m.state === 'active' && APPROVER_ROLES.includes(m.role)) return [m];
  }
  const admins = q.admins.all();
  const others = admins.filter(a => a.id !== ownerId);
  return others.length ? others : admins; // jedyny admin — sam sobie
}

/** Czy user może rozpatrzyć wniosek pracownika ownerId */
function canDecide(user, ownerId) {
  if (user.role === 'admin' && user.id !== ownerId) return true;
  return approversFor(ownerId).some(a => a.id === user.id);
}

const appLink = page => `${settings.appUrl()}/${page}`;
const appHost = () => { try { return new URL(settings.appUrl()).host; } catch { return null; } };

/** E-maile wysyłamy po zapisaniu decyzji / wniosku. Błąd przy ich przygotowaniu nie może zamienić udanej zmiany
    w „Błąd serwera” (ponowne kliknięcie dałoby wtedy „już rozpatrzony”) — tylko zapis w logu. */
const safely = (label, fn) => (...args) => {
  try { return fn(...args); } catch (err) { console.error(`[mail] nie udało się przygotować e-maila (${label}):`, err); return 0; }
};

/** E-mail do przełożonego: nowy wniosek ('request_new'), prośba o anulowanie ('cancel_request'),
    wycofanie czekającego wniosku przez pracownika ('request_withdrawn') */
function notifyApproversUnsafe(requestId, kind) {
  const r = q.request.get(requestId);
  const to = approversFor(r.user_id).filter(a => a.id !== r.user_id); // jedyny admin sam sobie maili nie wysyła
  const b = leave.POOL.includes(r.type) ? leave.balance(r.user_id, Number(r.date_from.slice(0, 4))) : null;
  for (const a of to) {
    mail.enqueue({
      kind,
      to: a.email,
      ...templates.forApprover({
        kind, approverFirst: a.first_name, employee: r.employee, r,
        typeLabel: leave.TYPE_LABELS[r.type], left: b ? b.left : null, link: appLink('admin-wnioski.html'),
      }),
    });
  }
  return to.length;
}

/** E-mail do pracownika z decyzją (z plikiem .ics przy zatwierdzeniu i anulowaniu) */
function notifyEmployeeUnsafe(requestId, outcome, byUser, reason) {
  const r = q.request.get(requestId);
  const typeLabel = leave.TYPE_LABELS[r.type];
  const withIcs = outcome === 'approved' || outcome === 'cancelled' || outcome === 'cancel_accepted';
  // ORGANIZER (aplikacja) i ATTENDEE (pracownik) — bez nich Outlook / Gmail nie usuwają wydarzenia przy METHOD:CANCEL
  const s = settings.getAll();
  const organizer = { email: s.smtp_from || `urlopy@${appHost() || 'urlopy-zbiks'}`, name: s.smtp_from_name || 'Urlopy ZBIKS' };
  mail.enqueue({
    kind: 'decision',
    to: r.employee_email,
    ...templates.decision({ outcome, firstName: r.employee_first, r, typeLabel, by: fullName(byUser), reason, link: appLink('panel.html') }),
    ics: withIcs ? templates.ics({
      r, typeLabel, host: appHost(), cancel: outcome !== 'approved',
      organizer, attendee: { email: r.employee_email, name: r.employee },
    }) : null,
  });
}

const notifyApprovers = safely('do przełożonego', notifyApproversUnsafe);
const notifyEmployee = safely('decyzja', notifyEmployeeUnsafe);

// ---------- decyzje ----------
class DecisionError extends Error { constructor(msg, status = 409) { super(msg); this.status = status; this.expose = true; } }
const plDays = n => (n === 1 ? '1 dzień' : `${n} dni`);

const decide = db.prepare(`UPDATE leave_requests SET status = @to, decided_by = @by, decided_at = datetime('now'), decision_note = @note
                           WHERE id = @id AND status = @from`);
const laterYears = db.prepare('SELECT year FROM allowances WHERE user_id = ? AND year >= ? ORDER BY year').pluck();

/** Zatwierdzenie nie może zostawić puli na minusie — w roku wniosku ani w kolejnych (zaległy). Liczone tak, jakby
    zatwierdzono tylko ten wniosek: inne czekające nie blokują (każdy z nich przejdzie to samo sprawdzenie przy swoim
    zatwierdzeniu). Zmienia się np. po zmniejszeniu wymiaru przez admina. Rok, który już był na minusie bez tego
    wniosku, blokuje tylko wtedy, gdy wniosek go pogarsza. */
function checkPool(r) {
  if (!leave.POOL.includes(r.type)) return;
  const year = Number(r.date_from.slice(0, 4));
  if (leave.leftWith(r.user_id, year) == null) throw new DecisionError(`Pracownik nie ma ustawionej puli urlopu na ${year} r. Ustaw wymiar w „Pracownikach”.`);
  // w bazie wniosek jest jeszcze „pending”, więc used() go nie liczy — dodajemy jego dni jako extra
  const extra = { [year]: r.days };
  for (const y of laterYears.all(r.user_id, year)) {
    const before = leave.leftWith(r.user_id, y), after = leave.leftWith(r.user_id, y, extra);
    if (after < 0 && after < before) {
      throw new DecisionError(`Po zatwierdzeniu w puli na ${y} r. zabrakłoby ${plDays(-after)}. Popraw wymiar w „Pracownikach” albo odrzuć wniosek.`);
    }
  }
}

const ACTIONS = {
  // akcja: [dozwolone statusy → nowy status, czy powód wymagany, wynik e-maila]
  approve: { from: ['pending'], to: 'approved', reason: false, outcome: () => 'approved' },
  reject: { from: ['pending'], to: 'rejected', reason: true, outcome: () => 'rejected' },
  // anulowanie: zgoda na prośbę pracownika (powód opcjonalny) albo anulowanie zatwierdzonego urlopu przez przełożonego (powód wymagany)
  cancel: { from: ['cancel_requested', 'approved'], to: 'cancelled', reason: s => s === 'approved', outcome: s => (s === 'approved' ? 'cancelled' : 'cancel_accepted') },
  keep: { from: ['cancel_requested'], to: 'approved', reason: true, outcome: () => 'kept' },
};

/** Decyzja o wniosku. Zwraca { id, status, self }. Błędy: 404 (brak / brak uprawnień), 400 (powód), 409 (stan, pula). */
function decideRequest(user, requestId, action, rawReason) {
  const a = ACTIONS[action];
  const out = db.transaction(() => {
    const r = q.request.get(requestId);
    if (!r || !canDecide(user, r.user_id)) throw new DecisionError('Nie znaleziono', 404); // bez zdradzania cudzych wniosków
    if (!a.from.includes(r.status)) throw new DecisionError('Ten wniosek został już rozpatrzony albo zmienił się jego stan. Odśwież stronę.');
    if (rawReason != null && typeof rawReason !== 'string') throw new DecisionError('Nieprawidłowy powód.', 400);
    const reason = (rawReason || '').trim().slice(0, 500) || null;
    const needReason = typeof a.reason === 'function' ? a.reason(r.status) : a.reason;
    if (needReason && !reason) throw new DecisionError('Wpisz powód — pracownik zobaczy go w e-mailu.', 400);
    if (action === 'approve') checkPool(r);
    // przy odmowie anulowania pula się nie zmienia (cancel_requested liczył się jak zatwierdzony)
    const changed = decide.run({ id: r.id, from: r.status, to: a.to, by: user.id, note: reason }).changes;
    if (!changed) throw new DecisionError('Ten wniosek został już rozpatrzony. Odśwież stronę.');
    return { id: r.id, from: r.status, status: a.to, outcome: a.outcome(r.status), reason, self: r.user_id === user.id, owner: r.user_id };
  })();
  notifyEmployee(out.id, out.outcome, user, out.reason);
  return out;
}

module.exports = { approversFor, canDecide, notifyApprovers, decideRequest, fullName, DecisionError };
