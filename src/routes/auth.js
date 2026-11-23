// Logowanie, wylogowanie, rejestracja z zaproszenia.
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const db = require('../db');
const audit = require('../audit');
const { findToken, consumeToken } = require('../tokens');
const { sendReset, notifyPasswordChanged } = require('../accounts');
const {
  MAX_PASSWORD, hashPassword, verifyPassword, passwordProblem, getUser, startSession, safeNext,
} = require('../auth');

const router = express.Router();
const COOKIE_NAME = 'urlopy.sid';

// ---------- limity prób ----------
const WINDOW = 15 * 60e3;
const tooMany = (req, res) => res.redirect(303, '/login.html?error=limit');
const loginLimitOpts = {
  windowMs: WINDOW,
  skipSuccessfulRequests: true,                 // liczą się tylko nieudane próby
  requestWasSuccessful: (req, res) => res.locals.loginOk === true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: tooMany,
};
// Na IP: 50 nieudanych prób na 15 min — całe biuro może wychodzić z jednego publicznego IP
const loginLimitIp = rateLimit({ ...loginLimitOpts, limit: 50 });
// Na e-mail: 10 nieudanych prób na 15 min — chroni konkretne konto przed zgadywaniem hasła
const loginLimitEmail = rateLimit({
  ...loginLimitOpts,
  limit: 10,
  keyGenerator: req => 'email:' + String((req.body && req.body.email) || '').trim().toLowerCase(),
});
// Linki z zaproszeń: osobne liczniki dla podglądu i wysłania formularza, z zapasem na całe biuro za jednym IP.
// Tokeny mają 256 bitów — limit chroni tylko przed zalewaniem serwera, nie przed zgadywaniem.
const linkLimitOpts = { windowMs: WINDOW, standardHeaders: 'draft-8', legacyHeaders: false };
const inviteLimit = rateLimit({
  ...linkLimitOpts,
  limit: 200,
  handler: (req, res) => res.status(429).json({ error: 'Zbyt wiele prób. Spróbuj ponownie za kilka minut.' }),
});
const registerLimit = rateLimit({
  ...linkLimitOpts,
  limit: 100,
  handler: (req, res) => res.redirect(303,
    `/rejestracja.html?token=${encodeURIComponent(String((req.body && req.body.token) || ''))}&error=limit`),
});

// ---------- logowanie ----------
const findByEmail = db.prepare('SELECT id, password_hash, state FROM users WHERE email = ?');

router.post('/login', loginLimitIp, loginLimitEmail, async (req, res, next) => {
  try {
    const body = req.body || {};
    const email = String(body.email || '').trim();
    const password = String(body.password || '');
    const target = safeNext(body.next);

    const user = email && password.length <= MAX_PASSWORD ? findByEmail.get(email) : null;
    const hash = user && user.state === 'active' ? user.password_hash : null;
    const ok = await verifyPassword(hash, password);   // zawsze liczy hasz — ten sam czas dla istniejącego i nie
    if (!ok) {
      audit(user ? user.id : null, 'login_failed', email.slice(0, 254));
      // Ten sam komunikat niezależnie od tego, czy konto istnieje
      return res.redirect(303, '/login.html?error=1' + (target ? `&next=${encodeURIComponent(target)}` : ''));
    }
    res.locals.loginOk = true;
    await startSession(req, user, body.remember === '1');
    audit(user.id, 'login');
    res.redirect(303, target || '/panel.html');
  } catch (err) { next(err); }
});

router.post('/logout', (req, res, next) => {
  const userId = req.user && req.user.id;
  const done = () => { res.clearCookie(COOKIE_NAME, { path: '/' }); res.redirect(303, '/login.html'); };
  if (!req.session) return done();
  req.session.destroy(err => {
    if (err) return next(err);
    if (userId) audit(userId, 'logout');
    done();
  });
});

// ---------- rejestracja z zaproszenia ----------
const nameOf = db.prepare("SELECT first_name || ' ' || last_name AS name FROM users WHERE id = ?").pluck();
const allowanceFrom = db.prepare('SELECT year, days FROM allowances WHERE user_id = ? AND year >= ? ORDER BY year LIMIT 1');

const invalidInvite = t => !t || t.state !== 'invited';

// Dane do strony rejestracji (e-mail, imię, wymiar, kto zaprosił)
router.get('/api/invite', inviteLimit, (req, res) => {
  const t = findToken(req.query.token, 'invite');
  if (invalidInvite(t)) return res.status(410).json({ error: 'Link wygasł albo został już użyty.' });
  const allowance = allowanceFrom.get(t.id, new Date().getFullYear());
  res.json({
    email: t.email,
    first_name: t.first_name,
    last_name: t.last_name,
    invited_by: t.created_by ? nameOf.get(t.created_by) : null,
    expires_at: t.expires_at,
    year: allowance ? allowance.year : null,
    days: allowance ? allowance.days : null,
  });
});

const cleanName = v => String(v || '').trim().replace(/\s+/g, ' ').slice(0, 60);
const activate = db.prepare("UPDATE users SET first_name = ?, last_name = ?, password_hash = ?, state = 'active' WHERE id = ? AND state = 'invited'");

