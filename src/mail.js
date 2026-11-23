// Wysyłka e-maili: kolejka w tabeli mail_queue przetwarzana w tle, z ponawianiem przy błędach SMTP.
const nodemailer = require('nodemailer');
const db = require('./db');
const settings = require('./settings');

const RETRY_MIN = [1, 5, 15, 60, 180, 360]; // po kolejnych błędach: 1 min, 5 min, ... 6 h; potem rezygnacja
const BATCH = 20;
const KEEP_DAYS = 30;

const q = {
  insert: db.prepare(`INSERT INTO mail_queue (kind, to_addr, subject, body_text, body_html, ics, next_attempt_at, expires_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  due: db.prepare(`SELECT * FROM mail_queue WHERE sent_at IS NULL AND failed_at IS NULL AND next_attempt_at <= ?
                   ORDER BY id LIMIT ${BATCH}`),
  sent: db.prepare("UPDATE mail_queue SET sent_at = datetime('now'), attempts = attempts + 1, body_text = NULL, body_html = NULL, ics = NULL, last_error = NULL WHERE id = ?"),
  retry: db.prepare('UPDATE mail_queue SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?'),
  failed: db.prepare("UPDATE mail_queue SET attempts = ?, failed_at = datetime('now'), last_error = ?, body_text = NULL, body_html = NULL, ics = NULL WHERE id = ?"),
  prune: db.prepare(`DELETE FROM mail_queue WHERE (sent_at IS NOT NULL OR failed_at IS NOT NULL)
                     AND created_at < datetime('now', '-${KEEP_DAYS} days')`),
  pending: db.prepare('SELECT COUNT(*) FROM mail_queue WHERE sent_at IS NULL AND failed_at IS NULL').pluck(),
  stillPending: db.prepare('SELECT expires_at FROM mail_queue WHERE id = ? AND sent_at IS NULL AND failed_at IS NULL'),
  supersede: db.prepare(`UPDATE mail_queue SET failed_at = datetime('now'), last_error = 'Zastąpiona nowszą wiadomością',
                           body_text = NULL, body_html = NULL, ics = NULL
                         WHERE to_addr = ? AND kind = ? AND sent_at IS NULL AND failed_at IS NULL`),
};

function transport(cfg) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure === 'tls',        // SSL/TLS od początku połączenia (zwykle port 465)
    requireTLS: cfg.secure === 'starttls',
    ignoreTLS: cfg.secure === 'none',
    auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

/** Czytelny opis błędu SMTP dla administratora (np. „535 5.7.8 Authentication failed”) */
function describe(err) {
  const parts = [err.response || err.message];
  if (err.code && !String(parts[0]).includes(err.code)) parts.push(`(${err.code})`);
  return parts.join(' ').slice(0, 500);
}

/** Wiadomość do kolejki. msg: { kind, to, subject, text, html, ics?, validMs?, supersede? }
    supersede — niewysłane wiadomości tego rodzaju do tej osoby są anulowane (np. stary link po „Wyślij ponownie”). */
function enqueue(msg) {
  const now = Date.now();
  if (msg.supersede) q.supersede.run(msg.to, msg.kind);
  q.insert.run(msg.kind, msg.to, msg.subject, msg.text, msg.html || null, msg.ics || null, now, msg.validMs ? now + msg.validMs : null);
  setImmediate(processQueue);
}

const isConfigured = () => { try { return !!settings.smtp(); } catch { return false; } };

let running = false;
let rerun = false; // ktoś dodał wiadomość w trakcie przetwarzania — po zakończeniu od razu kolejna runda
async function processQueue() {
  if (running) { rerun = true; return; }
  running = true;
  rerun = false;
  let tx;
  try {
    const due = q.due.all(Date.now());
    if (!due.length) return;
    let cfg;
    try { cfg = settings.smtp(); } catch (err) { console.warn(`[mail] ${err.message}`); return; }
    if (!cfg) return; // poczta nieustawiona — wiadomości czekają w kolejce
    tx = transport(cfg);
    for (const m of due) {
      // Stan sprawdzany tuż przed wysyłką: wiadomość mogła zostać zastąpiona („Wyślij ponownie”) w trakcie tej rundy
      const now = q.stillPending.get(m.id);
      if (!now) continue;
      if (now.expires_at && now.expires_at < Date.now()) { q.failed.run(m.attempts, 'Nieaktualna (minął termin ważności)', m.id); continue; }
      try {
        await tx.sendMail({
          from: cfg.from, to: m.to_addr, subject: m.subject, text: m.body_text, html: m.body_html || undefined,
          // urlop do kalendarza (Outlook, telefon): PUBLISH = dodaj, CANCEL = usuń wydarzenie o tym samym UID
          attachments: m.ics ? [{
            filename: 'urlop.ics', content: m.ics,
            contentType: `text/calendar; charset=utf-8; method=${/METHOD:CANCEL/.test(m.ics) ? 'CANCEL' : 'PUBLISH'}`,
          }] : undefined,
        });
        q.sent.run(m.id);
      } catch (err) {
        const attempts = m.attempts + 1, why = describe(err);
        if (attempts > RETRY_MIN.length) {
          q.failed.run(attempts, why, m.id);
          console.error(`[mail] rezygnacja: ${m.kind} do ${m.to_addr}: ${why}`);
        } else {
          q.retry.run(attempts, Date.now() + RETRY_MIN[attempts - 1] * 60e3, why, m.id);
          console.warn(`[mail] błąd (${attempts}. próba), ponowię: ${m.kind} do ${m.to_addr}: ${why}`);
        }
      }
    }
  } catch (err) {
    console.error('[mail]', err);
  } finally {
    if (tx) tx.close();
    running = false;
    if (rerun) setImmediate(processQueue);
  }
}

/** Wysyłka od razu, bez kolejki — test z Ustawień. Rzuca błąd z odpowiedzią serwera SMTP. */
async function sendNow(cfg, msg) {
  const tx = transport(cfg);
  try {
    await tx.sendMail({ from: cfg.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
  } catch (err) {
    throw Object.assign(new Error(describe(err)), { status: 502, expose: true });
  } finally {
    tx.close();
  }
}

let timer;
function start() {
  timer = setInterval(() => { processQueue(); }, 30_000);
  timer.unref();
  setInterval(() => q.prune.run(), 3600e3).unref();
  setImmediate(processQueue);
}
const stop = () => clearInterval(timer);

module.exports = { enqueue, sendNow, isConfigured, processQueue, start, stop, pendingCount: () => q.pending.get() };
