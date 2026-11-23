# Urlopy ZBIKS — plan aplikacji

Aplikacja webowa do składania i akceptowania wniosków urlopowych, uruchamiana jako kontener Docker na serwerze firmowym. **Na razie dostępna tylko w sieci LAN firmy** (bez reverse proxy i bez dostępu z internetu — patrz sekcja 8a). Ten pakiet zawiera gotowe okna HTML (`public/`) z danymi przykładowymi (bloki oznaczone `MOCK`) oraz plan backendu do zrobienia w VS Code.

## 1. Stos technologiczny (propozycja)

| Warstwa | Wybór | Dlaczego |
|---|---|---|
| Backend | Node.js 22 LTS + Express | ten sam JavaScript co w przeglądarce, plik `holidays.js` działa po obu stronach |
| Baza | SQLite (`better-sqlite3`) w wolumenie Dockera | kilkanaście osób, zero administracji, kopia = jeden plik |
| Hasła | `argon2` (argon2id) | obecny standard haszowania haseł |
| Sesje | `express-session` + magazyn w SQLite | ciasteczko httpOnly, „zapamiętaj mnie” = dłuższy `maxAge` |
| Poczta | `nodemailer` | SMTP z ustawień w panelu |
| Bezpieczeństwo | `helmet`, `express-rate-limit`, token CSRF | ochrona logowania i formularzy |
| Zadania cykliczne | `node-cron` | przypomnienia, zestawienie tygodniowe |

Frontend zostaje jako zwykłe pliki HTML/CSS/JS serwowane statycznie przez Express. Strony pobierają dane z `/api/...` (fetch), a logowanie, rejestracja i reset hasła to klasyczne formularze POST z przekierowaniem.

## 2. Struktura projektu

