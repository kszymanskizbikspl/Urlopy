// Pierwsze uruchomienie: brak aktywnego administratora → zaproszenie dla ADMIN_EMAIL, link w logach kontenera.
// Działa bez SMTP. Dopóki admin nie założy konta, każdy restart wypisuje nowy link (stary przestaje działać).
const db = require('./db');
const audit = require('./audit');
const { createToken } = require('./tokens');
const { APP_URL, ADMIN_EMAIL } = require('./config');

function ensureFirstAdmin() {
  if (db.prepare("SELECT 1 FROM users WHERE role = 'admin' AND state = 'active'").get()) return;

  if (!ADMIN_EMAIL) {
    console.warn('[urlopy] Brak administratora. Ustaw ADMIN_EMAIL w .env i uruchom ponownie.');
    return;
  }

  let user = db.prepare('SELECT id, role, state FROM users WHERE email = ?').get(ADMIN_EMAIL);
  if (user && user.state === 'disabled') {
    console.warn(`[urlopy] Konto ${ADMIN_EMAIL} jest zablokowane — nie tworzę zaproszenia administratora.`);
    return;
  }
  if (user && user.state === 'active') {
    // Konto już istnieje: wystarczy nadać rolę administratora
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    audit(null, 'bootstrap_admin_promoted', ADMIN_EMAIL);
    console.log(`[urlopy] ${ADMIN_EMAIL} otrzymał rolę administratora.`);
    return;
  }
  if (!user) {
    const r = db.prepare("INSERT INTO users (email, first_name, last_name, role, state) VALUES (?, '', '', 'admin', 'invited')").run(ADMIN_EMAIL);
    user = { id: r.lastInsertRowid };
    audit(null, 'bootstrap_admin_invited', ADMIN_EMAIL);
  } else {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  }

  const { token, expiresAt } = createToken(user.id, 'invite');
  console.log([
    '',
    '================================================================',
    ` Pierwszy administrator: ${ADMIN_EMAIL}`,
    ` Załóż konto (link ważny do ${new Date(expiresAt).toLocaleString('pl-PL')}):`,
    ` ${APP_URL}/rejestracja.html?token=${token}`,
    '================================================================',
    '',
  ].join('\n'));
}

module.exports = { ensureFirstAdmin };
