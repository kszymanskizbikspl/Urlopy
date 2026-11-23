-- Osobiste ustawienie: czy przełożony / administrator dostaje w poniedziałki listę nieobecnych (domyślnie tak).
-- Działa tylko, gdy wysyłka jest włączona w Ustawieniach (weekly_digest w tabeli settings).
ALTER TABLE users ADD COLUMN weekly_digest INTEGER NOT NULL DEFAULT 1 CHECK (weekly_digest IN (0, 1));
