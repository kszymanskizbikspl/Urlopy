// /api/admin — ustawienia, poczta, pracownicy, zaproszenia.
const express = require('express');
const db = require('../db');
const audit = require('../audit');
const settings = require('../settings');
const mail = require('../mail');
const templates = require('../mail-templates');
const leave = require('../leave');
const daysOff = require('../daysoff');
const exporter = require('../export');
const { sendInvite, sendReset } = require('../accounts');
const { requireApi } = require('../auth');

const router = express.Router();
const adminOnly = requireApi(['admin']);

const badRequest = msg => Object.assign(new Error(msg), { status: 400, expose: true });
const conflict = msg => Object.assign(new Error(msg), { status: 409, expose: true });
const notFound = () => Object.assign(new Error('Nie znaleziono'), { status: 404, expose: true });

const thisYear = () => new Date().getFullYear();
function parseYear(v) {
  const y = v == null || v === '' ? thisYear() : Number(v);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw badRequest('Nieprawidłowy rok.');
  return y;
}
const parseId = v => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw notFound(); return n; };

// ---------- ustawienia ----------
router.get('/settings', adminOnly, (req, res) => res.json(settings.forClient()));

router.put('/settings', adminOnly, (req, res) => {
  const changed = settings.save(req.body);
  audit(req.user.id, 'settings_changed', changed.join(', '));
  if (changed.some(k => k.startsWith('smtp_'))) mail.processQueue(); // czekające e-maile wychodzą od razu
  res.json(settings.forClient());
});

