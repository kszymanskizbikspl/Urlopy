# Urlopy ZBIKS — plan aplikacji

Aplikacja webowa do składania i akceptowania wniosków urlopowych, uruchamiana jako kontener Docker na serwerze firmowym. **Na razie dostępna tylko w sieci LAN firmy** (bez reverse proxy i bez dostępu z internetu — patrz sekcja 8a). Punktem wyjścia były gotowe okna HTML (`public/`) z danymi przykładowymi (bloki oznaczone `MOCK`), które krok po kroku są podłączane do backendu.

Repozytorium: https://github.com/kszymanskizbikspl/Urlopy (gałąź `main`).

## 0. Stan prac (24/11/2026)

| Krok (sekcja 9, od 10 — sekcja 11) | Stan | Commit |
|---|---|---|
| 1. Szkielet Express, `public/`, migracje, Docker | ✅ zrobione | `c400ec7` |
| 2. Logowanie, sesje, ochrona stron, pierwszy admin | ✅ zrobione | `c400ec7`, poprawki `464d88b` |
| 3. SMTP + test, zaproszenia, rejestracja, reset hasła | ✅ zrobione | `2643cdc` |
| 4. Pracownicy i wymiar urlopu, kopiowanie na nowy rok, zaległy | ✅ zrobione (lista z saldem już w kroku 3) | `bcb1357` |
| 9. Testy automatyczne w repozytorium | ✅ zrobione razem z krokiem 4 | `bcb1357` |
| 5. Panel pracownika: saldo, kalendarz, wnioski | ✅ zrobione (e-maile do przełożonego przeniesione do kroku 6) | `2467afa` |
| 6. Akceptacja wniosków, e-maile z decyzją, kolizje | ✅ zrobione | `6863499` |
| 7. Dni wolne w firmie, przeliczanie wniosków, eksport CSV | ✅ zrobione | `bc75fa3` |
| 8. Zadania automatyczne, log audytowy, kopie zapasowe | ✅ zrobione | `8790f77` |
| **Etap 2** (sekcja 11) | | |
| 10. Szybkie braki: zmiana hasła, edycja danych osoby, urlop wpisany przez admina, przypomnienie o czekających | ⬜ do zrobienia | — |
| 11. Telefon (PWA) i dostęp z internetu (VPS + WireGuard + HTTPS) | ⬜ do zrobienia | — |
| 12. Kalendarz zespołu, inne nieobecności (L4, delegacja…), okresy zablokowane | ⬜ do zrobienia | — |
| 13. Kadry: wymiar proporcjonalny, eksport XLSX z miesiącami | ⬜ do zrobienia | — |
| 14. Plan urlopów na rok | ⬜ do zrobienia | — |
| 15. RODO: anonimizacja byłych pracowników po 3 latach | ⬜ do zrobienia | — |
| 16. Keycloak: wdrożenie i logowanie kontem ZBIKS | ⬜ do zrobienia | — |

**Strony — co działa na prawdziwych danych, a co jest jeszcze `MOCK`:**

| Strona | Stan |
|---|---|
| `login.html` | ✅ logowanie, „zapamiętaj mnie”, powrót na stronę po zalogowaniu, komunikat o limicie prób |
| `rejestracja.html` | ✅ dane z zaproszenia (`/api/invite`), zakładanie konta |
| `reset-hasla.html` | ✅ prośba o link, ustawienie nowego hasła, wygasły link |
| `admin-ustawienia.html` | ✅ Poczta wychodząca, ✅ Zasady urlopowe, ✅ Dni wolne w firmie (dzień za święto w sobotę, inne dni wolne, lista przeliczonych wniosków), ✅ Zadania automatyczne i kopie zapasowe (ostatnie wykonanie, lista kopii, „Zrób kopię teraz”), ✅ Log zdarzeń (filtr, „Pokaż starsze”) |
| `admin-pracownicy.html` | ✅ lista z saldem, zaproszenia, „Wyślij ponownie”, link do zmiany hasła, edycja osoby (wymiar, ręczny zaległy, rola, przełożony, konto aktywne), „Przenieś wymiary z poprzedniego roku”, eksport CSV (podsumowanie, zatwierdzone wnioski) |
| `panel.html` | ✅ nagłówek, saldo (z zaległym i limitem „na żądanie”), kalendarz z dniami wolnymi firmy, podgląd wniosku (dni, saldo po akceptacji, limity, kolizje, kto ma wtedy urlop), składanie, wycofywanie, prośba o anulowanie, decyzje i uwagi przełożonego na liście |
| `admin-wnioski.html` | ✅ do rozpatrzenia (z prośbami o anulowanie), zatwierdzone / odrzucone / anulowane / wszystkie z wyborem roku, zatwierdzanie, odrzucanie z powodem, zgoda lub odmowa anulowania, anulowanie zatwierdzonego urlopu z powodem, ostrzeżenia o kolizjach (zastępca, inni nieobecni, termin w przeszłości) |
| menu „Wnioski” (wszystkie strony) | ✅ licznik wniosków czekających na decyzję zalogowanej osoby (`pending_count` w `/api/me`) |

**Decyzje podjęte w trakcie (zmiany względem pierwotnego planu):**

