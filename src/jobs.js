// Zadania automatyczne (krok 8). Zamiast node-cron: sprawdzenie co minutę + zapis w job_runs, za jaki okres zadanie
// już się wykonało. Dzięki temu po restarcie (np. aktualizacja w poniedziałek o 7:30) zadanie wykona się z opóźnieniem
// zamiast przepaść, a nic nie wyśle się dwa razy. Czas lokalny serwera (TZ=Europe/Warsaw w Dockerfile).
//
//   weekly_digest  — poniedziałek od 7:00: do przełożonych i administratorów lista nieobecnych w tym tygodniu
//                    (ustawienie „W poniedziałek rano wysyłaj listę nieobecnych” dla wszystkich + osobisty wyłącznik
//                    users.weekly_digest; nikt nieobecny = bez e-maila)
//   carry_reminder — 1 lipca od 8:00 (nadrabiane do 7 lipca): do osób, którym zaległego urlopu nie starczy do 30.09
//                    (liczą się tylko dni urlopu do 30 września — także zaplanowane, czekające)
//   backup         — codziennie od 2:00: kopia bazy do DATA_DIR/backup, 30 dni wstecz
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const mail = require('./mail');
const settings = require('./settings');
const templates = require('./mail-templates');
const leave = require('./leave');
const audit = require('./audit');
const PL = require('../public/js/holidays.js');

const DIGEST = { weekday: 1, hour: 7 };
const REMINDER = { month: 7, day: 1, hour: 8, lastDay: 7 };
const BACKUP = { hour: 2, keepDays: 30 };
const BACKUP_DIR = path.join(db.DATA_DIR, 'backup');
const BACKUP_RE = /^urlopy-(\d{4}-\d{2}-\d{2})(-[\w-]+)?\.sqlite$/;
const RETRY_MS = 30 * 60e3; // po błędzie zadanie próbuje ponownie najwcześniej po 30 min (bez zalewania logów co minutę)

const q = {
  get: db.prepare('SELECT last_key, ran_at, info FROM job_runs WHERE name = ?'),
  all: db.prepare('SELECT name, last_key, ran_at, info FROM job_runs ORDER BY name'),
  set: db.prepare(`INSERT INTO job_runs (name, last_key, ran_at, info) VALUES (?, ?, datetime('now'), ?)
                   ON CONFLICT(name) DO UPDATE SET last_key = excluded.last_key, ran_at = excluded.ran_at, info = excluded.info`),
  // odbiorcy listy nieobecnych: aktywni przełożeni i administratorzy, którzy jej nie wyłączyli (users.weekly_digest)
  deciders: db.prepare("SELECT id, email, first_name FROM users WHERE state = 'active' AND role IN ('manager', 'admin') AND weekly_digest = 1 ORDER BY id"),
  active: db.prepare("SELECT id, email, first_name FROM users WHERE state = 'active' ORDER BY id"),
  // urlop z puli (zatwierdzony, czekający, prośba o anulowanie), który zaczyna się do terminu na zaległy
  poolUntil: db.prepare(`SELECT date_from, date_to FROM leave_requests
                         WHERE user_id = ? AND type IN ('wypoczynkowy', 'na_zadanie')
                           AND status IN ('approved', 'cancel_requested', 'pending')
                           AND date_from >= ? AND date_from <= ?`),
  absent: db.prepare(`
    SELECT trim(u.first_name || ' ' || u.last_name) AS name, r.date_from, r.date_to, r.days
    FROM leave_requests r JOIN users u ON u.id = r.user_id
    WHERE r.status IN ('approved', 'cancel_requested') AND r.days > 0 AND u.state = 'active'
      AND r.date_from <= ? AND r.date_to >= ?
    ORDER BY u.last_name, u.first_name, r.date_from`),
};

const lastKey = name => (q.get.get(name) || {}).last_key;
const appLink = page => `${settings.appUrl()}/${page}`;

/** Poniedziałek tygodnia (data lokalna) */
const mondayOf = d => PL.addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -((d.getDay() + 6) % 7));

