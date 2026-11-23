// Jednorazowe tokeny w linkach (zaproszenie, reset hasła). W bazie tylko SHA-256 tokenu.
const crypto = require('node:crypto');
const db = require('./db');

const TTL = { invite: 7 * 24 * 3600e3, reset: 3600e3 };
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

const q = {
  dropUnused: db.prepare('DELETE FROM tokens WHERE user_id = ? AND kind = ? AND used_at IS NULL'),
  dropExpired: db.prepare('DELETE FROM tokens WHERE user_id = ? AND kind = ? AND used_at IS NULL AND expires_at <= ?'),
  insert: db.prepare('INSERT INTO tokens (user_id, kind, token_hash, expires_at, created_by) VALUES (?, ?, ?, ?, ?)'),
  find: db.prepare(`SELECT t.id AS token_id, t.expires_at, t.created_by,
                           u.id, u.email, u.first_name, u.last_name, u.role, u.state
                    FROM tokens t JOIN users u ON u.id = t.user_id
                    WHERE t.token_hash = ? AND t.kind = ? AND t.used_at IS NULL`),
  consume: db.prepare("UPDATE tokens SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL"),
};

/** Nowy token. Domyślnie poprzednie niewykorzystane tokeny tego rodzaju przestają działać;
    keepExisting — zostają ważne (usuwane są tylko przeterminowane), np. przy anonimowej prośbie o reset. */
function createToken(userId, kind, createdBy = null, { keepExisting = false } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TTL[kind]).toISOString();
  db.transaction(() => {
    if (keepExisting) q.dropExpired.run(userId, kind, now.toISOString());
    else q.dropUnused.run(userId, kind);
    q.insert.run(userId, kind, sha256(token), expiresAt, createdBy);
  })();
  return { token, expiresAt };
}

/** Ważny, niewykorzystany token → { token_id, expires_at, created_by, id, email, ... } albo null */
function findToken(token, kind) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const row = q.find.get(sha256(token), kind);
  return row && row.expires_at > new Date().toISOString() ? row : null;
}

/** Oznacza token jako użyty; false, jeśli ktoś zdążył go użyć wcześniej. */
const consumeToken = tokenId => q.consume.run(tokenId).changes === 1;

module.exports = { createToken, findToken, consumeToken, TTL };
