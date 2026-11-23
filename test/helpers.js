// Testy: prawdziwy serwer (node src/server.js) w procesie potomnym, z pustą bazą w katalogu tymczasowym.
// Dane przygotowujemy bezpośrednio w tej samej bazie SQLite (WAL pozwala czytać i pisać równolegle z serwerem).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const argon2 = require('argon2');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'haslo-testowe-123';
let hashP = null;
const passwordHash = () => (hashP ??= argon2.hash(PASSWORD, { type: argon2.argon2id }));

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer().once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/** Uruchamia serwer i zwraca { url, db, addUser, login, setAllowance, addRequest, stop } */
async function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'urlopy-test-'));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test', TZ: 'Europe/Warsaw', PORT: String(port), DATA_DIR: dataDir, APP_URL: url,
      SESSION_SECRET: 'x'.repeat(64), SETTINGS_KEY: 'k'.repeat(64), ADMIN_EMAIL: '',
      JOBS_DISABLED: '1', // bez zadań w tle (zestawienie, kopie) — testowane osobno w jobs.test.js
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => (log += d));
  child.stderr.on('data', d => (log += d));

  // czekamy na /api/health (do 15 s)
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode != null) throw new Error('Serwer się zakończył:\n' + log);
    try { if ((await fetch(url + '/api/health')).ok) break; } catch { /* jeszcze nie słucha */ }
    if (Date.now() > deadline) { child.kill(); throw new Error('Serwer nie wystartował:\n' + log); }
    await new Promise(r => setTimeout(r, 100));
  }

  const db = new Database(path.join(dataDir, 'urlopy.sqlite'));
  db.pragma('busy_timeout = 5000');

  /** Aktywne konto (albo zaproszone: state = 'invited', bez hasła) */
  async function addUser({ email, first = 'Jan', last = 'Test', role = 'employee', state = 'active', managerId = null } = {}) {
    const hash = state === 'invited' ? null : await passwordHash();
    const r = db.prepare('INSERT INTO users (email, password_hash, first_name, last_name, role, state, manager_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(email, hash, first, last, role, state, managerId);
    return Number(r.lastInsertRowid);
  }

  const setAllowance = (userId, year, days, carry = null) =>
    db.prepare(`INSERT INTO allowances (user_id, year, days, carry_override) VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id, year) DO UPDATE SET days = excluded.days, carry_override = excluded.carry_override`).run(userId, year, days, carry);

  const addRequest = (userId, { from, to = from, days, type = 'wypoczynkowy', status = 'approved' }) =>
    db.prepare('INSERT INTO leave_requests (user_id, type, date_from, date_to, days, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, type, from, to, days, status);

  /** Zwykłe żądanie bez sesji */
  const raw = (method, p, { body, headers = {} } = {}) => fetch(url + p, {
    method, redirect: 'manual',
    headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  /** Logowanie formularzem → klient z ciasteczkiem sesji i tokenem CSRF */
  async function login(email, password = PASSWORD) {
    const r = await fetch(url + '/login', {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email, password }),
    });
    const location = r.headers.get('location');
    const cookie = (r.headers.getSetCookie() || []).map(c => c.split(';')[0]).find(c => c.startsWith('urlopy.sid='));
    if (!cookie) return { ok: false, location };
    const me = await (await raw('GET', '/api/me', { headers: { Cookie: cookie } })).json();
    const client = {
      ok: true, location, cookie, me,
      /** { status, body } — body już sparsowane z JSON */
      async req(method, p, body, { csrf = true } = {}) {
        const headers = { Cookie: cookie };
        if (csrf && method !== 'GET') headers['X-CSRF-Token'] = me.csrf;
        const res = await raw(method, p, { body, headers });
        const text = await res.text();
        let data = null; try { data = JSON.parse(text); } catch { data = text; }
        return { status: res.status, body: data };
      },
    };
    client.get = p => client.req('GET', p);
    return client;
  }

  async function stop() {
    db.close();
    if (child.exitCode == null) {
      const exited = new Promise(r => child.once('exit', r));
      child.kill('SIGTERM');
      await exited;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  return { url, db, raw, addUser, setAllowance, addRequest, login, stop, log: () => log };
}

module.exports = { startServer, PASSWORD };
