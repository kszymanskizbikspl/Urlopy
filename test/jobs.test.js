// Krok 8: zadania automatyczne — w tym samym procesie (bez serwera), z podstawianą datą i godziną.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'urlopy-jobs-'));
process.env.DATA_DIR = dataDir;
process.env.APP_URL = 'http://urlopy.test:1003';
const db = require('../src/db');
const settings = require('../src/settings');
const jobs = require('../src/jobs');
const PL = require('../public/js/holidays.js');
const Database = require('better-sqlite3');

after(() => { db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const addUser = (email, role = 'employee', state = 'active', first = 'Jan', last = 'Test') =>
  Number(db.prepare('INSERT INTO users (email, first_name, last_name, role, state, password_hash) VALUES (?, ?, ?, ?, ?, ?)')
    .run(email, first, last, role, state, 'x').lastInsertRowid);
const addReq = (userId, from, to, days, status = 'approved', type = 'wypoczynkowy') =>
  db.prepare('INSERT INTO leave_requests (user_id, type, date_from, date_to, days, status) VALUES (?, ?, ?, ?, ?, ?)').run(userId, type, from, to, days, status);
const mails = kind => db.prepare('SELECT to_addr, subject, body_text FROM mail_queue WHERE kind = ? ORDER BY id').all(kind);
const resetJobs = () => db.prepare('DELETE FROM job_runs').run();
const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min);

// Tydzień testowy: poniedziałek 2030-03-04 – niedziela 2030-03-10
const MON = at(2030, 3, 4, 7, 30);
let boss, admin, emp, emp2, off;
before(() => {
  boss = addUser('boss@test.pl', 'manager', 'active', 'Tomasz', 'Zieliński');
  admin = addUser('admin@test.pl', 'admin', 'active', 'Ada', 'Admin');
  emp = addUser('emp@test.pl', 'employee', 'active', 'Piotr', 'Nowak');
  emp2 = addUser('emp2@test.pl', 'employee', 'active', 'Ewa', 'Lis');
  off = addUser('off@test.pl', 'manager', 'disabled', 'Olek', 'Wyłączony');
});

// ---------- harmonogram ----------
test('due: lista nieobecnych w poniedziałek od 7:00, raz na tydzień, gdy włączona', () => {
  resetJobs();
  assert.ok(jobs.mondayOf(at(2030, 3, 10, 23)).getTime() === at(2030, 3, 4).getTime(), 'niedziela należy do tygodnia od poniedziałku');
  assert.ok(!jobs.due(at(2030, 3, 4, 6, 59)).includes('weekly_digest'), 'przed 7:00');
  assert.ok(jobs.due(MON).includes('weekly_digest'));
  assert.ok(!jobs.due(at(2030, 3, 5, 9)).includes('weekly_digest'), 'wtorek — nie nadrabiamy');
  settings.save({ weekly_digest: false });
  assert.ok(!jobs.due(MON).includes('weekly_digest'), 'wyłączone w ustawieniach');
  settings.save({ weekly_digest: true });
});

test('due: przypomnienie 1 lipca od 8:00, nadrabiane do 7 lipca, raz w roku', () => {
  resetJobs();
  assert.ok(!jobs.due(at(2030, 7, 1, 7, 59)).includes('carry_reminder'));
  assert.ok(jobs.due(at(2030, 7, 1, 8)).includes('carry_reminder'));
  assert.ok(jobs.due(at(2030, 7, 5, 3)).includes('carry_reminder'), 'nadrobienie po restarcie');
  assert.ok(!jobs.due(at(2030, 7, 8, 9)).includes('carry_reminder'));
  assert.ok(!jobs.due(at(2030, 6, 30, 9)).includes('carry_reminder'));
  db.prepare("INSERT INTO job_runs (name, last_key) VALUES ('carry_reminder', '2030')").run();
  assert.ok(!jobs.due(at(2030, 7, 2, 9)).includes('carry_reminder'), 'już wysłane w tym roku');
  settings.save({ carry_reminder: false });
  resetJobs();
  assert.ok(!jobs.due(at(2030, 7, 1, 9)).includes('carry_reminder'), 'wyłączone w ustawieniach');
  settings.save({ carry_reminder: true });
});

test('due: kopia codziennie od 2:00', () => {
  resetJobs();
  assert.ok(!jobs.due(at(2030, 3, 4, 1, 59)).includes('backup'));
  assert.ok(jobs.due(at(2030, 3, 4, 2)).includes('backup'));
  db.prepare("INSERT INTO job_runs (name, last_key) VALUES ('backup', '2030-03-04')").run();
  assert.ok(!jobs.due(at(2030, 3, 4, 23)).includes('backup'));
  assert.ok(jobs.due(at(2030, 3, 5, 2)).includes('backup'), 'następnego dnia znowu');
});

// ---------- zestawienie ----------
test('lista nieobecnych: tylko przełożeni i aktywni admini; tylko zatwierdzone; z dniami wolnymi w tygodniu', () => {
  resetJobs();
  addReq(emp, '2030-03-01', '2030-03-05', 3);                    // zaczął się w poprzednim tygodniu
  addReq(emp2, '2030-03-08', '2030-03-08', 1, 'cancel_requested'); // nadal zatwierdzony
  addReq(emp2, '2030-03-06', '2030-03-06', 1, 'pending');          // czekający — pomijany
  addReq(emp, '2030-03-11', '2030-03-12', 2);                      // następny tydzień — pomijany
  db.prepare("INSERT INTO company_days_off (date, name) VALUES ('2030-03-07', 'Dzień wolny testowy')").run();
  const out = jobs.weeklyDigest(MON);
  assert.deepEqual(out, { key: '2030-03-04', absent: 2, sent: 2 });
  const m = mails('weekly_digest');
  assert.deepEqual(m.map(x => x.to_addr).sort(), ['admin@test.pl', 'boss@test.pl'], 'bez pracowników i wyłączonych');
  assert.match(m[0].subject, /Nieobecni w tym tygodniu: 04\/03\/2030 – 10\/03\/2030/);
  assert.match(m[0].body_text, /Ewa Lis: 08\/03\/2030/);
  assert.match(m[0].body_text, /Piotr Nowak: 01\/03\/2030 – 05\/03\/2030/);
  assert.doesNotMatch(m[0].body_text, /06\/03\/2030/, 'bez czekających');
  assert.match(m[0].body_text, /07\/03\/2030 — Dzień wolny testowy/);
  assert.match(m[0].body_text, /http:\/\/urlopy\.test:1003\/admin-wnioski\.html/);
  assert.ok(!jobs.due(MON).includes('weekly_digest'), 'zapisane — drugi raz nie');
});

test('lista nieobecnych: przełożony, który ją wyłączył u siebie, jej nie dostaje', () => {
  resetJobs();
  db.prepare('UPDATE users SET weekly_digest = 0 WHERE id = ?').run(boss);
  try {
    const before1 = mails('weekly_digest').length;
    const out = jobs.weeklyDigest(MON);
    assert.equal(out.sent, 1);
    assert.deepEqual(mails('weekly_digest').slice(before1).map(m => m.to_addr), ['admin@test.pl']);
  } finally {
    db.prepare('UPDATE users SET weekly_digest = 1 WHERE id = ?').run(boss);
  }
});

test('lista nieobecnych: nikt nieobecny → bez e-maili, ale zapisane jako wykonane', () => {
  resetJobs();
  const before1 = mails('weekly_digest').length;
  const out = jobs.weeklyDigest(at(2031, 1, 6, 7));
  assert.equal(out.sent, 0);
  assert.equal(mails('weekly_digest').length, before1);
  assert.equal(db.prepare("SELECT info FROM job_runs WHERE name = 'weekly_digest'").pluck().get(), 'nikt nieobecny — bez e-maili');
});

// ---------- przypomnienie ----------
test('przypomnienie o zaległym: tylko osoby, którym coś zostało z zaległego', () => {
  resetJobs();
  const a = addUser('a@test.pl', 'employee', 'active', 'Anna', 'Zaległa');
  const b = addUser('b@test.pl', 'employee', 'active', 'Bartek', 'Zużył');
  const c = addUser('c@test.pl', 'employee', 'disabled', 'Celina', 'Wyłączona');
  const allow = db.prepare('INSERT INTO allowances (user_id, year, days, carry_override) VALUES (?, ?, ?, ?)');
  allow.run(a, 2032, 26, 5);
  allow.run(b, 2032, 26, 3);
  allow.run(c, 2032, 26, 4);
  addReq(a, '2032-02-02', '2032-02-03', 2);                  // zostały 3 z zaległego
  addReq(b, '2032-02-02', '2032-02-04', 3);                  // zaległy zużyty
  const out = jobs.carryReminder(at(2032, 7, 1, 8));
  assert.equal(out.sent, 1);
  const m = mails('carry_reminder');
  assert.equal(m.length, 1);
  assert.equal(m[0].to_addr, 'a@test.pl');
  assert.match(m[0].subject, /Zaległy urlop: 3 dni do zaplanowania przed 30\/09\/2032/);
  assert.match(m[0].body_text, /z 2031 r\./);
});

test('przypomnienie: urlop po 30 września nie ratuje zaległego; urlop przez 30.09 liczy się do tego dnia', () => {
  const allow = db.prepare('INSERT INTO allowances (user_id, year, days, carry_override) VALUES (?, ?, ?, ?)');
  const d = addUser('d@test.pl', 'employee', 'active', 'Dorota', 'Grudzień');
  allow.run(d, 2033, 26, 5);
  addReq(d, '2033-12-12', '2033-12-16', 5);                         // cały zaległy „zużyty” dopiero w grudniu
  assert.equal(jobs.carriedAtRisk(d, 2033), 5);
  const e = addUser('e@test.pl', 'employee', 'active', 'Emil', 'Wrzesień');
  allow.run(e, 2033, 26, 5);
  addReq(e, '2033-09-29', '2033-10-04', 4);                         // czw–pt przed terminem (2 dni), reszta po
  assert.equal(jobs.carriedAtRisk(e, 2033), 3);
  const f = addUser('f@test.pl', 'employee', 'active', 'Franek', 'Czeka');
  allow.run(f, 2033, 26, 2);
  addReq(f, '2033-08-01', '2033-08-02', 2, 'pending');              // zaplanowany (czeka) przed terminem — OK
  assert.equal(jobs.carriedAtRisk(f, 2033), 0);
});

// ---------- kopie zapasowe ----------
test('kopia: plik w data/backup, poprawna baza; stare kopie kasowane; ręczna osobno', async () => {
  resetJobs();
  fs.mkdirSync(jobs.BACKUP_DIR, { recursive: true });
  fs.writeFileSync(path.join(jobs.BACKUP_DIR, 'urlopy-2000-01-01.sqlite'), 'stara');
  fs.writeFileSync(path.join(jobs.BACKUP_DIR, 'inny-plik.txt'), 'nie ruszać');
  const now = new Date();
  const out = await jobs.backup(now);
  assert.equal(out.name, `urlopy-${PL.iso(now)}.sqlite`);
  assert.equal(out.removed, 1, 'kopia sprzed 30 dni usunięta');
  assert.ok(fs.existsSync(path.join(jobs.BACKUP_DIR, 'inny-plik.txt')), 'obce pliki zostają');
  const copy = new Database(path.join(jobs.BACKUP_DIR, out.name), { readonly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) FROM users').pluck().get(), db.prepare('SELECT COUNT(*) FROM users').pluck().get());
  copy.close();
  assert.equal(db.prepare("SELECT last_key FROM job_runs WHERE name = 'backup'").pluck().get(), PL.iso(now));

  const manual = await jobs.backup(now, { manual: true });
  assert.match(manual.name, /^urlopy-\d{4}-\d{2}-\d{2}-\d{6}-reczna\.sqlite$/);
  const list = jobs.listBackups().map(b => b.name);
  assert.ok(list.includes(out.name) && list.includes(manual.name));
  assert.ok(!list.includes('inny-plik.txt'));
});

test('kopia: ręczna w trakcie nocnej czeka i tworzy własny plik; nocna dwa razy naraz = jedna; stare .tmp sprzątane', async () => {
  resetJobs();
  fs.writeFileSync(path.join(jobs.BACKUP_DIR, 'urlopy-2030-01-01-reczna.sqlite.tmp'), 'po przerwanej kopii');
  const now = at(2030, 3, 6, 2, 0);
  const nightly = jobs.backup(now);
  const nightly2 = jobs.backup(now);
  const manual = jobs.backup(now, { manual: true });
  assert.equal(nightly2, nightly, 'druga nocna w tym samym czasie — ta sama');
  const [a, b] = await Promise.all([nightly, manual]);
  assert.equal(a.name, 'urlopy-2030-03-06.sqlite');
  assert.match(b.name, /^urlopy-2030-03-06-020000-reczna\.sqlite$/);
  // druga ręczna w tej samej sekundzie nie nadpisuje pierwszej
  const c = await jobs.backup(now, { manual: true });
  assert.equal(c.name, 'urlopy-2030-03-06-020000-2-reczna.sqlite');
  assert.deepEqual(fs.readdirSync(jobs.BACKUP_DIR).filter(n => n.endsWith('.tmp')), [], 'bez plików .tmp');
});

test('tick: wykonuje zaległe zadania raz', async () => {
  resetJobs();
  db.prepare("INSERT INTO job_runs (name, last_key) VALUES ('backup', ?)").run(PL.iso(MON)); // bez kopii w tym teście
  const first = await jobs.tick(MON);
  assert.deepEqual(first.map(x => x.name), ['weekly_digest']);
  assert.equal(db.prepare("SELECT COUNT(*) FROM audit_log WHERE action = 'job_weekly_digest'").pluck().get(), 1);
  const second = await jobs.tick(at(2030, 3, 4, 7, 31));
  assert.deepEqual(second, [], 'drugi raz nic');
});

// ostatni test — stop() jest nieodwracalny
test('stop: czeka na kopię w toku, potem nie przyjmuje nowych zadań ani kopii', async () => {
  resetJobs();
  const running = jobs.backup(at(2030, 3, 7, 2), { manual: true });
  const stopped = jobs.stop();
  await stopped;
  const out = await running;
  assert.ok(fs.existsSync(path.join(jobs.BACKUP_DIR, out.name)), 'kopia w toku dokończona przed zatrzymaniem');
  await assert.rejects(jobs.backup(new Date(), { manual: true }), /zamyka/);
  assert.deepEqual(await jobs.tick(at(2030, 3, 11, 7, 30)), [], 'tick po stop nic nie robi');
});