- Hasło min. **8** znaków (zamiast 12).
- **Tylko LAN, bez reverse proxy** — `trust proxy` wyłączone, Pangolin przeniesiony na później (sekcja 8a).
- Limit nieudanych logowań: **10 na e-mail i 50 na IP** w 15 min.
- **Daty `dd/mm/rrrr`** wszędzie (strony, e-maile), pola daty z kalendarzem flatpickr (sekcja 1).
- Rejestracja z zaproszenia zrobiona już w kroku 2 — bez niej pierwszy admin nie mógłby się zalogować.
- Lista pracowników z saldem (`leave.js`) zrobiona w kroku 3 zamiast 4 — przy przykładowej liście przycisk „Wyślij ponownie” mógłby trafić w prawdziwe konto o tym samym id.
- `SETTINGS_KEY` nie jest wymagany do startu — bez niego zablokowany jest tylko zapis hasła SMTP.
- Zapisane hasło SMTP jest używane w teście wysyłki tylko z zapisanym serwerem, portem, szyfrowaniem i loginem.
- Zaproszenie zawsze tworzy wymiar na bieżący (lub późniejszy) rok, nawet gdy lista jest przełączona na rok miniony.
- Przełożony traci rolę (zostaje „Pracownikiem”) albo jego konto zostaje wyłączone → podwładnym czyścimy `manager_id`, a admin dostaje ostrzeżenie z liczbą osób. Ich wnioski trafią do administratorów (krok 6).
- Admin nie zmienia własnej roli ani nie wyłącza własnego konta (robi to inny admin). Dodatkowo w transakcji: zawsze zostaje co najmniej jeden aktywny admin.
- Zaproszonych (bez konta) się nie edytuje — mają tylko „Wyślij ponownie”.
- „Przenieś wymiary”: kopiuje tylko `days` z roku poprzedniego (zaległy liczy automat, bez `carry_override`), pomija wyłączone konta i już ustawione wymiary. Osobom bez wymiaru w poprzednim roku admin ustawia go przez „Edytuj” (działa też dla roku bez wymiaru — wymiar powstaje tylko, gdy admin wpisze liczbę dni; sama zmiana roli czy przełożonego go nie tworzy).
- Wymiaru na rok **przed** pierwszym wymiarem osoby nie da się dodać (409) — przesunąłby punkt startowy i dodał zaległy, którego nigdy nie było. Zaległy z kadr wpisuje się jako ręczny zaległy w pierwszym roku. Baner „Przenieś wymiary” i licznik `missing` liczą tylko aktywne konta, którym da się ustawić wymiar.
- Testy bez Mailpit na razie — bez SMTP API zwraca link (`smtp_missing`), co wystarcza; Mailpit dojdzie przy e-mailach z decyzją (krok 6).
- **Wnioski na dowolne daty** (także wstecz), ale tylko na rok poprzedni, bieżący albo następny i w obrębie jednego roku. Przy dacie w przeszłości panel tylko ostrzega; przełożony i tak zatwierdza.
- Wycofanie: wniosek czekający → `cancelled` od razu; zatwierdzony, który się jeszcze nie zaczął → `cancel_requested` (do decyzji przełożonego urlop nadal się liczy); zatwierdzony, który już trwa albo minął → tylko przez przełożonego.
- **Zaległy a kolejne lata:** wniosek z puli sprawdzany jest „w najgorszym wypadku” (`leave.safeLeft` — czekające wnioski z wcześniejszych lat liczone jak zatwierdzone). Wniosek na rok Y nie przejdzie, jeśli przez niego w którymś kolejnym roku z ustawioną pulą zabrakłoby dni na urlop już zatwierdzony lub czekający (rok już wcześniej na minusie nie blokuje wniosków, które go nie pogarszają). Panel liczy podgląd z tego samego salda (`available` w `/api/me/balance`). Zatwierdzanie (krok 6) też sprawdza pulę w transakcji (rok wniosku i kolejne), ale liczy **tak, jakby zatwierdzono tylko ten wniosek** (`leave.leftWith` — zatwierdzone + ten jeden): inne czekające go nie blokują, bo każdy przejdzie to samo sprawdzenie przy swoim zatwierdzeniu. Np. po zmniejszeniu wymiaru przez admina zatwierdzenie, które nie mieści się w puli, jest blokowane z komunikatem; odrzucić można.
- Limity „na żądanie” / opieka / siła wyższa liczą wnioski `pending` + `approved` + `cancel_requested`. „Na żądanie” zmniejsza też pulę wypoczynkowego.
- „Kto ma wtedy urlop” (ustawienie `show_absent`): tylko zatwierdzone urlopy aktywnych osób, samo imię, nazwisko i termin — bez rodzaju urlopu i uwag.
- E-maile „Nowy wniosek” i „Prośba o anulowanie” przeniesione do kroku 6 — razem ze stroną akceptacji, do której mają prowadzić.
- **Kto zatwierdza (krok 6):** przy ustawieniu „Przełożony” — aktywny przełożony z pola „Przełożony” (rola Przełożony/Administrator), a gdy go nie ma — wszyscy aktywni administratorzy; przy „Każdy administrator” — administratorzy. E-mail idzie tylko do tych osób. **Administrator może rozpatrzyć każdy wniosek oprócz własnego** (np. gdy przełożony jest na urlopie) — na liście widzi „czeka na: …”. Własny wniosek admina trafia do innych adminów; **jedyny administrator zatwierdza sam** (bez e-maila do siebie, w logu `self: true`). Przełożony widzi tylko wnioski osób, które do niego trafiają.
- Decyzje: odrzucenie, odmowa anulowania i anulowanie zatwierdzonego urlopu przez przełożonego (także trwającego) — **z obowiązkowym powodem** w e-mailu; zgoda na prośbę pracownika o anulowanie — bez powodu. Czekającego wniosku przełożony nie „anuluje”, tylko odrzuca.
- E-mail z decyzją: przy zatwierdzeniu załącznik `urlop.ics` (całodniowe wydarzenie), przy anulowaniu `.ics` z `METHOD:CANCEL`, tym samym UID i wyższym `SEQUENCE`. Oba z `ORGANIZER` (adres nadawcy z Ustawień) i `ATTENDEE` (pracownik) — bez tego Outlook/Gmail nie usuwają wydarzenia przy CANCEL. Treść i `.ics` kasowane z kolejki po wysłaniu (migracja `004_mail_ics.sql`). Warto raz sprawdzić na prawdziwym Outlooku, czy anulowanie usuwa urlop z kalendarza.
- Pracownik wycofuje czekający wniosek → przełożony dostaje krótki e-mail „Wniosek wycofany” (żeby link z „Nowy wniosek” nie prowadził donikąd bez wyjaśnienia).
- Błąd przy przygotowaniu e-maila nie psuje udanej decyzji ani wniosku (zapis już jest) — tylko wpis w logu serwera.
- Daty `created_at` / `decided_at` są w bazie w UTC (`datetime('now')`); strony pokazują je jako datę lokalną (`localDate` w `js/ui.js`).

**Jak to było testowane:** każdy krok sprawdzony w kontenerze Docker (`NODE_ENV=production`) skryptami curl/Python, e-maile przez testowy serwer Mailpit; kalendarz dat w jsdom. Dwa przeglądy kodu (`/code-review`) — wszystkie uwagi poprawione. **Od kroku 4 testy są w repozytorium** (`test/`, `node --test`): każdy plik uruchamia prawdziwy serwer z pustą bazą w katalogu tymczasowym i przygotowuje dane bezpośrednio w SQLite. Uruchomienie (bez Node.js na komputerze): `docker compose -f docker-compose.test.yml up --build --exit-code-from tests`. Nowa logika = nowe testy w `test/`.

**Środowisko deweloperskie:** na komputerze nie ma Node.js — zależności (`npm install`) i budowanie idą przez Docker. Dysk `P:` to udział sieciowy, którego Docker Desktop nie montuje, więc lokalnie kontener działa bez wolumenu `./data` (dane znikają po usunięciu kontenera). Push na GitHub — z VS Code albo po ustawieniu `git config --global credential.helper manager`.

## 1. Stos technologiczny

| Warstwa | Wybór | Dlaczego | Stan |
|---|---|---|---|
| Backend | Node.js 22 LTS + Express 5 | ten sam JavaScript co w przeglądarce, plik `holidays.js` działa po obu stronach | ✅ |
| Baza | SQLite (`better-sqlite3`) w wolumenie Dockera | kilkanaście osób, zero administracji, kopia = jeden plik | ✅ |
| Hasła | `argon2` (argon2id) | obecny standard haszowania haseł | ✅ |
| Sesje | `express-session` + własny magazyn w SQLite (`src/session-store.js`) | ciasteczko httpOnly, „zapamiętaj mnie” = dłuższy `maxAge`, wylogowanie ze wszystkich urządzeń | ✅ |
| Poczta | `nodemailer` + kolejka `mail_queue` | SMTP z ustawień w panelu | ✅ |
| Bezpieczeństwo | `helmet`, `express-rate-limit`, Origin + token CSRF | ochrona logowania i formularzy | ✅ |
| Kalendarz w polach daty | flatpickr 4.6.13 (pliki w `public/vendor`) | `dd/mm/rrrr` niezależnie od języka przeglądarki, działa bez internetu | ✅ |
| Zadania cykliczne | własny harmonogram (`src/jobs.js`) zamiast `node-cron` | co minutę sprawdza, co jest do zrobienia, i zapisuje w `job_runs`, za jaki okres już wykonał: po restarcie nadrabia, nigdy nie wysyła dwa razy; bez nowej zależności | ✅ |

