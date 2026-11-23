// Hasła, sesje użytkownika i middleware ochrony stron / API.
const crypto = require('node:crypto');
const argon2 = require('argon2');
const db = require('./db');
const { APP_HOST, TRUST_PROXY } = require('./config');

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 256;            // górna granica chroni przed bardzo długim haszowaniem
const REMEMBER_MS = 30 * 24 * 3600e3;

// ---------- hasła ----------
const hashPassword = pw => argon2.hash(pw, { type: argon2.argon2id });

// Hasz-atrapa: przy nieistniejącym koncie też liczymy argon2, żeby czas odpowiedzi nie zdradzał, czy konto istnieje
const dummyHash = hashPassword(crypto.randomBytes(16).toString('hex'));

async function verifyPassword(hash, password) {
  try {
    const ok = await argon2.verify(hash || (await dummyHash), password);
    return ok && !!hash;
  } catch {
    return false;
  }
}

function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) return `Hasło musi mieć co najmniej ${MIN_PASSWORD} znaków.`;
  if (pw.length > MAX_PASSWORD) return `Hasło może mieć najwyżej ${MAX_PASSWORD} znaków.`;
  return null;
}

// ---------- sesja ----------
const getUser = db.prepare('SELECT id, email, first_name, last_name, role, manager_id, state, weekly_digest FROM users WHERE id = ?');

/** Logowanie: nowy identyfikator sesji (ochrona przed przejęciem sesji), token CSRF, czas życia ciasteczka. */
function startSession(req, user, remember) {
  return new Promise((resolve, reject) => {
    const fill = err => {
      if (err) return reject(err);
      req.session.userId = user.id;
      req.session.csrf = crypto.randomBytes(24).toString('base64url');
      req.session.cookie.maxAge = remember ? REMEMBER_MS : null; // null = ciasteczko do zamknięcia przeglądarki
      req.session.save(e => (e ? reject(e) : resolve()));
    };
    // loadUser mógł już usunąć nieważną sesję (np. zablokowane konto w tej przeglądarce) — wtedy zakładamy nową
    if (req.session) req.session.regenerate(fill);
    else { req.sessionStore.generate(req); fill(); }
  });
}

/** req.user z bazy przy każdym żądaniu — zablokowane konto traci dostęp od razu. */
function loadUser(req, res, next) {
  const id = req.session && req.session.userId;
  if (!id) return next();
  const user = getUser.get(id);
  if (!user || user.state !== 'active') return req.session.destroy(() => next());
  req.user = user;
  next();
}

// ---------- ochrona ----------
const ALL_ROLES = ['employee', 'manager', 'admin'];

/** API: 401 bez logowania, 403 przy braku uprawnień, a dla zmian danych także zły token CSRF.
    Sprawdzane na konkretnych trasach — nieznany adres API daje 404, nie mylący błąd sesji. */
const requireApi = (roles = ALL_ROLES) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Zaloguj się ponownie.' });
  if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Brak uprawnień.' });
  if (!csrfOk(req)) return res.status(403).json({ error: 'Sesja wygasła. Odśwież stronę.' });
  next();
};

// Strony chronione → wymagane role. Inne pliki .html poza PUBLIC_PAGES nie są serwowane (domyślnie zamknięte).
const PAGE_ROLES = {
  'panel.html': ALL_ROLES,
  'admin-wnioski.html': ['manager', 'admin'],
  'admin-pracownicy.html': ['admin'],
  'admin-ustawienia.html': ['admin'],
};
const PUBLIC_PAGES = new Set(['login.html', 'rejestracja.html', 'reset-hasla.html']);

/** Adres powrotu po zalogowaniu — tylko znane strony, bez przekierowań na zewnątrz */
const safeNext = v => (typeof v === 'string' && Object.hasOwn(PAGE_ROLES, v.replace(/^\//, '')) ? v : null);

function protectPages(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  let name;
  try { name = decodeURIComponent(req.path); } catch { return res.status(400).type('text').send('Zły adres'); }
  name = name.replace(/\\/g, '/').split('/').filter(Boolean).join('/').toLowerCase();
  if (!name.endsWith('.html')) return next();

  if (PUBLIC_PAGES.has(name)) {
    if (name === 'login.html' && req.user) return res.redirect(302, '/panel.html');
    return next();
  }
  const roles = PAGE_ROLES[name];
  if (!roles) return res.status(404).type('text').send('Nie znaleziono');
  if (!req.user) return res.redirect(302, `/login.html?next=${encodeURIComponent('/' + name)}`);
  if (!roles.includes(req.user.role)) return res.redirect(302, '/panel.html');
  next();
}

/** Formularze i API zmieniające dane muszą pochodzić z tej samej strony (nagłówek Origin / Referer). */
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const source = req.get('origin') || req.get('referer');
  if (!source) return next(); // klient spoza przeglądarki; ciasteczko SameSite=Lax i tak nie przyjdzie z obcej strony
  let host;
  try { host = new URL(source).host; } catch { host = null; }
  // X-Forwarded-Host tylko za zaufanym proxy; w LAN porównujemy z Host i APP_URL
  const allowed = [APP_HOST, req.get('host'), TRUST_PROXY ? req.get('x-forwarded-host') : null].filter(Boolean);
  if (host && allowed.includes(host)) return next();
  res.status(403).type('text').send('Żądanie z innej strony zostało zablokowane.');
}

/** API zmieniające dane: nagłówek X-CSRF-Token musi pasować do sesji */
function csrfOk(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  const sent = Buffer.from(String(req.get('x-csrf-token') || ''));
  const expected = Buffer.from(String((req.session && req.session.csrf) || ''));
  return expected.length > 0 && sent.length === expected.length && crypto.timingSafeEqual(sent, expected);
}

module.exports = {
  MIN_PASSWORD, MAX_PASSWORD,
  hashPassword, verifyPassword, passwordProblem,
  getUser, startSession, loadUser,
  requireApi, protectPages, sameOrigin, safeNext,
};
