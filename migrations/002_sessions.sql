-- Sesje logowania (express-session). user_id pozwala usunąć wszystkie sesje użytkownika po zmianie hasła.
CREATE TABLE sessions (
  sid TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL,                   -- ms od 1970 (Date.now())
  data TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires);

-- Kto wysłał zaproszenie (pokazywane na stronie rejestracji)
ALTER TABLE tokens ADD COLUMN created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
