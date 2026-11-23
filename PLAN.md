# Urlopy ZBIKS — plan aplikacji

Aplikacja webowa do składania i akceptowania wniosków urlopowych, uruchamiana jako kontener Docker na serwerze firmowym. **Na razie dostępna tylko w sieci LAN firmy** (bez reverse proxy i bez dostępu z internetu — patrz sekcja 8a). Punktem wyjścia były gotowe okna HTML (`public/`) z danymi przykładowymi (bloki oznaczone `MOCK`), które krok po kroku są podłączane do backendu.

Repozytorium: https://github.com/kszymanskizbikspl/Urlopy (gałąź `main`).

## 0. Stan prac (23/11/2026)

| Krok (sekcja 9) | Stan | Commit |
|---|---|---|
| 1. Szkielet Express, `public/`, migracje, Docker | ✅ zrobione | `c400ec7` |
| 2. Logowanie, sesje, ochrona stron, pierwszy admin | ✅ zrobione | `c400ec7`, poprawki `464d88b` |
| 3. SMTP + test, zaproszenia, rejestracja, reset hasła | ✅ zrobione | `2643cdc` |
| 4. Pracownicy i wymiar urlopu, kopiowanie na nowy rok, zaległy | 🟡 częściowo — lista z saldem i wyliczanie zaległego gotowe (zrobione w kroku 3), brak edycji osoby i kopiowania wymiaru | — |
| 5. Panel pracownika: saldo, kalendarz, wnioski | ⬜ do zrobienia | — |
| 6. Akceptacja wniosków, e-maile z decyzją, kolizje | ⬜ do zrobienia | — |
| 7. Dni wolne w firmie, przeliczanie wniosków, eksport CSV | ⬜ do zrobienia | — |
| 8. Cron, log audytowy, kopie zapasowe | ⬜ do zrobienia (log audytowy już zapisuje zdarzenia) | — |

**Strony — co działa na prawdziwych danych, a co jest jeszcze `MOCK`:**

| Strona | Stan |
|---|---|
| `login.html` | ✅ logowanie, „zapamiętaj mnie”, powrót na stronę po zalogowaniu, komunikat o limicie prób |
| `rejestracja.html` | ✅ dane z zaproszenia (`/api/invite`), zakładanie konta |
| `reset-hasla.html` | ✅ prośba o link, ustawienie nowego hasła, wygasły link |
| `admin-ustawienia.html` | ✅ Poczta wychodząca, ✅ Zasady urlopowe; ⬜ Dni wolne w firmie — `MOCK` (krok 7) |
| `admin-pracownicy.html` | ✅ lista z saldem, zaproszenia, „Wyślij ponownie”, link do zmiany hasła; ⬜ zapis edycji osoby i „Przenieś wymiary” pokazują komunikat „krok 4” |
| `panel.html` | ✅ nagłówek (imię, menu według roli); ⬜ saldo, wnioski, kalendarz — `MOCK` (krok 5) |
| `admin-wnioski.html` | ⬜ `MOCK` (krok 6); licznik w menu („3”) też `MOCK` |

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

**Jak to było testowane:** każdy krok sprawdzony w kontenerze Docker (`NODE_ENV=production`) skryptami curl/Python, e-maile przez testowy serwer Mailpit; kalendarz dat w jsdom. Dwa przeglądy kodu (`/code-review`) — wszystkie uwagi poprawione. **Testy nie są jeszcze częścią repozytorium** — warto je dodać (np. `node --test` + Mailpit w `docker-compose.test.yml`), zanim przybędzie logiki wniosków.

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
| Zadania cykliczne | `node-cron` | przypomnienia, zestawienie tygodniowe | ⬜ krok 8 |

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
│  ├─ leave.js             ← saldo i zaległy urlop (⬜ walidacja wniosków — krok 5)
│  ├─ audit.js             ← log audytowy
│  ├─ bootstrap.js         ← pierwszy admin z ADMIN_EMAIL
│  ├─ jobs.js              ← ⬜ cron (krok 8)
│  └─ routes/ auth.js (login, logout, rejestracja, reset)  me.js  admin.js  ⬜ requests.js
├─ migrations/001_init.sql  002_sessions.sql  003_mail_queue.sql
├─ Dockerfile  docker-compose.yml  .env.example  .gitattributes
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
| Nowy wniosek | przełożony / admini | termin, dni, zastępca, przyciski do panelu | ⬜ krok 5–6 |
| Decyzja | pracownik | zatwierdzony / odrzucony z powodem, załącznik `.ics` | ⬜ krok 6 |
| Prośba o anulowanie | przełożony | dot. zatwierdzonego urlopu w przyszłości | ⬜ krok 5–6 |
| Przypomnienie | pracownik | 1 lipca: niewykorzystany zaległy urlop | ⬜ krok 8 |
| Zestawienie | wszyscy / admini | poniedziałek 7:00, kto jest nieobecny w tygodniu | ⬜ krok 8 |

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