**Daty:** wszędzie, gdzie widzi je użytkownik (strony, e-maile), format europejski `dd/mm/rrrr` (`fmtDate` / `fmtNice` w `js/ui.js`, `fmtDateTime` w `src/mail-templates.js`). Pola wyboru daty to `<input type="text" data-date>` z kalendarzem flatpickr (`public/vendor/flatpickr`, bez internetu) — pokazują `dd/mm/rrrr` niezależnie od języka przeglądarki. W kodzie, API i bazie daty zawsze jako `rrrr-mm-dd`.

Frontend zostaje jako zwykłe pliki HTML/CSS/JS serwowane statycznie przez Express. Strony pobierają dane z `/api/...` (fetch), a logowanie, rejestracja i reset hasła to klasyczne formularze POST z przekierowaniem.

## 2. Struktura projektu

Stan faktyczny (⬜ = jeszcze nie ma):

```
urlopy/
├─ public/
│  ├─ css/app.css
│  ├─ img/logo-zbiks.png
│  ├─ js/holidays.js       ← święta + dni robocze (współdzielone z serwerem)
│  ├─ js/calendar.js       ← komponent kalendarza
│  ├─ js/ui.js             ← formatowanie dat dd/mm/rrrr, pola daty (flatpickr)
│  ├─ js/session.js        ← strony po zalogowaniu: /api/me, menu według roli, api() z tokenem CSRF
│  ├─ vendor/flatpickr/    ← kalendarz w polach daty (MIT), bez CDN
│  ├─ login.html  rejestracja.html  reset-hasla.html
│  ├─ panel.html
│  └─ admin-wnioski.html  admin-pracownicy.html  admin-ustawienia.html
├─ src/
│  ├─ server.js            ← Express, helmet, sesje, kolejność middleware, obsługa błędów
│  ├─ config.js            ← zmienne z .env (SESSION_SECRET, SETTINGS_KEY, APP_URL, ADMIN_EMAIL, TRUST_PROXY)
│  ├─ db.js                ← połączenie + migracje (tabela schema_migrations)
│  ├─ auth.js              ← hasła (argon2), sesja, ochrona stron i API, Origin, CSRF
│  ├─ session-store.js     ← magazyn sesji w SQLite (z user_id → wylogowanie ze wszystkich urządzeń)
│  ├─ tokens.js            ← jednorazowe tokeny zaproszeń i resetu (w bazie tylko SHA-256)
│  ├─ accounts.js          ← zaproszenie / reset / „hasło zmienione” → token + e-mail
│  ├─ settings.js          ← ustawienia, walidacja, szyfrowanie hasła SMTP
│  ├─ mail.js              ← kolejka e-maili, wysyłka, ponowienia
│  ├─ mail-templates.js    ← treści e-maili
│  ├─ leave.js             ← saldo, zaległy urlop, dni robocze (holidays.js), walidacja i zapis wniosku
│  ├─ approvals.js         ← kto zatwierdza, decyzje, e-maile o wnioskach
│  ├─ daysoff.js           ← dni wolne w firmie: walidacja, zapis roku, przeliczanie wniosków
│  ├─ export.js            ← CSV dla kadr (średnik, UTF-8 z BOM)
│  ├─ audit.js             ← log audytowy
│  ├─ bootstrap.js         ← pierwszy admin z ADMIN_EMAIL
│  ├─ jobs.js              ← zadania automatyczne: lista nieobecnych, przypomnienie o zaległym, nocna kopia bazy
│  └─ routes/ auth.js (login, logout, rejestracja, reset)  me.js  admin.js  requests.js (API pracownika)  approvals.js (akceptacja)
├─ migrations/001_init.sql  002_sessions.sql  003_mail_queue.sql  004_mail_ics.sql  005_job_runs.sql  006_user_weekly_digest.sql
├─ test/                   ← node --test: helpers.js (serwer + baza testowa), auth, leave, admin-users
├─ Dockerfile              ← etapy: deps → test (tylko testy) → obraz docelowy
├─ docker-compose.yml  docker-compose.test.yml  .env.example  .gitattributes
└─ PLAN.md
```

## 3. Model danych

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,                         -- NULL dopóki nie przyjmie zaproszenia
  first_name TEXT NOT NULL, last_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('employee','manager','admin')),
  manager_id INTEGER REFERENCES users(id),    -- kto zatwierdza wnioski
  state TEXT NOT NULL DEFAULT 'invited' CHECK (state IN ('invited','active','disabled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tokens (                          -- zaproszenia i reset hasła
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('invite','reset')),
  token_hash TEXT NOT NULL UNIQUE,            -- w bazie tylko SHA-256 tokenu
  expires_at TEXT NOT NULL, used_at TEXT
);

CREATE TABLE allowances (                      -- wymiar na rok, ustawia admin
  user_id INTEGER NOT NULL REFERENCES users(id),
  year INTEGER NOT NULL,
  days INTEGER NOT NULL,                       -- 20 / 26 / proporcjonalnie
  carry_override INTEGER,                      -- ręczna korekta zaległego (NULL = automat)
  PRIMARY KEY (user_id, year)
);

CREATE TABLE leave_requests (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,          -- wypoczynkowy | na_zadanie | okolicznosciowy | opieka_188 | sila_wyzsza | bezplatny
  date_from TEXT NOT NULL, date_to TEXT NOT NULL,
  days INTEGER NOT NULL,       -- dni robocze, ZAWSZE liczone przez serwer
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','cancelled','cancel_requested')),
  substitute_id INTEGER REFERENCES users(id),
  note TEXT,
  decided_by INTEGER REFERENCES users(id), decided_at TEXT, decision_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (substr(date_from,1,4) = substr(date_to,1,4))   -- wniosek w obrębie jednego roku
);
CREATE INDEX idx_req_dates ON leave_requests(date_from, date_to);

CREATE TABLE company_days_off (date TEXT PRIMARY KEY, name TEXT NOT NULL, for_holiday TEXT);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- smtp_*, app_url, reguły
CREATE TABLE audit_log (id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT, details TEXT,
                        created_at TEXT DEFAULT (datetime('now')));