// ---------- zestawienie tygodniowe ----------
/** Wysyła zestawienie za tydzień zawierający `now`. Zwraca { key, absent, sent } (sent = liczba e-maili). */
const weeklyDigest = db.transaction((now = new Date()) => {
  const mon = mondayOf(now), sun = PL.addDays(mon, 6);
  const from = PL.iso(mon), to = PL.iso(sun);
  const rows = q.absent.all(to, from);
  let sent = 0;
  if (rows.length) {
    const free = [];
    for (let d = mon; d <= sun; d = PL.addDays(d, 1)) {
      const iso = PL.iso(d), h = PL.holidayName(iso);
      if (h) free.push({ date: iso, name: h });
    }
    for (const [date, name] of leave.companyDaysOff(from, to)) free.push({ date, name });
    free.sort((a, b) => a.date.localeCompare(b.date));
    for (const u of q.deciders.all()) {
      mail.enqueue({ kind: 'weekly_digest', to: u.email, ...templates.weeklyDigest({ firstName: u.first_name, weekFrom: from, weekTo: to, rows, free, link: appLink('admin-wnioski.html') }) });
      sent++;
    }
  }
  const info = rows.length ? `${rows.length} nieobecnych, ${sent} e-maili` : 'nikt nieobecny — bez e-maili';
  q.set.run('weekly_digest', from, info);
  return { key: from, absent: rows.length, sent };
});

// ---------- przypomnienie o zaległym urlopie ----------
/** Ile zaległego urlopu nie zostanie wykorzystane do 30 września: zaległy minus dni urlopu (z puli) przypadające
    do 30.09 — urlop zaplanowany później zaległego nie ratuje. Zaległy zużywa się jako pierwszy (sekcja 4). */
function carriedAtRisk(userId, year) {
  const b = leave.balance(userId, year);
  if (!b || b.carried <= 0) return 0;
  const deadline = `${year}-09-30`;
  const taken = q.poolUntil.all(userId, `${year}-01-01`, deadline)
    .reduce((sum, r) => sum + leave.workingDays(r.date_from, r.date_to < deadline ? r.date_to : deadline), 0);
  return Math.max(0, b.carried - taken);
}

/** Do aktywnych osób, którym zaległego urlopu nie starczy do wykorzystania do 30 września. Zwraca { key, sent }. */
const carryReminder = db.transaction((now = new Date()) => {
  const year = now.getFullYear();
  let sent = 0;
  for (const u of q.active.all()) {
    const carriedLeft = carriedAtRisk(u.id, year);
    if (carriedLeft <= 0) continue;
    mail.enqueue({ kind: 'carry_reminder', to: u.email, ...templates.carryReminder({ firstName: u.first_name, year, carriedLeft, link: appLink('panel.html') }) });
    sent++;
  }
  q.set.run('carry_reminder', String(year), `${sent} e-maili`);
  return { key: String(year), sent };
});

// ---------- kopie zapasowe ----------
// Kopie wykonują się po kolei (kolejka): „Zrób kopię teraz” w trakcie nocnej kopii czeka na nią i robi własną.
let backupChain = Promise.resolve();
let nightlyRunning = null;   // nocna kopia w toku — drugi tick w tym czasie dostaje tę samą obietnicę
let pendingBackups = 0;      // ile kopii w kolejce / w toku (stop() na nie czeka)
let stopping = false;        // po stop(): żadnych nowych zadań ani kopii

/** Lista kopii (najnowsze pierwsze). Plik usunięty w międzyczasie (np. rsync / porządki na hoście) jest pomijany. */
function listBackups() {
  let names = [];
  try { names = fs.readdirSync(BACKUP_DIR).filter(n => BACKUP_RE.test(n)); } catch { /* katalogu jeszcze nie ma */ }
  return names.flatMap(name => {
    try {
      const st = fs.statSync(path.join(BACKUP_DIR, name));
      return [{ name, size: st.size, created_at: st.mtime.toISOString() }];
    } catch { return []; }
  }).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.name.localeCompare(a.name));
}

/** Kasuje kopie starsze niż keepDays (po dacie w nazwie pliku) */
function pruneBackups(now = new Date()) {
  const limit = PL.iso(PL.addDays(now, -BACKUP.keepDays));
  let removed = 0;
  for (const b of listBackups()) {
    const day = BACKUP_RE.exec(b.name)[1];
    if (day < limit) { fs.rmSync(path.join(BACKUP_DIR, b.name), { force: true }); removed++; }
  }
  return removed;
}