✅ GET  /api/me                           → { id, email, first_name, last_name, role, csrf }
⬜ GET  /api/me/balance?year=2026         → { allowance, carried, used, pending, left, onDemandUsed }   (5)
⬜ GET  /api/me/requests?year=2026                                                               (5)
⬜ POST /api/requests                     { date_from, date_to, type, substitute_id, note }        (5)
⬜ POST /api/requests/:id/cancel                                                                 (5)
⬜ GET  /api/calendar?from=&to=           → święta, dni wolne firmy, moje wnioski, nieobecni       (5)

⬜ GET  /api/admin/requests?status=pending                                                       (6)
⬜ POST /api/admin/requests/:id/approve                                                          (6)
⬜ POST /api/admin/requests/:id/reject    { reason }                                             (6)
✅ GET  /api/admin/users?year=            → lista z saldem (balance) na rok
✅ POST /api/admin/invitations            { email, first_name, last_name, role, days, carry, year }
✅ POST /api/admin/invitations/:id/resend
✅ POST /api/admin/users/:id/reset-password  → link do zmiany hasła wysłany przez admina
⬜ PATCH /api/admin/users/:id             { role, state, manager_id }                              (4)
⬜ PUT  /api/admin/allowances/:userId/:year { days, carry_override }                               (4)
⬜ POST /api/admin/allowances/copy        { from, to }                                             (4)
✅ GET|PUT /api/admin/settings            (poczta + zasady; hasło SMTP nigdy nie wraca)
✅ POST /api/admin/settings/smtp-test     { to, …pola formularza }
⬜ GET|PUT /api/admin/days-off/:year                                                             (7)
⬜ GET  /api/admin/export?year=           → CSV/XLSX dla kadr                                      (7)
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

Kopia zapasowa: codziennie `sqlite3 data/urlopy.sqlite ".backup data/backup/urlopy-$(date +%F).sqlite"` z hosta (cron), trzymać np. 30 dni.

## 8a. Sieć: tylko LAN

- Aplikacja działa po HTTP pod adresem serwera w LAN. Hasła i ciasteczka idą po sieci firmowej bez szyfrowania — akceptowalne w zaufanej sieci; przeglądarka może oznaczać stronę jako „Niezabezpieczona”.
- Opcjonalnie później: HTTPS w LAN (np. Caddy z certyfikatem z wewnętrznego CA) — ciasteczko dostanie wtedy `Secure` automatycznie.
- **Wystawienie do internetu (później, nie teraz):** reverse proxy (Pangolin) z HTTPS, w `.env` `TRUST_PROXY` = dokładny adres proxy, port w compose tylko dla proxy (np. `127.0.0.1:1003:3000`), `APP_URL` = adres publiczny.

## 9. Kolejność prac

1. ✅ **Szkielet Express, serwowanie `public/`, migracja bazy, konfiguracja Dockera.**
   Zrobione: serwer z nagłówkami bezpieczeństwa (CSP dopuszcza wbudowane skrypty stron i Google Fonts), migracje przy starcie, `/api/health`, Docker z healthcheckiem.
2. ✅ **Logowanie, sesje, wylogowanie, ochrona stron, pierwszy admin z `.env`.**
   Zrobione: argon2id, ten sam komunikat i czas odpowiedzi niezależnie od istnienia konta, limit prób (10/e-mail, 50/IP), sesje w SQLite przetrwają restart, zablokowane konto traci dostęp od razu, ochrona stron i API według ról, Origin + CSRF. Pierwszy admin: link w logach kontenera, każdy restart do czasu rejestracji daje nowy link. Dodatkowo (wcześniej niż w planie): rejestracja z zaproszenia, `js/session.js` (imię w nagłówku, menu według roli).
