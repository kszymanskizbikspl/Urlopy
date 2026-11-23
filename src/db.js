// Połączenie z SQLite + proste migracje z katalogu migrations/ (pliki NNN_nazwa.sql, wykonywane po kolei raz).
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const DB_FILE = path.join(DATA_DIR, 'urlopy.sqlite');
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

function open() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
  } catch (err) {
    throw new Error(
      `Brak zapisu do katalogu danych ${DATA_DIR} (${err.code}). ` +
      'Na hoście: mkdir -p data && sudo chown 1000:1000 data'
    );
  }
  const db = new Database(DB_FILE);
  db.pragma('journal_mode = WAL');   // czytanie nie blokuje zapisu
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

function migrate(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const done = new Set(db.prepare('SELECT name FROM schema_migrations').pluck().all());
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
  const applied = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
    })();
    applied.push(file);
  }
  return applied;
}

const db = open();
const applied = migrate(db);
if (applied.length) console.log(`[db] zastosowano migracje: ${applied.join(', ')}`);

module.exports = db;
module.exports.DB_FILE = DB_FILE;
module.exports.DATA_DIR = DATA_DIR;

// `npm run migrate` — tylko migracja, bez startu serwera
if (require.main === module) {
  console.log(`[db] baza: ${DB_FILE}, migracje aktualne`);
  db.close();
}