/** Jedna kopia (wywoływana z kolejki — nigdy dwie naraz) */
async function runBackup(now, manual) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  // Pliki .tmp mogą zostać tylko po przerwanej kopii (kopie idą po kolei) — sprzątamy je
  for (const n of fs.readdirSync(BACKUP_DIR)) if (/^urlopy-.*\.tmp$/.test(n)) fs.rmSync(path.join(BACKUP_DIR, n), { force: true });
  const day = PL.iso(now);
  const stamp = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  let name = manual ? `urlopy-${day}-${stamp}-reczna.sqlite` : `urlopy-${day}.sqlite`;
  // dwie ręczne kopie w tej samej sekundzie — druga nie nadpisuje pierwszej
  for (let i = 2; manual && fs.existsSync(path.join(BACKUP_DIR, name)); i++) name = `urlopy-${day}-${stamp}-${i}-reczna.sqlite`;
  const file = path.join(BACKUP_DIR, name), tmp = file + '.tmp';
  try {
    await db.backup(tmp);
    fs.renameSync(tmp, file); // plik pojawia się w całości albo wcale
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  const removed = pruneBackups(now);
  const size = fs.statSync(file).size;
  if (!manual) q.set.run('backup', day, name);
  return { name, size, removed };
}

/** Kopia bazy (spójna także w trakcie zapisu — backup API SQLite). manual = przycisk w Ustawieniach.
    Ręczna zawsze tworzy nowy plik (po zakończeniu kopii w toku); nocna w trakcie innej nocnej — ta sama obietnica. */
function backup(now = new Date(), { manual = false } = {}) {
  if (stopping) return Promise.reject(Object.assign(new Error('Serwer się zamyka — spróbuj za chwilę.'), { status: 503, expose: true }));
  if (!manual && nightlyRunning) return nightlyRunning;
  pendingBackups++;
  const p = backupChain.then(() => runBackup(now, manual)).finally(() => { pendingBackups--; });
  backupChain = p.catch(() => {});
  if (!manual) {
    nightlyRunning = p;
    p.finally(() => { if (nightlyRunning === p) nightlyRunning = null; }).catch(() => {});
  }
  return p;
}

// ---------- harmonogram ----------
const failedAt = {};
const canRetry = (name, now) => !failedAt[name] || now - failedAt[name] >= RETRY_MS;

/** Co ma się wykonać o tej porze (bez wykonywania) */
function due(now = new Date()) {
  const s = settings.getAll();
  const today = PL.iso(now), out = [];
  if (s.weekly_digest === '1' && now.getDay() === DIGEST.weekday && now.getHours() >= DIGEST.hour && lastKey('weekly_digest') !== today) out.push('weekly_digest');
  const m = now.getMonth() + 1, d = now.getDate();
  if (s.carry_reminder === '1' && m === REMINDER.month && d >= REMINDER.day && d <= REMINDER.lastDay
      && (d > REMINDER.day || now.getHours() >= REMINDER.hour) && lastKey('carry_reminder') !== String(now.getFullYear())) out.push('carry_reminder');
  if (now.getHours() >= BACKUP.hour && lastKey('backup') !== today) out.push('backup');
  return out;
}

let ticking = false;
/** Jedno sprawdzenie harmonogramu (co minutę) */
async function tick(now = new Date()) {
  if (ticking || stopping) return [];
  ticking = true;
  const done = [];
  try {
    for (const name of due(now)) {
      if (!canRetry(name, now)) continue;
      try {
        const out = name === 'weekly_digest' ? weeklyDigest(now) : name === 'carry_reminder' ? carryReminder(now) : await backup(now);
        delete failedAt[name];
        done.push({ name, ...out });
        if (name !== 'backup') audit(null, `job_${name}`, out);
      } catch (err) {
        failedAt[name] = now;
        console.error(`[jobs] ${name} nie powiódł się (ponowna próba za 30 min):`, err);
      }
    }
  } finally {
    ticking = false;
  }
  return done;
}

/** Stan zadań dla Ustawień */
function status() {
  const runs = Object.fromEntries(q.all.all().map(r => [r.name, r]));
  return { runs, backups: listBackups(), backup_dir: BACKUP_DIR, keep_days: BACKUP.keepDays };
}

let timer, firstTick;
function start() {
  if (process.env.JOBS_DISABLED === '1') return; // testy API: bez zadań w tle
  timer = setInterval(() => { tick(); }, 60e3);
  timer.unref();
  firstTick = setTimeout(() => { tick(); }, 5e3); // pierwsze sprawdzenie chwilę po starcie (nadrabianie)
  firstTick.unref();
}
/** Zatrzymanie (docker stop): bez nowych zadań i kopii; czekamy na kopie w kolejce, żeby nie zamykać bazy w ich trakcie */
function stop() {
  stopping = true;
  clearInterval(timer);
  clearTimeout(firstTick);
  return pendingBackups ? backupChain : Promise.resolve();
}

module.exports = { start, stop, tick, due, weeklyDigest, carryReminder, carriedAtRisk, backup, listBackups, pruneBackups, status, mondayOf, BACKUP_DIR };