```

Hasło SMTP w tabeli `settings` szyfrować (AES-256-GCM, klucz z `SETTINGS_KEY` w `.env`), nigdy nie odsyłać go do przeglądarki. ✅

**Zrobione w migracjach** (pełny schemat w `migrations/`):
- `001_init.sql` — tabele jak wyżej, z dodatkowymi zabezpieczeniami: dozwolone typy wniosków (`CHECK`), `date_from <= date_to`, `days >= 0`, kaskadowe usuwanie tokenów i wymiarów, indeksy.
- `002_sessions.sql` — tabela `sessions` (sesje logowania z `user_id`), kolumna `tokens.created_by` (kto wysłał zaproszenie, `ON DELETE SET NULL`).
- `003_mail_queue.sql` — tabela `mail_queue` (kolejka e-maili, sekcja 6).
- Każda migracja wykonuje się raz (tabela `schema_migrations`); nowe zmiany = nowy plik `004_…sql`, nie edycja starych.

## 4. Reguły urlopowe

**Liczenie dni.** Urlop liczony w dniach roboczych: od pon. do pt., bez świąt ustawowych (`holidays.js`, w tym Wigilia od 2025 r.) i bez `company_days_off`. Serwer przelicza dni sam, wartości z przeglądarki ignoruje.

**Przenoszenie zaległego urlopu (bez zadania „zamknięcia roku”).** Zaległy urlop jest wyliczany na bieżąco, rekurencyjnie:

```
zalegly(Y) = carry_override(Y) ?? max(0, wymiar(Y-1) + zalegly(Y-1) - wykorzystane(Y-1))
saldo(Y)   = wymiar(Y) + zalegly(Y) - wykorzystane(Y) - oczekujace(Y)
```

✅ Zaimplementowane w `src/leave.js` (`balance`, `carryAuto`) i używane na liście pracowników. `wykorzystane` to zatwierdzone wnioski typu `wypoczynkowy` i `na_zadanie` (także `cancel_requested` — dopóki przełożony nie zgodzi się na anulowanie). Dzięki temu nic nie trzeba uruchamiać 1 stycznia, a korekta wniosku z zeszłego roku sama przelicza saldo na bieżący. Dla osób już zatrudnionych admin przy zaproszeniu wpisuje zaległy z kadr jako `carry_override` (to punkt startowy). Niewykorzystany zaległy przechodzi dalej także po 30 września, bo roszczenie przedawnia się dopiero po 3 latach; aplikacja tylko ostrzega.

**Kolejność zużycia.** Najpierw pula zaległa, potem bieżąca (pokazywane pracownikowi przy składaniu wniosku).

**Limity.** Na żądanie: 4 dni w roku, w ramach puli wypoczynkowego, można złożyć w dniu urlopu. Opieka nad dzieckiem (art. 188): 2 dni. Siła wyższa (art. 148¹): 2 dni. Okolicznościowy i bezpłatny poza pulą.

**Walidacja przy POST /api/requests.** Data od ≤ do, ten sam rok, co najmniej 1 dzień roboczy, brak nakładania z własnym wnioskiem `pending`/`approved`, saldo ≥ dni (z uwzględnieniem oczekujących), limit typu. Zatwierdzanie w transakcji, żeby dwa równoległe wnioski nie przekroczyły salda.

**Święto w sobotę.** Admin wyznacza w ustawieniach dzień wolny w zamian, trafia on do `company_days_off`. Po zmianie dni wolnych serwer przelicza `days` dla wniosków `pending` i przyszłych `approved`.
✅ Zrobione w kroku 7: zapis roku zastępuje wszystkie jego dni wolne i w tej samej transakcji przelicza wnioski `pending` oraz `approved` / `cancel_requested`, które się jeszcze nie skończyły (`date_to >= dziś`); zakończonych nie zmienia (rozliczona historia). Dzień wolny musi być dniem roboczym w tym samym roku; dzień w zamian za sobotę może zostać niewyznaczony (strona ostrzega). Admin dostaje listę przeliczonych wniosków i **skutki przeliczenia** (`problems`): pula na minusie w roku zapisu **i w kolejnych latach** (mniejszy zaległy) oraz przekroczone limity (na żądanie / opieka / siła wyższa) — tylko to, co przeliczenie pogorszyło. Pracownik nie dostaje e-maila o przeliczeniu — zmianę widzi w panelu. Wniosek, który cały wypadł na nowe dni wolne, ma 0 dni: zostaje (bez automatycznego anulowania), jest wyraźnie oznaczony na liście po zapisie, **nie da się go zatwierdzić** (odrzucić / anulować — tak) i nie trafia do eksportu. Strona zawsze wczytuje rok od nowa przy zmianie roku (PUT zastępuje cały rok — stary stan nie nadpisze zmian innego admina); w trakcie wczytywania formularz jest pusty i zablokowany.

Zasady oparte na Kodeksie pracy; warto potwierdzić szczegóły (np. wymiar dla niepełnego etatu, urlop proporcjonalny przy zatrudnieniu w trakcie roku) z osobą prowadzącą kadry.

## 5. Logowanie i zgodność z menedżerami haseł

- Formularz logowania: `type="email" autocomplete="username"` i `type="password" autocomplete="current-password"`, zwykły POST na `/login`, po sukcesie 303 na `/panel.html`. Nie blokować wklejania.
- Rejestracja i reset: pole e-mail widoczne (readonly lub hidden z `autocomplete="username"`) i `autocomplete="new-password"` — przeglądarka zaproponuje silne hasło i zapisze je pod właściwym loginem.
- Pola SMTP w ustawieniach mają `autocomplete="off"/"new-password"`, żeby przeglądarka nie wstawiała tam hasła admina.
- „Zapamiętaj mnie”: ciasteczko sesji `httpOnly; SameSite=Lax` (+ `Secure` automatycznie, gdy strona działa po HTTPS), `maxAge` 30 dni gdy zaznaczone, w przeciwnym razie ciasteczko sesyjne. Po zmianie hasła usunąć wszystkie sesje użytkownika.
- Limit prób: 10 nieudanych logowań na 15 min na e-mail i 50 na IP (całe biuro może mieć jedno publiczne IP). Ten sam komunikat błędu niezależnie od tego, czy konto istnieje.
- Hasło min. 8 znaków.
- Reset hasła: na jeden adres najwyżej 3 linki na godzinę (kolejne prośby udają „wysłano”, żeby nie zasypać skrzynki). Anonimowa prośba nie unieważnia wcześniejszych ważnych linków. Skutek uboczny: ktoś może wyczerpać limit dla cudzego adresu — wtedy link wysyła administrator (Pracownicy → Edytuj → „Wyślij link do zmiany hasła”), bez limitu.
- Tylko LAN, bez proxy: `trust proxy` wyłączone — serwer nie ufa nagłówkom `X-Forwarded-*`, więc nikt nie podrobi swojego IP, żeby obejść limit prób. Włącza się je zmienną `TRUST_PROXY` dopiero przy wystawieniu przez proxy (sekcja 8a).
- Ochrona stron: `protectPages` (`src/auth.js`) przekierowuje niezalogowanych na `/login.html?next=…`; `panel.html` — każdy zalogowany, `admin-wnioski.html` — `manager`/`admin`, `admin-pracownicy.html` i `admin-ustawienia.html` — tylko `admin`; inne pliki `.html` nie są serwowane. API: `requireApi(role)` na każdej trasie (401/403) + token CSRF przy zmianach danych. Formularze i API przyjmują żądania tylko z tej samej strony (nagłówek `Origin`).
- ✅ Cała sekcja 5 zrobiona (kroki 2–3).

## 6. Poczta (SMTP)

Adresy i dane serwera wpisujesz w **Ustawienia → Poczta wychodząca** (zapis do `settings`, test wysyłki przyciskiem). E-maile:

| Zdarzenie | Do kogo | Treść | Stan |
|---|---|---|---|
| Zaproszenie | nowy pracownik | link `APP_URL/rejestracja.html?token=…`, ważny 7 dni | ✅ |
| Reset hasła | pracownik | link ważny 1 godzinę, jednorazowy (prośba samodzielna albo od admina) | ✅ |
| Hasło zmienione | pracownik | informacja + „jeśli to nie Ty, skontaktuj się z administratorem” | ✅ (dodane) |
| Test poczty | wskazany adres | z Ustawień | ✅ |
| Nowy wniosek | przełożony / admini | termin, dni, pula po akceptacji, zastępca, uwagi, przycisk do „Wnioski” | ✅ |
| Decyzja | pracownik | zatwierdzony (`.ics`) / odrzucony z powodem / anulowany przez przełożonego z powodem (`.ics` CANCEL) / zgoda na anulowanie (`.ics` CANCEL) / odmowa anulowania z powodem | ✅ |
| Prośba o anulowanie | przełożony | dot. zatwierdzonego urlopu w przyszłości | ✅ |
| Wniosek wycofany | przełożony | pracownik wycofał czekający wniosek — nic nie trzeba robić | ✅ (dodane) |
| Przypomnienie | pracownik | 1 lipca od 8:00 (nadrabiane do 7 lipca): ile zaległego urlopu nie ma jeszcze terminu przed 30 września — liczą się tylko dni urlopu (zatwierdzone i czekające) do 30.09, urlop zaplanowany później zaległego nie ratuje; tylko osoby, którym coś zostało | ✅ |
| Zestawienie | przełożeni i administratorzy (oprócz tych, którzy je wyłączyli u siebie) | poniedziałek od 7:00: kto ma zatwierdzony urlop w tym tygodniu + święta i dni wolne w tym tygodniu; gdy nikt nieobecny — bez e-maila | ✅ |

Wysyłkę robić asynchronicznie z prostą kolejką w tabeli (ponowienie przy błędzie SMTP), żeby awaria poczty nie blokowała zatwierdzania. Zrobione jako `mail_queue`: ponowienia po 1, 5, 15, 60, 180, 360 min; po wysłaniu treść (z linkiem) jest kasowana; link resetu po godzinie nie jest już wysyłany. Gdy poczta nie jest ustawiona, admin dostaje link z zaproszenia / resetu do przekazania ręcznie.

## 7. API

✅ = działa, ⬜ = do zrobienia (krok w nawiasie).

```
✅ POST /login · POST /logout
✅ POST /rejestracja                      { token, first_name, last_name, password }
✅ POST /reset-hasla                      { email }          → zawsze 303 ?sent=1
✅ POST /reset-hasla/nowe                 { token, password }
✅ GET  /api/invite?token=                → dane do strony rejestracji (e-mail, imię, wymiar, kto zaprosił); 410 = link nieważny
✅ GET  /api/reset?token=                 → { email } do pola username przy nowym haśle; 410 = link nieważny
✅ GET  /api/health                       → stan serwera i bazy (healthcheck Dockera)

