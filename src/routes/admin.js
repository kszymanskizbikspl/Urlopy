// /api/admin — ustawienia, poczta, pracownicy, zaproszenia.
const express = require('express');
const db = require('../db');
const audit = require('../audit');
const settings = require('../settings');
const mail = require('../mail');
const templates = require('../mail-templates');
const leave = require('../leave');
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
  }));
  // Zaproszeni na końcu, reszta alfabetycznie po polsku (Ł, Ś, Ż)
  users.sort((a, b) => (a.state === 'invited') - (b.state === 'invited')
    || collator.compare(a.last_name, b.last_name) || collator.compare(a.first_name, b.first_name) || collator.compare(a.email, b.email));
  res.json({ year, users });
});

// ---------- zaproszenia ----------
const ROLES = ['employee', 'manager', 'admin'];
const cleanName = v => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
const intIn = (v, min, max, label) => {
  const n = Number(v);
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

module.exports = router;
