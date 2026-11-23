-- Schemat początkowy (PLAN.md, sekcja 3).
-- Daty urlopów jako tekst 'YYYY-MM-DD' (daty lokalne, bez stref czasowych).

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,                         -- NULL dopóki nie przyjmie zaproszenia
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('employee','manager','admin')),
  manager_id INTEGER REFERENCES users(id),    -- kto zatwierdza wnioski
  state TEXT NOT NULL DEFAULT 'invited' CHECK (state IN ('invited','active','disabled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tokens (                          -- zaproszenia i reset hasła
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('invite','reset')),
  token_hash TEXT NOT NULL UNIQUE,            -- w bazie tylko SHA-256 tokenu
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX idx_tokens_user ON tokens(user_id, kind);

CREATE TABLE allowances (                      -- wymiar na rok, ustawia admin
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  days INTEGER NOT NULL CHECK (days >= 0),    -- 20 / 26 / proporcjonalnie
  carry_override INTEGER CHECK (carry_override IS NULL OR carry_override >= 0),  -- ręczna korekta zaległego (NULL = automat)
  PRIMARY KEY (user_id, year)
);

CREATE TABLE leave_requests (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('wypoczynkowy','na_zadanie','okolicznosciowy','opieka_188','sila_wyzsza','bezplatny')),
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  days INTEGER NOT NULL,                      -- dni robocze, ZAWSZE liczone przez serwer
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','cancelled','cancel_requested')),
  substitute_id INTEGER REFERENCES users(id),
  note TEXT,
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  decision_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (date_from <= date_to),
  CHECK (substr(date_from,1,4) = substr(date_to,1,4))   -- wniosek w obrębie jednego roku
);
CREATE INDEX idx_req_dates ON leave_requests(date_from, date_to);
CREATE INDEX idx_req_user ON leave_requests(user_id, status);

CREATE TABLE company_days_off (
  date TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  for_holiday TEXT                            -- święto w sobotę, za które jest ten dzień
);

CREATE TABLE settings (                       -- smtp_*, app_url, reguły
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