✅ GET  /api/me                           → { id, email, first_name, last_name, role, csrf, pending_count,
                                              weekly_digest, weekly_digest_global (dwa ostatnie: przełożony / admin) }
✅ PUT  /api/me/notifications             { weekly_digest: true|false } — przełożony / admin, własna lista nieobecnych
✅ GET  /api/me/balance?year=            → { year, balance (jak na liście pracowników) | null, carriedLeft, available, typeUsed, limits }
✅ GET  /api/me/requests                  → { today, requests } — wszystkie własne, z zastępcą i decyzją
✅ POST /api/requests                     { date_from, date_to, type, substitute_id, note } → 201 { request }; 400 dane, 409 saldo/limit/kolizja
✅ POST /api/requests/:id/cancel          → { status: cancelled | cancel_requested }; cudzy = 404
✅ GET  /api/calendar?from=&to=           → { daysOff, showAbsent, absent } (święta liczy przeglądarka z holidays.js; zakres ≤ 3 lata)
✅ GET  /api/people                       → aktywne osoby (bez mnie) do wyboru zastępcy

✅ GET  /api/admin/requests?filter=pending|approved|rejected|cancelled|all&year=   (przełożony, admin)
        → { requests: [... z left, overlaps, substitute_away, routed_to, mine], pending_count, today }
✅ POST /api/admin/requests/:id/approve                     czekający → zatwierdzony (sprawdza pulę)
✅ POST /api/admin/requests/:id/reject    { reason }        czekający → odrzucony
✅ POST /api/admin/requests/:id/cancel    { reason? }       prośba o anulowanie → anulowany; zatwierdzony → anulowany (powód wymagany)
✅ POST /api/admin/requests/:id/keep      { reason }        prośba o anulowanie → nadal zatwierdzony
   (cudzy / niedostępny wniosek = 404; zmieniony stan = 409)
✅ GET  /api/admin/users?year=            → lista z saldem (balance) na rok
✅ POST /api/admin/invitations            { email, first_name, last_name, role, days, carry, year }
✅ POST /api/admin/invitations/:id/resend
✅ POST /api/admin/users/:id/reset-password  → link do zmiany hasła wysłany przez admina
✅ PATCH /api/admin/users/:id             { role?, state?, manager_id?, weekly_digest? } → { ok, cleared_subordinates }
✅ PUT  /api/admin/allowances/:userId/:year { days, carry_override (null = automat) } → { balance }
✅ POST /api/admin/allowances/copy        { from, to: from+1 } → { copied, missing }
✅ GET|PUT /api/admin/settings            (poczta + zasady; hasło SMTP nigdy nie wraca)
✅ POST /api/admin/settings/smtp-test     { to, …pola formularza }
✅ GET  /api/admin/days-off/:year        → { year, saturdays: [{ date, name, replacement }], extra: [{ date, name }] }
✅ PUT  /api/admin/days-off/:year        { replacements: { sobota: data | '' }, extra: [{ date, name }] }
                                         → jak GET + { changed: przeliczone wnioski (zero: 0 dni), problems: pula na minusie / limity }
✅ GET  /api/admin/export?kind=summary|requests&year=   → CSV (podsumowanie na osobę / zatwierdzone wnioski)
✅ GET  /api/admin/audit?group=&user=&before=&limit=     → { rows, next } — log zdarzeń od najnowszych
✅ GET  /api/admin/jobs                   → { runs, backups, backup_dir, keep_days }
✅ POST /api/admin/backups                → kopia bazy teraz (osobny plik „…-reczna.sqlite”)
```

Odpowiedzi z zaproszeń i resetu od admina: `{ mail: 'queued' }` albo — gdy poczta nie jest ustawiona — `{ mail: 'smtp_missing', link }` (link do przekazania ręcznie).

## 8. Docker

✅ Zrobione. `Dockerfile` jest dwuetapowy: w pierwszym etapie kompilacja modułów natywnych (`better-sqlite3`, `argon2`) z `python3 make g++`, w obrazie docelowym tylko `node_modules`, `src`, `migrations`, `public` i `tzdata` — bez kompilatorów. Dodatkowo `HEALTHCHECK` na `/api/health`, `USER node`, `ENV NODE_ENV=production TZ=Europe/Warsaw PORT=3000 DATA_DIR=/app/data`. Serwer zamyka się czysto przy `docker stop` (SIGTERM → zamknięcie bazy).

```yaml
services:
  urlopy:
    build: .
    restart: unless-stopped
    ports: ["1003:3000"]            # port do ustalenia (mapa360 używa 1002); dostęp z LAN
    env_file: .env                  # SESSION_SECRET, SETTINGS_KEY, APP_URL, ADMIN_EMAIL
    volumes: ["./data:/app/data"]   # urlopy.sqlite + sesje
