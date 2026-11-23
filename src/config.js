// Konfiguracja z .env (docker-compose: env_file).
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === 'production';

let SESSION_SECRET = process.env.SESSION_SECRET || '';
if (SESSION_SECRET.length < 32) {
  if (isProd) throw new Error('SESSION_SECRET musi mieć co najmniej 32 znaki (np. openssl rand -hex 32)');
  console.warn('[config] brak SESSION_SECRET — losowy sekret, sesje wygasną po restarcie');
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
}

const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
let APP_HOST;
try { APP_HOST = new URL(APP_URL).host; } catch { throw new Error(`Nieprawidłowy APP_URL: ${APP_URL}`); }

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();

module.exports = { PORT, isProd, SESSION_SECRET, APP_URL, APP_HOST, ADMIN_EMAIL };
