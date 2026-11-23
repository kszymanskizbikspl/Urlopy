// Ustawienia aplikacji (tabela settings): poczta SMTP, adres aplikacji, zasady urlopowe.
// Hasło SMTP szyfrowane AES-256-GCM kluczem z SETTINGS_KEY; nigdy nie jest odsyłane do przeglądarki.
const crypto = require('node:crypto');
const db = require('./db');
const config = require('./config');

// 32 bajty z dowolnego sekretu; bez SETTINGS_KEY aplikacja działa, ale hasła SMTP nie da się zapisać
const KEY = config.SETTINGS_KEY ? crypto.createHash('sha256').update(config.SETTINGS_KEY).digest() : null;

function encrypt(plain) {
  if (!KEY) fail('Brak SETTINGS_KEY w pliku .env — hasła SMTP nie można zapisać. Dodaj klucz (openssl rand -hex 32) i uruchom aplikację ponownie.');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

function decrypt(stored) {
  if (!KEY) return null;
  try {
    const [v, iv, tag, data] = stored.split(':');
    if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null; // inny SETTINGS_KEY niż przy zapisie
  }
}

// ---------- definicja ustawień: domyślna wartość + walidacja (zwraca wartość do zapisu albo rzuca błąd) ----------
class SettingsError extends Error { constructor(msg) { super(msg); this.status = 400; this.expose = true; } }
const fail = msg => { throw new SettingsError(msg); };

const str = (max, label) => v => {
  const s = String(v ?? '').trim();
  if (s.length > max) fail(`${label}: najwyżej ${max} znaków.`);
  if (/[\r\n]/.test(s)) fail(`${label}: niedozwolony znak nowej linii.`);
  return s;
};
const email = label => v => {
  const s = str(254, label)(v);
  if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) fail(`${label}: nieprawidłowy adres e-mail.`);
  return s;
};
const oneOf = (values, label) => v => (values.includes(String(v)) ? String(v) : fail(`${label}: niedozwolona wartość.`));
const bool = v => (v === true || v === '1' || v === 1 || v === 'on' ? '1' : '0');

const DEFS = {
  smtp_host: { def: '', check: v => { const s = str(255, 'Serwer SMTP')(v); if (/\s/.test(s)) fail('Serwer SMTP: bez spacji.'); return s; } },
  smtp_port: { def: '587', type: 'int', check: v => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 65536 ? String(n) : fail('Port: liczba 1–65535.'); } },
  smtp_secure: { def: 'starttls', check: oneOf(['starttls', 'tls', 'none'], 'Szyfrowanie') },
  smtp_user: { def: '', check: str(255, 'Login') },
  smtp_from: { def: '', check: email('Adres nadawcy') },
  smtp_from_name: { def: 'Urlopy ZBIKS', check: str(100, 'Nazwa nadawcy') },
  app_url: {
    def: '',
    check: v => {
      const s = str(255, 'Adres aplikacji')(v).replace(/\/+$/, '');
      if (!s) return s;
      let u; try { u = new URL(s); } catch { fail('Adres aplikacji: nieprawidłowy adres, np. http://192.168.88.10:1003'); }
      if (!['http:', 'https:'].includes(u.protocol)) fail('Adres aplikacji musi zaczynać się od http:// lub https://');
      return s;
    },
  },
  default_days: { def: '26', type: 'int', check: oneOf(['20', '26'], 'Wymiar dla nowych osób') },
  approver: { def: 'manager', check: oneOf(['manager', 'admins'], 'Kto zatwierdza wnioski') },
  show_absent: { def: '1', type: 'bool', check: bool },
  weekly_digest: { def: '1', type: 'bool', check: bool },
  carry_reminder: { def: '1', type: 'bool', check: bool },
};

const q = {
  all: db.prepare('SELECT key, value FROM settings'),
  get: db.prepare('SELECT value FROM settings WHERE key = ?').pluck(),
  set: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
};

/** Wszystkie ustawienia jako tekst (z domyślnymi), bez hasła SMTP */
function getAll() {
  const out = Object.fromEntries(Object.entries(DEFS).map(([k, d]) => [k, d.def]));
  for (const { key, value } of q.all.all()) if (key in DEFS) out[key] = value;
  return out;
}

/** Dla przeglądarki: typy (liczby, true/false), zamiast hasła tylko informacja, czy jest zapisane */
function forClient() {
  const raw = getAll();
  const out = {};
  for (const [k, d] of Object.entries(DEFS)) {
    out[k] = d.type === 'int' ? Number(raw[k]) : d.type === 'bool' ? raw[k] === '1' : raw[k];
  }
  out.smtp_password_set = !!q.get.get('smtp_password');
  out.settings_key_missing = !KEY;
  out.app_url_default = config.APP_URL;
  return out;
}

/** Waliduje podane pola (bez zapisu). Nieznane klucze są ignorowane. Puste smtp_password = bez zmiany. */
function validate(input) {
  const out = {};
  for (const [k, v] of Object.entries(input || {})) {
    if (k in DEFS) out[k] = DEFS[k].check(v);
  }
  if (typeof input?.smtp_password === 'string' && input.smtp_password !== '') {
    if (input.smtp_password.length > 512) fail('Hasło SMTP jest za długie.');
    out.smtp_password = input.smtp_password;
  }
  return out;
}

function save(input) {
  const values = validate(input);
  db.transaction(() => {
    for (const [k, v] of Object.entries(values)) q.set.run(k, k === 'smtp_password' ? encrypt(v) : v);
  })();
  return Object.keys(values);
}

/** Konfiguracja SMTP do wysyłki; overrides — niezapisane pola z formularza (test przed zapisem). null = poczta nieustawiona */
const SMTP_TARGET = ['smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user'];

function smtp(overrides) {
  const saved = getAll();
  const ov = overrides ? validate(overrides) : {};
  const s = { ...saved, ...ov };
  if (!s.smtp_host || !s.smtp_from) return null;
  let password = ov.smtp_password ?? null;
  if (password == null) {
    // Zapisane hasło trafia tylko do zapisanego serwera z zapisanym loginem — inaczej test z formularza
    // mógłby wysłać firmowe hasło SMTP na dowolny wpisany adres.
    if (SMTP_TARGET.some(k => k in ov && ov[k] !== saved[k])) {
      if (s.smtp_user) fail('Zmieniono serwer, port, szyfrowanie lub login — wpisz hasło SMTP, żeby wysłać test.');
      password = '';
    } else {
      const stored = q.get.get('smtp_password');
      password = stored ? decrypt(stored) : '';
      if (password === null) {
        fail(KEY
          ? 'Nie da się odczytać zapisanego hasła SMTP (zmieniono SETTINGS_KEY?). Wpisz hasło ponownie.'
          : 'Brak SETTINGS_KEY w pliku .env — nie da się odczytać hasła SMTP.');
      }
    }
  }
  return {
    host: s.smtp_host,
    port: Number(s.smtp_port),
    secure: s.smtp_secure,
    user: s.smtp_user,
    password,
    from: { name: s.smtp_from_name, address: s.smtp_from },
  };
}

/** Adres aplikacji do linków w e-mailach: z Ustawień, a gdy pusty — APP_URL z .env */
const appUrl = () => getAll().app_url || config.APP_URL;

module.exports = { getAll, forClient, save, smtp, appUrl, SettingsError };
