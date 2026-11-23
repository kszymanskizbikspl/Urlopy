// Zaproszenia i linki do zmiany hasła: token + e-mail w kolejce.
const db = require('./db');
const mail = require('./mail');
const templates = require('./mail-templates');
const settings = require('./settings');
const { createToken, TTL } = require('./tokens');

const q = {
  user: db.prepare('SELECT id, email, first_name, last_name, state FROM users WHERE id = ?'),
  name: db.prepare("SELECT trim(first_name || ' ' || last_name) FROM users WHERE id = ?").pluck(),
  allowance: db.prepare('SELECT year, days FROM allowances WHERE user_id = ? AND year >= ? ORDER BY year LIMIT 1'),
};

/** Wynik dla panelu admina: czy e-mail poszedł do kolejki, a jeśli poczta nie jest ustawiona — link do przekazania ręcznie */
const result = (link, extra = {}) => (mail.isConfigured() ? { mail: 'queued', ...extra } : { mail: 'smtp_missing', link, ...extra });

function sendInvite(userId, createdBy) {
  const u = q.user.get(userId);
  const { token, expiresAt } = createToken(u.id, 'invite', createdBy);
  const link = `${settings.appUrl()}/rejestracja.html?token=${token}`;
  const a = q.allowance.get(u.id, new Date().getFullYear());
  mail.enqueue({
    kind: 'invite',
    to: u.email,
    ...templates.invite({
      firstName: u.first_name,
      inviter: createdBy ? q.name.get(createdBy) : null,
      link,
      expiresAt,
      year: a && a.year,
      days: a && a.days,
    }),
    validMs: TTL.invite,
    supersede: true,
  });
  return result(link, { expires_at: expiresAt });
}

function sendReset(userId, { byAdmin = false, keepExisting = false } = {}) {
  const u = q.user.get(userId);
  const { token } = createToken(u.id, 'reset', null, { keepExisting });
  const link = `${settings.appUrl()}/reset-hasla.html?token=${token}`;
  mail.enqueue({
    kind: 'reset',
    to: u.email,
    ...templates.reset({ firstName: u.first_name, link, byAdmin }),
    validMs: TTL.reset,
    supersede: true,
  });
  return result(link);
}

function notifyPasswordChanged(userId) {
  const u = q.user.get(userId);
  mail.enqueue({
    kind: 'password_changed',
    to: u.email,
    ...templates.passwordChanged({ firstName: u.first_name, when: new Date().toISOString(), appUrl: settings.appUrl() }),
  });
}

module.exports = { sendInvite, sendReset, notifyPasswordChanged };