```
urlopy/
├─ public/                 ← okna z tego pakietu
│  ├─ css/app.css
│  ├─ img/logo-zbiks.png
│  ├─ js/holidays.js       ← święta + dni robocze (współdzielone z serwerem)
│  ├─ js/calendar.js       ← komponent kalendarza
│  ├─ js/ui.js
│  ├─ login.html  rejestracja.html  reset-hasla.html
│  ├─ panel.html
│  └─ admin-wnioski.html  admin-pracownicy.html  admin-ustawienia.html
├─ src/
│  ├─ server.js            ← Express, sesje, routing
│  ├─ db.js                ← połączenie + migracje
│  ├─ auth.js              ← logowanie, zaproszenia, reset hasła
│  ├─ leave.js             ← saldo, przenoszenie, walidacja wniosków
│  ├─ mail.js              ← nodemailer + szablony e-maili
│  ├─ jobs.js              ← cron
│  └─ routes/ (me.js, requests.js, admin.js)
├─ migrations/001_init.sql
├─ Dockerfile
├─ docker-compose.yml
└─ .env.example
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

Hasło SMTP w tabeli `settings` szyfrować (AES-256-GCM, klucz z `SETTINGS_KEY` w `.env`), nigdy nie odsyłać go do przeglądarki.

## 4. Reguły urlopowe

**Liczenie dni.** Urlop liczony w dniach roboczych: od pon. do pt., bez świąt ustawowych (`holidays.js`, w tym Wigilia od 2025 r.) i bez `company_days_off`. Serwer przelicza dni sam, wartości z przeglądarki ignoruje.

**Przenoszenie zaległego urlopu (bez zadania „zamknięcia roku”).** Zaległy urlop jest wyliczany na bieżąco, rekurencyjnie:

```
zalegly(Y) = carry_override(Y) ?? max(0, wymiar(Y-1) + zalegly(Y-1) - wykorzystane(Y-1))
saldo(Y)   = wymiar(Y) + zalegly(Y) - wykorzystane(Y) - oczekujace(Y)
```

`wykorzystane` to zatwierdzone wnioski typu `wypoczynkowy` i `na_zadanie`. Dzięki temu nic nie trzeba uruchamiać 1 stycznia, a korekta wniosku z zeszłego roku sama przelicza saldo na bieżący. Dla osób już zatrudnionych admin przy zaproszeniu wpisuje zaległy z kadr jako `carry_override` (to punkt startowy). Niewykorzystany zaległy przechodzi dalej także po 30 września, bo roszczenie przedawnia się dopiero po 3 latach; aplikacja tylko ostrzega.

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
- Tylko LAN, bez proxy: `trust proxy` wyłączone — serwer nie ufa nagłówkom `X-Forwarded-*`, więc nikt nie podrobi swojego IP, żeby obejść limit prób. Włącza się je zmienną `TRUST_PROXY` dopiero przy wystawieniu przez proxy (sekcja 8a).
- Ochrona stron: middleware `requireLogin` przekierowuje na `/login.html`; strony `admin-*.html` i `/api/admin/*` tylko dla `manager`/`admin` (Ustawienia i Pracownicy tylko `admin`).

## 6. Poczta (SMTP)

Adresy i dane serwera wpisujesz w **Ustawienia → Poczta wychodząca** (zapis do `settings`, test wysyłki przyciskiem). E-maile:

| Zdarzenie | Do kogo | Treść |
|---|---|---|
| Zaproszenie | nowy pracownik | link `APP_URL/rejestracja.html?token=…`, ważny 7 dni |
| Reset hasła | pracownik | link ważny 1 godzinę, jednorazowy |
| Nowy wniosek | przełożony / admini | termin, dni, zastępca, przyciski do panelu |
| Decyzja | pracownik | zatwierdzony / odrzucony z powodem, załącznik `.ics` |
| Prośba o anulowanie | przełożony | dot. zatwierdzonego urlopu w przyszłości |
| Przypomnienie | pracownik | 1 lipca: niewykorzystany zaległy urlop |
| Zestawienie | wszyscy / admini | poniedziałek 7:00, kto jest nieobecny w tygodniu |

Wysyłkę robić asynchronicznie z prostą kolejką w tabeli (ponowienie przy błędzie SMTP), żeby awaria poczty nie blokowała zatwierdzania.

## 7. API

```
POST /login · POST /logout
POST /rejestracja                      { token, first_name, last_name, password }
POST /reset-hasla                      { email }          → zawsze 303 ?sent=1
POST /reset-hasla/nowe                 { token, password }

GET  /api/me
GET  /api/me/balance?year=2026         → { allowance, carried, used, pending, left, onDemandUsed }
GET  /api/me/requests?year=2026
POST /api/requests                     { date_from, date_to, type, substitute_id, note }
POST /api/requests/:id/cancel
GET  /api/calendar?from=&to=           → święta, dni wolne firmy, moje wnioski, nieobecni (imiona)

GET  /api/admin/requests?status=pending
POST /api/admin/requests/:id/approve
POST /api/admin/requests/:id/reject    { reason }
GET  /api/admin/users?year=
POST /api/admin/invitations            { email, first_name, last_name, role, days, carry }
POST /api/admin/invitations/:id/resend
PATCH /api/admin/users/:id             { role, state, manager_id }
PUT  /api/admin/allowances/:userId/:year { days, carry_override }
POST /api/admin/allowances/copy        { from, to }
GET|PUT /api/admin/settings
POST /api/admin/settings/smtp-test     { to }
GET|PUT /api/admin/days-off/:year
GET  /api/admin/export?year=           → CSV/XLSX dla kadr
```

## 8. Docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++ tzdata   # kompilacja better-sqlite3 / argon2
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production TZ=Europe/Warsaw
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
```

```yaml
services:
  urlopy:
    build: .
    restart: unless-stopped
    ports: ["1003:3000"]            # port do ustalenia (mapa360 używa 1002); dostęp z LAN
    env_file: .env                  # SESSION_SECRET, SETTINGS_KEY, APP_URL, ADMIN_EMAIL
    volumes: ["./data:/app/data"]   # urlopy.sqlite + sesje
```

`TZ=Europe/Warsaw` jest ważne: daty urlopów to daty lokalne, bez niego cron i „dzisiaj” będą przesunięte. Daty trzymać jako tekst `YYYY-MM-DD`, nigdy jako znacznik czasu UTC.

Pierwsze uruchomienie: jeśli w bazie nie ma admina, serwer tworzy zaproszenie dla `ADMIN_EMAIL` i wypisuje link w logach kontenera (działa nawet bez skonfigurowanego SMTP).

`APP_URL` to adres serwera w LAN, np. `http://192.168.88.X:1003` albo nazwa z firmowego DNS. Ten adres trafia do linków w e-mailach (zaproszenie, reset hasła), więc linki działają tylko z komputerów w sieci firmy.

Kopia zapasowa: codziennie `sqlite3 data/urlopy.sqlite ".backup data/backup/urlopy-$(date +%F).sqlite"` z hosta (cron), trzymać np. 30 dni.

## 8a. Sieć: tylko LAN

- Aplikacja działa po HTTP pod adresem serwera w LAN. Hasła i ciasteczka idą po sieci firmowej bez szyfrowania — akceptowalne w zaufanej sieci; przeglądarka może oznaczać stronę jako „Niezabezpieczona”.
- Opcjonalnie później: HTTPS w LAN (np. Caddy z certyfikatem z wewnętrznego CA) — ciasteczko dostanie wtedy `Secure` automatycznie.
- **Wystawienie do internetu (później, nie teraz):** reverse proxy (Pangolin) z HTTPS, w `.env` `TRUST_PROXY` = dokładny adres proxy, port w compose tylko dla proxy (np. `127.0.0.1:1003:3000`), `APP_URL` = adres publiczny.

## 9. Kolejność prac

1. Szkielet Express, serwowanie `public/`, migracja bazy, konfiguracja Dockera.
2. Logowanie, sesje, wylogowanie, ochrona stron, pierwszy admin z `.env`.
3. Ustawienia SMTP + test wysyłki, zaproszenia, rejestracja, reset hasła.
4. Pracownicy i wymiar urlopu, kopiowanie wymiaru na nowy rok, wyliczanie zaległego.
5. Panel pracownika: saldo, kalendarz (`/api/calendar`), składanie i wycofywanie wniosków.
6. Akceptacja wniosków, e-maile z decyzją, wykrywanie kolizji.
7. Dni wolne w firmie, przeliczanie wniosków, eksport CSV.
8. Cron: przypomnienia i zestawienie tygodniowe, log audytowy, kopie zapasowe.

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
