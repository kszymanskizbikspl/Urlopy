// Log audytowy: kto, co, kiedy.
const db = require('./db');

const insert = db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)');

module.exports = function audit(userId, action, details = null) {
  insert.run(userId ?? null, action, details == null ? null : typeof details === 'string' ? details : JSON.stringify(details));
};
