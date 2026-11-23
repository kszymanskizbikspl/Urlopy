-- Kolejka e-maili: wysyłka w tle z ponawianiem, żeby awaria SMTP nie blokowała zatwierdzania ani zaproszeń.
-- Po wysłaniu treść jest czyszczona (linki z tokenami nie zostają w bazie).
CREATE TABLE mail_queue (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,                         -- invite | reset | password_changed | ...
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT,
  body_html TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,           -- ms od 1970
  expires_at INTEGER,                         -- po tym czasie nie wysyłać (np. link resetu ważny 1 h)
  sent_at TEXT,
  failed_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_mail_due ON mail_queue(sent_at, failed_at, next_attempt_at);