router.post('/rejestracja', registerLimit, async (req, res, next) => {
  try {
    const body = req.body || {};
    const token = String(body.token || '');
    const t = findToken(token, 'invite');
    if (invalidInvite(t)) return res.redirect(303, '/rejestracja.html?expired=1');

    const back = code => res.redirect(303, `/rejestracja.html?token=${encodeURIComponent(token)}&error=${code}`);
    const first = cleanName(body.first_name), last = cleanName(body.last_name);
    const password = String(body.password || '');
    if (!first || !last) return back('name');
    if (password.length > MAX_PASSWORD) return back('password_long');
    if (passwordProblem(password)) return back('password');
    if (body.password_confirm !== undefined && body.password_confirm !== password) return back('mismatch');

    const hash = await hashPassword(password);
    const ok = db.transaction(() => {
      if (!consumeToken(t.token_id)) return false;          // dwa kliknięcia naraz — wygrywa pierwsze
      if (activate.run(first, last, hash, t.id).changes !== 1) throw new Error('Konto nie czeka na aktywację');
      audit(t.id, 'register');
      return true;
    })();
    if (!ok) return res.redirect(303, '/rejestracja.html?expired=1');

    await startSession(req, getUser.get(t.id), false);
    res.redirect(303, '/panel.html');
  } catch (err) { next(err); }
});

// ---------- reset hasła ----------
// Prośba o link: zawsze ta sama odpowiedź (nie zdradza, czy konto istnieje).
const resetLimitIp = rateLimit({
  windowMs: WINDOW, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
  handler: (req, res) => res.redirect(303, '/reset-hasla.html?error=limit'),
});
// Na jeden adres najwyżej 3 linki na godzinę — kolejne prośby udają sukces (bez zasypywania skrzynki)
const resetLimitEmail = rateLimit({
  windowMs: 3600e3, limit: 3, standardHeaders: false, legacyHeaders: false,
  keyGenerator: req => 'reset:' + String((req.body && req.body.email) || '').trim().toLowerCase(),
  handler: (req, res) => res.redirect(303, '/reset-hasla.html?sent=1'),
});
const findActive = db.prepare("SELECT id FROM users WHERE email = ? AND state = 'active'");

router.post('/reset-hasla', resetLimitIp, resetLimitEmail, (req, res) => {
  const email = String((req.body && req.body.email) || '').trim();
  const user = email && email.length <= 254 ? findActive.get(email) : null;
  // Odpowiedź najpierw, praca potem: czas odpowiedzi nie zdradza, czy konto istnieje
  res.redirect(303, '/reset-hasla.html?sent=1');
  if (user) {
    setImmediate(() => {
      try {
        // keepExisting: anonimowa prośba nie unieważnia wcześniejszych ważnych linków (np. od administratora)
        sendReset(user.id, { keepExisting: true });
        audit(user.id, 'reset_requested');
      } catch (err) { console.error('[reset]', err); }
    });
  }
});

const invalidReset = t => !t || t.state !== 'active';

// E-mail do ukrytego pola „username” — menedżer haseł zapisze nowe hasło pod właściwym kontem
router.get('/api/reset', inviteLimit, (req, res) => {
  const t = findToken(req.query.token, 'reset');
  if (invalidReset(t)) return res.status(410).json({ error: 'Link wygasł albo został już użyty.' });
  res.json({ email: t.email });
});

const setPassword = db.prepare("UPDATE users SET password_hash = ? WHERE id = ? AND state = 'active'");

// Osobny licznik: po przekroczeniu wraca na stronę resetu (nie rejestracji) z komunikatem o limicie
const resetSetLimit = rateLimit({
  ...linkLimitOpts,
  limit: 100,
  handler: (req, res) => res.redirect(303,
    `/reset-hasla.html?token=${encodeURIComponent(String((req.body && req.body.token) || ''))}&error=limit`),
});

router.post('/reset-hasla/nowe', resetSetLimit, async (req, res, next) => {
  try {
    const body = req.body || {};
    const token = String(body.token || '');
    const t = findToken(token, 'reset');
    if (invalidReset(t)) return res.redirect(303, '/reset-hasla.html?expired=1');

    const back = code => res.redirect(303, `/reset-hasla.html?token=${encodeURIComponent(token)}&error=${code}`);
    const password = String(body.password || '');
    if (password.length > MAX_PASSWORD) return back('password_long');
    if (passwordProblem(password)) return back('password');
    if (body.password_confirm !== undefined && body.password_confirm !== password) return back('mismatch');

    const hash = await hashPassword(password);
    const ok = db.transaction(() => {
      if (!consumeToken(t.token_id)) return false;
      if (setPassword.run(hash, t.id).changes !== 1) throw new Error('Konto nieaktywne');
      // Inne tokeny resetu tej osoby też przestają działać
      db.prepare("DELETE FROM tokens WHERE user_id = ? AND kind = 'reset' AND used_at IS NULL").run(t.id);
      audit(t.id, 'password_reset');
      return true;
    })();
    if (!ok) return res.redirect(303, '/reset-hasla.html?expired=1');

    req.sessionStore.destroyUser(t.id);        // wylogowanie ze wszystkich urządzeń
    notifyPasswordChanged(t.id);
    await startSession(req, getUser.get(t.id), false);
    res.redirect(303, '/panel.html');
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.COOKIE_NAME = COOKIE_NAME;
