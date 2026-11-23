// Urlopy ZBIKS — serwer Express.
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const config = require('./config');
const db = require('./db');
const SqliteSessionStore = require('./session-store');
const { loadUser, protectPages, sameOrigin } = require('./auth');
const authRoutes = require('./routes/auth');
const meRoutes = require('./routes/me');
const adminRoutes = require('./routes/admin');
const requestRoutes = require('./routes/requests');
const mail = require('./mail');
const { ensureFirstAdmin } = require('./bootstrap');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
app.disable('x-powered-by');
// LAN bez proxy: nagłówki X-Forwarded-* ignorowane (TRUST_PROXY puste). Przy proxy: tylko od jego adresu.
app.set('trust proxy', config.TRUST_PROXY);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      // strony mają skrypty wbudowane w <script>; fonty z Google Fonts (app.css)
      'script-src': ["'self'", "'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'img-src': ["'self'", 'data:'],
      'form-action': ["'self'"],
      'upgrade-insecure-requests': null, // w LAN aplikacja działa po HTTP
    },
  },
  strictTransportSecurity: false,       // HSTS tylko przy HTTPS — włączyć razem z proxy/certyfikatem
  crossOriginOpenerPolicy: false,       // po HTTP na adresie IP przeglądarka i tak go ignoruje (z ostrzeżeniem)
  originAgentCluster: false,
  // same-origin zamiast no-referrer: przy no-referrer przeglądarka wysyła „Origin: null” w formularzach POST
  referrerPolicy: { policy: 'same-origin' },
}));

// Zasoby statyczne bez sesji (nie obciążają bazy)
for (const dir of ['css', 'js', 'img', 'vendor']) {
  app.use(`/${dir}`, express.static(path.join(PUBLIC_DIR, dir), { index: false, maxAge: '1h' }));
}

// Stan aplikacji dla Dockera / monitoringu
app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use(express.json({ limit: '100kb' }));
app.use(sameOrigin);

app.use(session({
  name: authRoutes.COOKIE_NAME,
  secret: config.SESSION_SECRET,
  store: new SqliteSessionStore(db),
  resave: false,
  saveUninitialized: false,
  rolling: true,              // „zapamiętaj mnie” = 30 dni od ostatniej wizyty
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: null },
}));
app.use(loadUser);

app.get('/', (req, res) => res.redirect(302, req.user ? '/panel.html' : '/login.html'));
app.use(authRoutes);

app.use('/api/me', meRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', requestRoutes);         // /api/me/balance, /api/me/requests, /api/requests, /api/calendar, /api/people
app.use('/api', (req, res) => res.status(404).json({ error: 'Nie znaleziono' }));

// Strony HTML: chronione według ról, bez cache (po wylogowaniu „Wstecz” nie pokaże starej strony)
app.use(protectPages);
app.use(express.static(PUBLIC_DIR, {
  index: false,
  setHeaders: (res, file) => { if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-store'); },
}));

app.use((req, res) => res.status(404).type('text').send('Nie znaleziono'));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  // expose = komunikat przeznaczony dla użytkownika (np. odpowiedź serwera SMTP przy teście poczty — kod 502)
  if (status >= 500 && !err.expose) console.error(err);
  const message = err.expose ? err.message : status >= 500 ? 'Błąd serwera' : 'Nieprawidłowe żądanie';
  if (req.path.startsWith('/api/')) return res.status(status).json({ error: message });
  res.status(status).type('text').send(message);
});

ensureFirstAdmin();
mail.start();

const server = app.listen(config.PORT, () => console.log(`[urlopy] nasłuch na porcie ${config.PORT}, baza: ${db.DB_FILE}`));

// Zamknięcie przy `docker stop` — bez tego SQLite może zostawić niezapisany WAL
function shutdown(signal) {
  console.log(`[urlopy] ${signal}, zamykanie`);
  mail.stop();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