```

Przed pierwszym startem na serwerze: `mkdir -p data && sudo chown 1000:1000 data` (kontener działa jako użytkownik `node`, UID 1000) oraz `.env` z `.env.example` — `SESSION_SECRET` jest wymagany w trybie produkcyjnym, `SETTINGS_KEY` potrzebny do zapisania hasła SMTP.

`TZ=Europe/Warsaw` jest ważne: daty urlopów to daty lokalne, bez niego cron i „dzisiaj” będą przesunięte. Daty trzymać jako tekst `YYYY-MM-DD`, nigdy jako znacznik czasu UTC.

Pierwsze uruchomienie: jeśli w bazie nie ma admina, serwer tworzy zaproszenie dla `ADMIN_EMAIL` i wypisuje link w logach kontenera (działa nawet bez skonfigurowanego SMTP).

`APP_URL` to adres serwera w LAN, np. `http://192.168.88.X:1003` albo nazwa z firmowego DNS. Ten adres trafia do linków w e-mailach (zaproszenie, reset hasła), więc linki działają tylko z komputerów w sieci firmy.

Kopia zapasowa: ✅ robi ją sama aplikacja (krok 8) — codziennie od 2:00 spójna kopia bazy (backup API SQLite, także w trakcie pracy) do `data/backup/urlopy-RRRR-MM-DD.sqlite`, kopie starsze niż 30 dni kasowane; w Ustawieniach lista kopii i „Zrób kopię teraz”. **Kopia leży na tym samym dysku co baza** — na serwerze trzeba ją regularnie kopiować gdzie indziej (NAS, inny dysk), np. cron na hoście: `rsync -a /ścieżka/do/urlopy/data/backup/ /mnt/nas/urlopy-backup/`. Odtworzenie: zatrzymać kontener, podmienić `data/urlopy.sqlite` wybraną kopią (i usunąć `urlopy.sqlite-wal` / `-shm`), uruchomić.

## 8a. Sieć: tylko LAN

- Aplikacja działa po HTTP pod adresem serwera w LAN. Hasła i ciasteczka idą po sieci firmowej bez szyfrowania — akceptowalne w zaufanej sieci; przeglądarka może oznaczać stronę jako „Niezabezpieczona”.
- Opcjonalnie później: HTTPS w LAN (np. Caddy z certyfikatem z wewnętrznego CA) — ciasteczko dostanie wtedy `Secure` automatycznie.
- **Wystawienie do internetu (etap 2, krok 11):** VPS z domeną + tunel WireGuard do serwera firmowego, na VPS reverse proxy (Caddy) z HTTPS; w `.env` `TRUST_PROXY` = adres VPS w tunelu, `APP_URL` = adres publiczny; port 1003 tylko z LAN i z tunelu. Szczegóły w sekcji 11.

## 9. Kolejność prac

1. ✅ **Szkielet Express, serwowanie `public/`, migracja bazy, konfiguracja Dockera.**
   Zrobione: serwer z nagłówkami bezpieczeństwa (CSP dopuszcza wbudowane skrypty stron i Google Fonts), migracje przy starcie, `/api/health`, Docker z healthcheckiem.
2. ✅ **Logowanie, sesje, wylogowanie, ochrona stron, pierwszy admin z `.env`.**
   Zrobione: argon2id, ten sam komunikat i czas odpowiedzi niezależnie od istnienia konta, limit prób (10/e-mail, 50/IP), sesje w SQLite przetrwają restart, zablokowane konto traci dostęp od razu, ochrona stron i API według ról, Origin + CSRF. Pierwszy admin: link w logach kontenera, każdy restart do czasu rejestracji daje nowy link. Dodatkowo (wcześniej niż w planie): rejestracja z zaproszenia, `js/session.js` (imię w nagłówku, menu według roli).
3. ✅ **Ustawienia SMTP + test wysyłki, zaproszenia, rejestracja, reset hasła.**
   Zrobione: Ustawienia → Poczta i Zasady na prawdziwym API, szyfrowane hasło SMTP, kolejka e-maili z ponowieniami, zaproszenia / ponowne wysłanie / link resetu od admina (bez poczty — link do przekazania ręcznie), samodzielny reset z wylogowaniem innych urządzeń i e-mailem „hasło zmienione”. Dodatkowo: prawdziwa lista pracowników z saldem (`leave.js`) i format dat `dd/mm/rrrr` z kalendarzem flatpickr.
4. ✅ **Pracownicy i wymiar urlopu, kopiowanie wymiaru na nowy rok, wyliczanie zaległego.**
   Zrobione: okno edycji zapisuje wymiar i ręczny zaległy (`PUT /api/admin/allowances/…`, także dla roku bez wymiaru) oraz rolę, konto aktywne i nowe pole „Przełożony” (`PATCH /api/admin/users/:id`); „Przenieś wymiary z poprzedniego roku” (`POST /api/admin/allowances/copy`). Wyłączenie konta usuwa jego sesje; przełożony bez roli lub z wyłączonym kontem → podwładni bez przełożonego (ostrzeżenie); admin nie zmienia sam sobie roli ani nie wyłącza swojego konta; zawsze zostaje aktywny admin. Lista pokazuje przełożonego przy roli.
5. ✅ **Panel pracownika: saldo, kalendarz, składanie i wycofywanie wniosków.**
   Zrobione: `routes/requests.js` + walidacja w `leave.js` (dni liczy serwer z `holidays.js` i `company_days_off`, kolizje, saldo, limity — w jednej transakcji), `panel.html` na prawdziwym API (saldo bieżącego roku, saldo innego roku doczytywane przy wyborze terminu, lista zastępców, kto ma wtedy urlop, wycofanie i prośba o anulowanie). Sprawdzone testami API i testem dymnym strony w jsdom. Do kroku 6: e-maile do przełożonego, decyzja o `cancel_requested`, wnioski `pending`, których termin minął.
6. ✅ **Akceptacja wniosków, e-maile z decyzją, wykrywanie kolizji.**
   Zrobione: `src/approvals.js` (kto zatwierdza, kto może decydować, e-maile, decyzje w transakcji z kontrolą puli), `routes/approvals.js`, `admin-wnioski.html` na prawdziwym API, licznik w menu, e-maile do przełożonego (nowy wniosek, prośba o anulowanie) i do pracownika (decyzja, `.ics`). Sprawdzone testami API, testem dymnym stron w jsdom i prawdziwą wysyłką przez Mailpit (załącznik `.ics`). Wnioski czekające, których termin minął, zostają do decyzji (z ostrzeżeniem na karcie).