// Test poczty: z ustawieniami z formularza (także niezapisanymi), wysyłka od razu — błąd SMTP wraca w całości
router.post('/settings/smtp-test', adminOnly, async (req, res, next) => {
  try {
    const { to, ...form } = req.body || {};
    if (typeof to !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim())) throw badRequest('Wpisz poprawny adres, na który wysłać test.');
    const cfg = settings.smtp(form);
    if (!cfg) throw badRequest('Uzupełnij serwer SMTP i adres nadawcy.');
    const appUrl = (form.app_url && String(form.app_url).trim()) || settings.appUrl();
    await mail.sendNow(cfg, { to: to.trim(), ...templates.test({ appUrl }) });
    audit(req.user.id, 'smtp_test', to.trim());
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------- pracownicy ----------
const usersQ = db.prepare(`
  SELECT u.id, u.email, u.first_name, u.last_name, u.role, u.state, u.manager_id,
         (SELECT MAX(expires_at) FROM tokens t WHERE t.user_id = u.id AND t.kind = 'invite' AND t.used_at IS NULL) AS invite_expires_at
  FROM users u`);
const collator = new Intl.Collator('pl', { sensitivity: 'base' });
const DAY = 24 * 3600e3;

router.get('/users', adminOnly, (req, res) => {
  const year = parseYear(req.query.year);
  const now = new Date().toISOString();
  const users = usersQ.all().map(u => ({
    id: u.id,
    email: u.email,
    first_name: u.first_name,
    last_name: u.last_name,
    role: u.role,
    state: u.state,
    manager_id: u.manager_id,
    // data wysłania ostatniego zaproszenia = ważność − 7 dni
    invited_at: u.invite_expires_at ? new Date(Date.parse(u.invite_expires_at) - 7 * DAY).toISOString() : null,
    invite_expired: u.state === 'invited' && (!u.invite_expires_at || u.invite_expires_at <= now),
    balance: leave.balance(u.id, year),
    // zaległy wyliczony automatycznie także dla roku bez wymiaru (podpowiedź w oknie edycji)
    carry_auto: leave.carryAuto(u.id, year),
    first_year: leave.firstYear(u.id),   // wcześniej wymiaru nie da się ustawić (zmieniłby zaległy w kolejnych latach)
  }));
  // Zaproszeni na końcu, reszta alfabetycznie po polsku (Ł, Ś, Ż)
  users.sort((a, b) => (a.state === 'invited') - (b.state === 'invited')
    || collator.compare(a.last_name, b.last_name) || collator.compare(a.first_name, b.first_name) || collator.compare(a.email, b.email));
  res.json({ year, users });
});

// ---------- zaproszenia ----------
const ROLES = ['employee', 'manager', 'admin'];
const cleanName = v => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
// Liczba albo tekst z liczbą — bez null, '', true (Number() zamieniłby je na 0 / 1)
const toNum = v => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN);
const intIn = (v, min, max, label) => {
  const n = toNum(v);
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${label}: liczba całkowita ${min}–${max}.`);
  return n;
};
const byEmail = db.prepare('SELECT id, state FROM users WHERE email = ?');
const insertUser = db.prepare("INSERT INTO users (email, first_name, last_name, role, state) VALUES (?, ?, ?, ?, 'invited')");
const upsertAllowance = db.prepare(`INSERT INTO allowances (user_id, year, days, carry_override) VALUES (?, ?, ?, ?)
                                    ON CONFLICT(user_id, year) DO UPDATE SET days = excluded.days, carry_override = excluded.carry_override`);

router.post('/invitations', adminOnly, (req, res) => {
  const b = req.body || {};
  const email = String(b.email ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw badRequest('Nieprawidłowy adres e-mail.');
  const first = cleanName(b.first_name), last = cleanName(b.last_name);
  if (!first || !last) throw badRequest('Wpisz imię i nazwisko.');
  const role = ROLES.includes(b.role) ? b.role : 'employee';
  // Wymiar przy zaproszeniu: bieżący rok albo późniejszy (np. w grudniu dla osoby od stycznia), nigdy miniony —
  // inaczej nowa osoba nie miałaby puli na bieżący rok, a e-mail i rejestracja nie pokazałyby wymiaru
  const year = Math.max(parseYear(b.year), thisYear());
  const days = intIn(b.days, 0, 40, 'Wymiar urlopu');
  const carry = intIn(b.carry ?? 0, 0, 80, 'Zaległy urlop');

  const existing = byEmail.get(email);
  if (existing) {
    throw conflict(existing.state === 'invited'
      ? 'Ta osoba ma już zaproszenie. Użyj „Wyślij ponownie” na liście.'
      : 'Konto z tym adresem już istnieje.');
  }

  let out;
  try {
    out = db.transaction(() => {
      const id = Number(insertUser.run(email, first, last, role).lastInsertRowid);
      // Zaległy z kadr to punkt startowy (carry_override); 0 = nic do przeniesienia, liczy automat
      upsertAllowance.run(id, year, days, carry > 0 ? carry : null);
      audit(req.user.id, 'user_invited', { id, email, role, year, days, carry });
      return { id, ...sendInvite(id, req.user.id) };
    })();
  } catch (err) {
    // Dwa zaproszenia naraz (dwie karty, dwóch adminów): drugie trafia na UNIQUE(email)
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') throw conflict('Ta osoba ma już zaproszenie. Użyj „Wyślij ponownie” na liście.');
    throw err;
  }
  res.status(201).json({ ...out, year });
});

const getState = db.prepare('SELECT state FROM users WHERE id = ?').pluck();

router.post('/invitations/:id/resend', adminOnly, (req, res) => {
  const id = parseId(req.params.id);
  const state = getState.get(id);
  if (!state) throw notFound();
  if (state !== 'invited') throw conflict('Ta osoba ma już konto — zamiast zaproszenia wyślij link do zmiany hasła.');
  const out = sendInvite(id, req.user.id);
  audit(req.user.id, 'invite_resent', { id });
  res.json(out);
});

// Link do zmiany hasła wysłany przez administratora (np. ktoś nie pamięta hasła i nie ma dostępu do formularza)
router.post('/users/:id/reset-password', adminOnly, (req, res) => {
  const id = parseId(req.params.id);
  const state = getState.get(id);
  if (!state) throw notFound();
  if (state !== 'active') throw conflict(state === 'invited' ? 'Ta osoba nie założyła jeszcze konta — wyślij ponownie zaproszenie.' : 'Konto jest wyłączone.');
  const out = sendReset(id, { byAdmin: true });
  audit(req.user.id, 'reset_sent_by_admin', { id });
  res.json(out);
});

// ---------- edycja osoby: rola, konto, przełożony ----------
const userById = db.prepare('SELECT id, role, state, manager_id FROM users WHERE id = ?');
const otherActiveAdmins = db.prepare("SELECT COUNT(*) FROM users WHERE role = 'admin' AND state = 'active' AND id <> ?").pluck();
const clearSubordinates = db.prepare('UPDATE users SET manager_id = NULL WHERE manager_id = ?');
const APPROVER_ROLES = ['manager', 'admin'];

router.patch('/users/:id', adminOnly, (req, res) => {
  const id = parseId(req.params.id);
  const b = req.body || {};
  const changes = {};
  if (b.role !== undefined) {
    if (!ROLES.includes(b.role)) throw badRequest('Nieprawidłowa rola.');
    changes.role = b.role;
  }
  if (b.state !== undefined) {
    if (!['active', 'disabled'].includes(b.state)) throw badRequest('Nieprawidłowy stan konta.');
    changes.state = b.state;
  }
  if (b.manager_id !== undefined) {
    changes.manager_id = b.manager_id === null || b.manager_id === '' ? null : toNum(b.manager_id);
    if (changes.manager_id !== null && (!Number.isInteger(changes.manager_id) || changes.manager_id < 1)) throw badRequest('Nieprawidłowy przełożony.');
  }

  const out = db.transaction(() => {
    const u = userById.get(id);
    if (!u) throw notFound();
    if (u.state === 'invited') throw conflict('Ta osoba nie założyła jeszcze konta — możesz tylko wysłać ponownie zaproszenie.');

    // tylko rzeczywiste zmiany
    for (const k of Object.keys(changes)) if (changes[k] === u[k]) delete changes[k];

    if (id === req.user.id && (changes.role || changes.state)) {
      throw conflict('Nie możesz zmienić własnej roli ani wyłączyć własnego konta. Poproś o to innego administratora.');
    }
    if (changes.manager_id != null) {
      if (changes.manager_id === id) throw badRequest('Osoba nie może być swoim przełożonym.');
      const m = userById.get(changes.manager_id);
      if (!m || m.state !== 'active' || !APPROVER_ROLES.includes(m.role)) {
        throw badRequest('Przełożonym może być tylko aktywna osoba z rolą Przełożony lub Administrator.');
      }
    }

    const role = changes.role ?? u.role, state = changes.state ?? u.state;
    const wasActiveAdmin = u.role === 'admin' && u.state === 'active';
    if (wasActiveAdmin && (role !== 'admin' || state !== 'active') && otherActiveAdmins.get(id) === 0) {
      throw conflict('To ostatni aktywny administrator — najpierw nadaj tę rolę komuś innemu.');
    }

    const keys = Object.keys(changes);
    if (keys.length) {
      db.prepare(`UPDATE users SET ${keys.map(k => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...changes, id });
    }
    // Przestał zatwierdzać wnioski (rola albo wyłączone konto) → podwładni bez przełożonego (wnioski trafią do adminów)
    const wasApprover = APPROVER_ROLES.includes(u.role) && u.state === 'active';
    const isApprover = APPROVER_ROLES.includes(role) && state === 'active';
    const cleared = wasApprover && !isApprover ? clearSubordinates.run(id).changes : 0;
    if (keys.length || cleared) audit(req.user.id, 'user_updated', { id, ...changes, cleared_subordinates: cleared });
    return { cleared, disabled: changes.state === 'disabled' };
  })();

  // Wyłączone konto: usunąć jego sesje (loadUser i tak odcina dostęp przy następnym żądaniu)
  if (out.disabled) req.sessionStore.destroyUser(id);
  res.json({ ok: true, cleared_subordinates: out.cleared });
});

