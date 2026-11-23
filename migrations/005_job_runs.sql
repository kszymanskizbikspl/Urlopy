-- Zadania automatyczne (krok 8): kiedy i za jaki okres ostatnio wykonane — bez podwójnej wysyłki po restarcie,
-- z nadrobieniem, gdy serwer był wyłączony w chwili zadania.
CREATE TABLE job_runs (
  name TEXT PRIMARY KEY,                      -- weekly_digest | carry_reminder | backup
  last_key TEXT NOT NULL,                     -- okres: data poniedziałku, rok, dzień kopii
  ran_at TEXT NOT NULL DEFAULT (datetime('now')),
  info TEXT                                   -- krótki wynik (ile e-maili, plik kopii)
);