7. ✅ **Dni wolne w firmie, przeliczanie wniosków, eksport CSV.**
   Zrobione: `src/daysoff.js` + `GET/PUT /api/admin/days-off/:year`, sekcja „Dni wolne w firmie” w Ustawieniach na prawdziwym API (lata: poprzedni, bieżący, następny), przeliczanie wniosków w transakcji (sekcja 4). Eksport `src/export.js`: **podsumowanie** (osoba: konto, wymiar, zaległy, pula, wykorzystane, czeka, pozostało, na żądanie, okolicznościowy, opieka, siła wyższa, bezpłatny) i **zatwierdzone wnioski** (osoba, rodzaj, od–do, dni, status, kto i kiedy zatwierdził, zastępstwo). CSV ze średnikiem i UTF-8 z BOM (polski Excel otwiera wprost), daty dd/mm/rrrr, ochrona przed formułami (`=`, `+`, `-`, `@` na początku tekstu). Przyciski na stronie „Pracownicy” dla wybranego roku. XLSX i rozbicie na miesiące — na razie nie (propozycje w sekcji 10).
8. ✅ **Zadania automatyczne, log audytowy, kopie zapasowe.**
   Zrobione: `src/jobs.js` (własny harmonogram zamiast node-cron — sekcja 1; tabela `job_runs`), lista nieobecnych w poniedziałek do **przełożonych i administratorów** (decyzja: pracownicy jej nie dostają, niezależnie od `show_absent`), przypomnienie 1 lipca o zaległym urlopie, nocna kopia bazy w aplikacji (sekcja 8), podgląd logu zdarzeń w Ustawieniach (filtr po rodzaju, stronicowanie, polskie nazwy zdarzeń). Oba e-maile można wyłączyć w Ustawieniach → Zasady urlopowe. **Lista nieobecnych ma też osobisty wyłącznik** (kolumna `users.weekly_digest`, migracja `006`, domyślnie włączone): przełożony / admin sam na stronie „Wnioski” (`PUT /api/me/notifications`), a admin każdemu w Pracownicy → Edytuj (`PATCH /api/admin/users/:id { weekly_digest }`). Globalny przełącznik w Ustawieniach działa jak wyłącznik dla wszystkich — strona „Wnioski” mówi, gdy jest wyłączony. Kopia nie zależy od ustawień. Kopie idą po kolei: „Zrób kopię teraz” w trakcie nocnej kopii czeka na nią i robi własny plik; przy `docker stop` serwer nie przyjmuje nowych zadań i czeka na kopię w toku, a pozostałości po przerwanej kopii (`.tmp`) są sprzątane przy następnej. Log zdarzeń nie jest czyszczony (mała tabela; do rozważenia po kilku latach).
9. ✅ **Testy automatyczne w repozytorium** (zrobione razem z krokiem 4): `test/` + `docker-compose.test.yml`, 91 testów — logowanie i ochrona API, saldo i zaległy, trasy kroków 4–8 (e-maile sprawdzane w kolejce `mail_queue`); zadania automatyczne testowane w procesie z podstawianą datą (`test/jobs.test.js`), serwer w testach API działa bez zadań w tle (`JOBS_DISABLED=1`). Kolejne kroki dopisują swoje testy.

Zamiana danych przykładowych: w każdym pliku HTML blok `/* ===== MOCK … ===== */` zastąpić wywołaniem `fetch` z komentarza obok.

## 10. Propozycje dodatkowych funkcji

Przejrzane 24/11/2026 — wybrane przeszły do etapu 2 (sekcja 11), reszta odrzucona na razie.

- **Zastępstwa i kolizje**: ✅ zrobione w kroku 6 (ostrzeżenia na karcie wniosku).
- **Kalendarz zespołu**: → etap 2, krok 12.
- **Plan urlopów** na początku roku (art. 163 KP): → etap 2, krok 14.
- **Okresy zablokowane** (np. odbiory końcowe, termin oferty): → etap 2, krok 12.
- **Plik .ics przy decyzji**: ✅ zrobione w kroku 6. **Subskrypcja kalendarza** (adres .ics): ✗ odrzucona.
- **Wniosek do podpisu (PDF)**: ✗ odrzucony.
- **Wymiar proporcjonalny**: → etap 2, krok 13.
- **Eksport dla kadr**: CSV ✅ (krok 7); XLSX z rozbiciem na miesiące → etap 2, krok 13.
- **Log zmian**: ✅ zrobione w kroku 8 (Ustawienia → Log zdarzeń).
- **Dostęp z internetu**: → etap 2, krok 11 — **przez VPS + WireGuard** zamiast Pangolina.
- **Logowanie przez Keycloak (OIDC)**: → etap 2, krok 16 (Keycloak do wdrożenia). Link w portalu narzędzi ZBIKS — przy okazji.
- **2FA** (kod z aplikacji przy logowaniu z internetu): ✗ odrzucone — dostęp z internetu dla wszystkich bez 2FA.

## 11. Etap 2 — kolejne funkcje

Funkcje wybrane 24/11/2026 (pytanie po pytaniu). Robione po jednym kroku, jak w etapie 1: kod → testy (`node --test` w Dockerze) → test dymny stron w jsdom → `/code-review` → aktualizacja PLAN.md → commit.

**Decyzje:**
- Internet: jest VPS z publicznym IP i domena; dostęp z internetu mają **wszyscy**, bez 2FA.
- Keycloak: nie ma — **do wdrożenia** (osobny kontener).
- Okresy zablokowane: wniosek w takim terminie **wymaga uzasadnienia**.
- Inne nieobecności (L4, delegacja, szkolenie, praca zdalna): **wszystko wpisuje admin**.
- Plan roczny: **termin + zatwierdzanie**, z pozycji planu „złóż wniosek” jednym kliknięciem.
- RODO: anonimizacja byłych pracowników **po 3 latach** od wyłączenia konta.
- Kolejność: najpierw szybkie braki (krok 10), Keycloak na końcu (krok 16).

10. ⬜ **Szybkie braki.**
    - **Zmiana hasła po zalogowaniu** — karta „Moje konto” w `panel.html` (`autocomplete` current-password / new-password + ukryte `username`); `POST /api/me/password { current, password, logout_others }`: `verifyPassword`, `passwordProblem`, `hashPassword` (`src/auth.js`), `sessionStore.destroyUser(id, bieżąca sesja)`, e-mail „hasło zmienione” (`accounts.notifyPasswordChanged`), audit, limit prób na osobę.
    - **Edycja danych osoby** — `PATCH /api/admin/users/:id` także `first_name`, `last_name`, `email` (walidacja jak przy zaproszeniu, zajęty e-mail → 409); dozwolone też dla zaproszonych (zmiana e-maila zaproszonego = nowe zaproszenie); przy zmianie e-maila aktywnej osoby powiadomienie na stary adres. „Edytuj” w `admin-pracownicy.html`: pola imię / nazwisko / e-mail, także przy zaproszonych.
    - **Urlop wpisany przez admina** — `POST /api/admin/requests { user_id, date_from, date_to, type, substitute_id, note }`: w jednej transakcji ta sama walidacja co wniosek (`leave.createRequest`) + zatwierdzenie (decyzja admina, uwaga „wpisany przez administratora”), e-mail z decyzją i `.ics`. Nie dla własnego konta. Przycisk „Dodaj urlop za pracownika” w `admin-wnioski.html`.
    - **Przypomnienie o czekających** — zadanie `pending_reminder` w `src/jobs.js` (dni robocze od 8:00, raz dziennie): każdy przełożony dostaje jeden e-mail z wnioskami / prośbami o anulowanie czekającymi ≥ 2 dni robocze albo z terminem za ≤ 3 dni. Ustawienie `pending_reminder` w Zasadach (domyślnie włączone).