// ---------- wymiar urlopu ----------
const hasAllowance = db.prepare('SELECT 1 FROM allowances WHERE user_id = ? AND year = ?');

router.put('/allowances/:userId/:year', adminOnly, (req, res) => {
  const id = parseId(req.params.userId);
  const year = parseYear(req.params.year);
  const b = req.body || {};
  const days = intIn(b.days, 0, 40, 'Wymiar urlopu');
  const carry = b.carry_override == null || b.carry_override === '' ? null : intIn(b.carry_override, 0, 80, 'Zaległy urlop');
  if (!getState.get(id)) throw notFound();
  // Nowy wymiar przed pierwszym rokiem osoby przesunąłby punkt startowy i dodał zaległy, którego nigdy nie miała
  const first = leave.firstYear(id);
  if (first != null && year < first && !hasAllowance.get(id, year)) {
    throw conflict(`Pierwszy wymiar tej osoby jest na ${first} r. — wcześniejszego roku nie można dodać. Zaległy z kadr wpisz jako ręczny zaległy w ${first} r.`);
  }
  upsertAllowance.run(id, year, days, carry);
  audit(req.user.id, 'allowance_set', { id, year, days, carry_override: carry });
  res.json({ balance: leave.balance(id, year) });
});

// „Przenieś wymiary z poprzedniego roku”: ten sam wymiar, zaległy liczy automat; wyłączone konta i już ustawione wymiary pominięte
const copyAllowances = db.prepare(`
  INSERT INTO allowances (user_id, year, days, carry_override)
  SELECT a.user_id, @to, a.days, NULL FROM allowances a JOIN users u ON u.id = a.user_id
  WHERE a.year = @from AND u.state <> 'disabled'
  ON CONFLICT(user_id, year) DO NOTHING`);
