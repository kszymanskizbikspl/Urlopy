// Magazyn sesji express-session w tabeli `sessions` (ta sama baza SQLite).
const session = require('express-session');

const IDLE_TTL = 12 * 3600e3; // sesja bez „zapamiętaj mnie”: wygasa po 12 h bezczynności

class SqliteSessionStore extends session.Store {
  constructor(db) {
    super();
    this.q = {
      get: db.prepare('SELECT data, expires FROM sessions WHERE sid = ?'),
      set: db.prepare(`INSERT INTO sessions (sid, user_id, expires, data) VALUES (?, ?, ?, ?)
                       ON CONFLICT(sid) DO UPDATE SET user_id = excluded.user_id, expires = excluded.expires, data = excluded.data`),
      touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      destroyUser: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
      destroyUserExcept: db.prepare('DELETE FROM sessions WHERE user_id = ? AND sid <> ?'),
      prune: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
    };
    this.prune();
    setInterval(() => this.prune(), 3600e3).unref();
  }

  // Ciasteczko z datą (zapamiętaj mnie) → do tej daty; ciasteczko sesyjne → 12 h od ostatniego użycia
  expiresAt(sess) {
    const e = sess && sess.cookie && sess.cookie.expires;
    return e ? new Date(e).getTime() : Date.now() + IDLE_TTL;
  }

  get(sid, cb) {
    try {
      const row = this.q.get.get(sid);
      cb(null, row && row.expires > Date.now() ? JSON.parse(row.data) : null);
    } catch (err) { cb(err); }
  }

  set(sid, sess, cb) {
    try { this.q.set.run(sid, sess.userId ?? null, this.expiresAt(sess), JSON.stringify(sess)); cb && cb(null); }
    catch (err) { cb && cb(err); }
  }

  touch(sid, sess, cb) {
    try { this.q.touch.run(this.expiresAt(sess), sid); cb && cb(null); }
    catch (err) { cb && cb(err); }
  }

  destroy(sid, cb) {
    try { this.q.destroy.run(sid); cb && cb(null); }
    catch (err) { cb && cb(err); }
  }

  /** Wylogowanie użytkownika ze wszystkich urządzeń (np. po zmianie hasła). exceptSid — zostaw bieżącą sesję. */
  destroyUser(userId, exceptSid) {
    return (exceptSid ? this.q.destroyUserExcept.run(userId, exceptSid) : this.q.destroyUser.run(userId)).changes;
  }

  prune() { this.q.prune.run(Date.now()); }
}

module.exports = SqliteSessionStore;