11. ⬜ **Telefon i dostęp z internetu.**
    - **Wygoda na telefonie** — przegląd stron przy 360 px (menu, tabele, kalendarz jednomiesięczny na wąskim ekranie); PWA: `manifest.webmanifest`, kwadratowa ikona, prosty service worker bez cache’owania API; CSP (`manifest-src`, `worker-src`). Instalacja na telefonie działa dopiero po HTTPS.
    - **Dostęp z internetu przez VPS + WireGuard** — szablony w `deploy/` i opis w `WDROZENIE.md`: tunel WireGuard VPS `10.99.0.1` ↔ serwer firmowy `10.99.0.2` (serwer łączy się do VPS, `PersistentKeepalive = 25`, działa zza NAT); na VPS Caddy `urlopy.<domena> → 10.99.0.2:1003` z automatycznym HTTPS i HSTS; `.env`: `TRUST_PROXY=10.99.0.1`, `APP_URL=https://urlopy.<domena>`; zapora serwera: port 1003 tylko z LAN i z tunelu. Sprawdzić: ciasteczko `Secure` przez HTTPS, limit prób po prawdziwym IP, `sameOrigin` z domeną, dostęp z LAN nadal działa. Sekcja 8a do aktualizacji.
12. ⬜ **Kalendarz zespołu, inne nieobecności, okresy zablokowane.**
    - **Inne nieobecności** — tabela `absences` (osoba, rodzaj: L4 / delegacja / szkolenie / praca zdalna, od–do, uwagi, kto wpisał); `GET/POST/DELETE /api/admin/absences`; nie zmniejszają puli; widoczne w liście nieobecnych, ostrzeżeniach o kolizjach, „kto ma wtedy urlop” i kalendarzu zespołu. **L4 to dane o zdrowiu — rodzaj widzi tylko admin**, inni widzą „nieobecny”. L4 nachodzące na zatwierdzony urlop → ostrzeżenie dla admina (art. 166 KP: urlop się przerywa, korekta przez anulowanie / nowy wniosek).
    - **Okresy zablokowane** — tabela `blocked_periods` (od–do, nazwa), edycja w Ustawieniach. Wniosek wypoczynkowy lub bezpłatny nachodzący na okres wymaga uzasadnienia (nowa kolumna we wnioskach; bez niego 409 z kodem `blocked`); na żądanie, okolicznościowy, opieka i siła wyższa — bez blokady (prawo). Panel: ostrzeżenie + pole „Uzasadnienie”, dni oznaczone w kalendarzu; karta u przełożonego: czerwone ostrzeżenie z nazwą okresu i uzasadnieniem.
    - **Kalendarz zespołu** — nowa strona `kalendarz.html` (link w menu): miesiąc jako tabela osoby × dni — zatwierdzone urlopy, czekające (tylko przełożeni / admini), inne nieobecności, święta, weekendy, dni wolne, okresy zablokowane; filtr „mój zespół” dla przełożonych. `GET /api/team-calendar?month=RRRR-MM`; pracownik widzi tylko zatwierdzone i tylko przy włączonym „Pokazuj, kto ma urlop”.
13. ⬜ **Kadry.**
    - **Wymiar proporcjonalny** — kalkulator przy zaproszeniu i w „Edytuj”: pełny wymiar (20 / 26), etat, data zatrudnienia / zakończenia w roku, „pierwsza praca” (art. 153 § 1: 1/12 z 20 dni po każdym miesiącu); zaokrąglenie w górę do pełnego dnia (art. 154², 155¹) z wyjaśnieniem; wynik trafia do pola „Wymiar”, admin zatwierdza. Logika w `public/js/` (testowana w Node).
    - **Eksport XLSX** — zależność `exceljs`; `GET /api/admin/export?kind=xlsx&year=`: arkusze Podsumowanie, Wnioski, **Wykorzystanie w miesiącach** (dni robocze każdej osoby w każdym miesiącu), Inne nieobecności. CSV zostaje.
14. ⬜ **Plan urlopów na rok.**
    - Tabele planu (rok + termin, pozycje planu osoby, stan planu osoby: szkic / wysłany / zatwierdzony / zwrócony z uwagą).
    - Admin otwiera plan na rok z terminem (np. do 31 stycznia) → e-mail do wszystkich; 7 dni przed terminem przypomnienie do osób bez wysłanego planu.
    - Pracownik: zakładka „Plan urlopów” w panelu — zaznacza terminy w kalendarzu, widzi sumę względem puli, „Wyślij plan”. Przełożony (ten sam routing co wnioski) zatwierdza albo zwraca z uwagą — zakładka „Plany” na stronie „Wnioski”.
    - Plan nie zmniejsza puli; przy pozycji planu „Złóż wniosek” (wypełnia formularz); 14 dni przed zaplanowanym urlopem e-mail „złóż wniosek”. Kalendarz zespołu pokazuje plan jaśniejszym kolorem.
15. ⬜ **RODO: byli pracownicy.**
    - Kolumna `users.disabled_at` (ustawiana przy wyłączeniu konta; dla już wyłączonych — data migracji).
    - Zadanie codzienne: konta wyłączone ≥ 3 lata → anonimizacja (imię i nazwisko „Były pracownik #id”, e-mail `usuniety-<id>@invalid`, bez hasła, usunięte tokeny i sesje, wyczyszczone uwagi i uzasadnienia we wnioskach; wnioski zostają do statystyk). Log zdarzeń starszy niż 3 lata kasowany. Przycisk „Anonimizuj teraz” przy wyłączonym koncie.
    - Ostrzeżenie w aplikacji: to nie oficjalna dokumentacja pracownicza (ta jest w kadrach, 10 lat) — przed anonimizacją kadry powinny mieć eksport.
16. ⬜ **Keycloak: wdrożenie i logowanie kontem ZBIKS.**
    - `deploy/keycloak/`: Keycloak + Postgres (osobny compose), za tym samym Caddy na VPS (`auth.<domena>`, HTTPS); realm `zbiks`, klient `urlopy` (confidential, standard flow, PKCE).
    - Aplikacja: zależność `openid-client`; w `.env` `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (bez nich przycisk ukryty); przycisk „Zaloguj przez konto ZBIKS” na stronie logowania; state + nonce + PKCE w sesji, `email_verified`, dopasowanie po adresie e-mail do istniejącego konta. Konta nadal tylko z zaproszenia (zaproszony może aktywować konto przez Keycloak). Logowanie e-mailem i hasłem zostaje.
    - Testy z atrapą dostawcy OIDC (bez prawdziwego Keycloaka).

**Weryfikacja każdego kroku:** testy w Dockerze (`docker-compose.test.yml`), test dymny stron w jsdom bez błędów JS, lokalny kontener z Mailpit, `/code-review`. Krok 11: test przez prawdziwy VPS (HTTPS, logowanie z telefonu spoza sieci firmy). Krok 16: logowanie przez Keycloak na serwerze.