3. ✅ **Ustawienia SMTP + test wysyłki, zaproszenia, rejestracja, reset hasła.**
   Zrobione: Ustawienia → Poczta i Zasady na prawdziwym API, szyfrowane hasło SMTP, kolejka e-maili z ponowieniami, zaproszenia / ponowne wysłanie / link resetu od admina (bez poczty — link do przekazania ręcznie), samodzielny reset z wylogowaniem innych urządzeń i e-mailem „hasło zmienione”. Dodatkowo: prawdziwa lista pracowników z saldem (`leave.js`) i format dat `dd/mm/rrrr` z kalendarzem flatpickr.
4. 🟡 **Pracownicy i wymiar urlopu, kopiowanie wymiaru na nowy rok, wyliczanie zaległego.**
   Gotowe: lista z saldem, wyliczanie zaległego. Do zrobienia: `PATCH /api/admin/users/:id` (rola, blokada konta, przełożony `manager_id` — w oknie edycji brak jeszcze pola „przełożony”), `PUT /api/admin/allowances/:userId/:year` (wymiar, ręczny zaległy), `POST /api/admin/allowances/copy` („Przenieś wymiary z poprzedniego roku”). Uwaga: przy blokadzie konta usuwać jego sesje; nie pozwolić odebrać roli ostatniemu aktywnemu adminowi.
5. ⬜ Panel pracownika: saldo, kalendarz (`/api/calendar`), składanie i wycofywanie wniosków.
6. ⬜ Akceptacja wniosków, e-maile z decyzją, wykrywanie kolizji.
7. ⬜ Dni wolne w firmie, przeliczanie wniosków, eksport CSV.
8. ⬜ Cron: przypomnienia i zestawienie tygodniowe, log audytowy (zapis zdarzeń już działa — brak podglądu), kopie zapasowe.
9. ⬜ (propozycja) Testy automatyczne w repozytorium — obecnie testy uruchamiane ręcznie poza repo.

Zamiana danych przykładowych: w każdym pliku HTML blok `/* ===== MOCK … ===== */` zastąpić wywołaniem `fetch` z komentarza obok.

## 10. Propozycje dodatkowych funkcji

- **Zastępstwa i kolizje** (już w oknach): wybór zastępcy we wniosku, a przy akceptacji ostrzeżenie, gdy zastępca albo za dużo osób jest wtedy nieobecnych.
- **Kalendarz zespołu**: widok miesiąca z nieobecnościami wszystkich. Przy nadzorach na kilku budowach łatwiej zaplanować obsadę odbiorów i rad budowy.
- **Plan urlopów** na początku roku: pracownicy zaznaczają planowane terminy (art. 163 KP), admin widzi całość i zatwierdza plan zbiorczo.
- **Okresy zablokowane**: admin oznacza terminy, w których urlop wymaga uzasadnienia (np. odbiory końcowe, termin złożenia oferty).
- **Plik .ics / subskrypcja kalendarza**: zatwierdzone urlopy w kalendarzu telefonu, a zestaw nieobecności zespołu jako adres subskrypcji.
- **Wniosek do podpisu (PDF)**: wydruk wniosku w formacie dla akt osobowych.
- **Wymiar proporcjonalny**: kalkulator dla osób zatrudnionych w trakcie roku lub na część etatu (zaokrąglanie w górę do pełnego dnia, art. 154²).
- **Eksport dla kadr/księgowości** (CSV/XLSX) z wykorzystaniem urlopu w miesiącu.
- **Log zmian**: kto zmienił wymiar, kto zatwierdził wniosek, kiedy (już w modelu danych jako `audit_log`).
- **Dostęp z internetu** przez Pangolin (sekcja 8a), np. żeby składać wnioski z budowy.
- **Link w portalu narzędzi ZBIKS** do aplikacji. Później można rozważyć logowanie przez Keycloak (OIDC) jako drugą opcję, zostawiając własne logowanie e-mailem.