// Ile aktywnych osób nadal bez wymiaru, które admin może ustawić przez „Edytuj” (zaproszeni nie mają „Edytuj”;
// rok przed pierwszym wymiarem osoby się nie liczy — tego wymiaru nie da się dodać). Ten sam warunek co baner na stronie.
const withoutAllowance = db.prepare(`
  SELECT COUNT(*) FROM users u
  WHERE u.state = 'active'
    AND NOT EXISTS (SELECT 1 FROM allowances a WHERE a.user_id = u.id AND a.year = @y)
    AND COALESCE((SELECT MIN(year) FROM allowances a WHERE a.user_id = u.id), 0) < @y`).pluck();

router.post('/allowances/copy', adminOnly, (req, res) => {
  const b = req.body || {};
  const from = parseYear(b.from), to = parseYear(b.to);
  if (to !== from + 1) throw badRequest('Wymiary można przenieść tylko z poprzedniego roku na następny.');
  const out = db.transaction(() => ({ copied: copyAllowances.run({ from, to }).changes, missing: withoutAllowance.get({ y: to }) }))();
  audit(req.user.id, 'allowances_copied', { from, to, copied: out.copied });
  res.json(out);
});

// ---------- dni wolne w firmie (krok 7) ----------
router.get('/days-off/:year', adminOnly, (req, res) => {
  res.set('Cache-Control', 'no-store').json(daysOff.get(parseYear(req.params.year)));
});

// Zapis zastępuje dni wolne roku i przelicza dni we wnioskach (czekających i zatwierdzonych, które się nie skończyły)
router.put('/days-off/:year', adminOnly, (req, res) => {
  const year = parseYear(req.params.year);
  const out = daysOff.save(year, req.body);
  audit(req.user.id, 'days_off_saved', {
    year,
    days: [...out.saturdays.filter(s => s.replacement).map(s => s.replacement), ...out.extra.map(x => x.date)],
    recalculated: out.changed.map(c => ({ id: c.id, old: c.old, days: c.days })),
    problems: out.problems.length ? out.problems : undefined,
  });
  res.json(out);
});

// ---------- eksport dla kadr (krok 7) ----------
router.get('/export', adminOnly, (req, res) => {
  const year = parseYear(req.query.year);
  const kind = req.query.kind === 'requests' ? 'requests' : 'summary';
  const csv = kind === 'requests' ? exporter.requests(year) : exporter.summary(year);
  audit(req.user.id, 'export', { kind, year });
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="urlopy-${kind === 'requests' ? 'wnioski' : 'podsumowanie'}-${year}.csv"`,
    'Cache-Control': 'no-store',
  }).send(csv);
});

module.exports = router;
