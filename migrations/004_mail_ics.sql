-- Załącznik kalendarza (.ics) przy e-mailu z decyzją o urlopie (krok 6). Czyszczony po wysłaniu, jak treść.
ALTER TABLE mail_queue ADD COLUMN ics TEXT;
