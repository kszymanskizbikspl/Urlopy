// Krok 5: saldo pracownika, składanie i wycofywanie wniosków, kalendarz, lista osób do zastępstwa.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const PL = require('../public/js/holidays.js');
const { startServer } = require('./helpers');

const CY = new Date().getFullYear();
const NY = CY + 1;                       // przyszły rok — wnioski na pewno jeszcze się nie zaczęły

/** n dni roboczych od pierwszego dnia roboczego miesiąca → { from, to } */
function range(y, month, n, startDay = 1) {
  let d = new Date(y, month - 1, startDay);
  while (!PL.isWorkingDay(d)) d = PL.addDays(d, 1);
  const from = PL.iso(d);
  for (let k = 1; k < n;) { d = PL.addDays(d, 1); if (PL.isWorkingDay(d)) k++; }
  return { from, to: PL.iso(d) };
}
/** Pierwsza sobota miesiąca (dzień bez pracy) */
function saturday(y, month) {
  let d = new Date(y, month - 1, 1);
  while (d.getDay() !== 6) d = PL.addDays(d, 1);
  return PL.iso(d);
}

let s, admin;
let n = 0;
const email = () => `p${++n}@test.pl`;

before(async () => {
  s = await startServer();
  await s.addUser({ email: 'admin@test.pl', role: 'admin', first: 'Ada', last: 'Admin' });
  admin = await s.login('admin@test.pl');
});
after(() => s && s.stop());

/** Nowy pracownik z pulą na rok NY (i opcjonalnie CY), zalogowany */
async function employee({ days = 26, years = [NY], first = 'Jan', last = 'Kowalski' } = {}) {
  const em = email();
  const id = await s.addUser({ email: em, first, last });
  for (const y of years) s.setAllowance(id, y, days);
  return { id, c: await s.login(em) };
}
const post = (c, body) => c.req('POST', '/api/requests', body);
const reqBody = (r, type = 'wypoczynkowy', extra = {}) => ({ date_from: r.from, date_to: r.to, type, ...extra });

// ---------- saldo ----------
test('GET /api/me/balance: saldo, limity; rok bez puli → balance null', async () => {
  const { c } = await employee({ days: 20 });
  let r = await c.get(`/api/me/balance?year=${NY}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.balance.left, 20);
  assert.deepEqual(r.body.typeUsed, { na_zadanie: 0, opieka_188: 0, sila_wyzsza: 0 });
  assert.deepEqual(r.body.limits, { na_zadanie: 4, opieka_188: 2, sila_wyzsza: 2 });
  r = await c.get(`/api/me/balance?year=${NY + 1}`);
  assert.equal(r.body.balance, null);
  assert.equal((await c.get('/api/me/balance?year=abc')).status, 400);
});

// ---------- składanie ----------
test('POST /api/requests: dni liczy serwer (bez weekendów, świąt i dni wolnych w firmie), ignoruje „days” z przeglądarki', async () => {
  const { c } = await employee();
  const r5 = range(NY, 3, 5, 2);              // 5 dni roboczych w marcu
  s.db.prepare('INSERT INTO company_days_off (date, name) VALUES (?, ?)').run(r5.from, 'Dzień wolny za święto');
  const r = await post(c, { ...reqBody(r5), days: 1 });
  assert.equal(r.status, 201);
  assert.equal(r.body.request.days, 4);
  assert.equal(r.body.request.status, 'pending');
  const b = (await c.get(`/api/me/balance?year=${NY}`)).body.balance;
  assert.equal(b.pending, 4);
  assert.equal(b.left, 22);
  s.db.prepare('DELETE FROM company_days_off WHERE date = ?').run(r5.from); // nie wpływa na terminy w kolejnych testach
});

test('POST /api/requests: walidacja dat, rodzaju i zastępcy → 400', async () => {
  const { id, c } = await employee();
  const off = await s.addUser({ email: email(), state: 'disabled' });
  const ok = range(NY, 4, 2);
  const cases = [
    [{ date_from: 'jutro', date_to: ok.to }, 'zła data'],
    [{ date_from: `${NY}-02-30`, date_to: `${NY}-03-02` }, 'nieistniejąca data'],
    [{ date_from: ok.to, date_to: ok.from }, 'od > do'],
    [{ date_from: `${NY}-12-30`, date_to: `${NY + 1}-01-05` }, 'dwa lata'],
    [{ date_from: `${CY + 2}-03-02`, date_to: `${CY + 2}-03-03` }, 'za daleko w przyszłości'],
    [{ date_from: `${CY - 2}-03-02`, date_to: `${CY - 2}-03-03` }, 'za daleko wstecz'],
    [{ ...reqBody(ok, 'chorobowe') }, 'nieznany rodzaj'],
    [{ date_from: saturday(NY, 5), date_to: saturday(NY, 5) }, 'brak dni roboczych'],
    [{ ...reqBody(ok), substitute_id: id }, 'sam sobie zastępcą'],
    [{ ...reqBody(ok), substitute_id: off }, 'zastępca wyłączony'],
    [{ ...reqBody(ok), substitute_id: 99999 }, 'zastępca nie istnieje'],
  ];
  for (const [body, label] of cases) {
    const r = await post(c, { type: 'wypoczynkowy', ...body });
    assert.equal(r.status, 400, label);
  }
  assert.equal(s.db.prepare('SELECT COUNT(*) FROM leave_requests WHERE user_id = ?').pluck().get(id), 0);
});

test('POST /api/requests: zastępca i uwagi zapisane, widoczne w /api/me/requests', async () => {
  const { c } = await employee();
  const sub = await s.addUser({ email: email(), first: 'Marta', last: 'Wiśniewska' });
  const r = await post(c, reqBody(range(NY, 5, 2), 'wypoczynkowy', { substitute_id: String(sub), note: '  Przekazane Marcie.  ' }));
  assert.equal(r.status, 201);
  const list = (await c.get('/api/me/requests')).body;
  assert.equal(list.requests.length, 1);
  assert.equal(list.requests[0].substitute, 'Marta Wiśniewska');
  assert.equal(list.requests[0].note, 'Przekazane Marcie.');
  assert.match(list.today, /^\d{4}-\d{2}-\d{2}$/);
});

test('POST /api/requests: kolizja z własnym czekającym / zatwierdzonym → 409; z odrzuconym i wycofanym — OK', async () => {
  const { id, c } = await employee();
  const a = range(NY, 6, 5);
  assert.equal((await post(c, reqBody(a))).status, 201);
  const overlap = { from: a.to, to: range(NY, 6, 7).to };
  const r = await post(c, reqBody(overlap));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /pokrywa się/);
  // inne statusy nie blokują terminu
  const b = range(NY, 7, 2);
  s.addRequest(id, { from: b.from, to: b.to, days: 2, status: 'rejected' });
  s.addRequest(id, { from: b.from, to: b.to, days: 2, status: 'cancelled' });
  assert.equal((await post(c, reqBody(b))).status, 201);
});

test('POST /api/requests: brak puli albo za mało dni → 409; urlop poza pulą bez salda — OK', async () => {
  const { c } = await employee({ days: 3 });
  assert.equal((await post(c, reqBody(range(NY, 8, 4)))).status, 409, 'za mało dni');
  assert.equal((await post(c, reqBody(range(NY, 8, 3)))).status, 201, 'dokładnie tyle, ile zostało');
  assert.equal((await post(c, reqBody(range(NY, 9, 1), 'na_zadanie'))).status, 409, 'na żądanie też z puli');
  assert.equal((await post(c, reqBody(range(NY, 9, 10), 'bezplatny'))).status, 201, 'bezpłatny poza pulą');
  const r = await post(c, reqBody(range(CY, 10, 1)));
  assert.equal(r.status, 409, 'brak puli na bieżący rok');
  assert.match(r.body.error, /puli urlopu/);
});

test('POST /api/requests: wniosek na jeden rok nie może zabrać zaległego, na którym opiera się następny', async () => {
  const { id, c } = await employee({ years: [CY, NY] });
  s.addRequest(id, { ...range(CY, 2, 1), days: 20, status: 'approved' });   // CY: zostaje 6 → zaległy na NY
  s.addRequest(id, { ...range(NY, 2, 1), days: 30, status: 'approved' });   // NY: 26 + 6 − 30 = 2
  // 5 dni w CY: w CY wystarcza (6), ale NY spadłby do −3
  let r = await post(c, reqBody(range(CY, 3, 5)));
  assert.equal(r.status, 409);
  assert.match(r.body.error, new RegExp(`zaległy urlop przenoszony na ${NY}`));
  assert.equal(s.db.prepare("SELECT COUNT(*) FROM leave_requests WHERE user_id = ? AND status = 'pending'").pluck().get(id), 0, 'wycofane w transakcji');
  // 2 dni w CY: NY zostaje na 0 — OK
  assert.equal((await post(c, reqBody(range(CY, 4, 2)))).status, 201);
  // Czekające 2 dni z CY zmniejszą zaległy: w NY oficjalnie zostały 2, ale bezpiecznie 0
  const bal = (await c.get(`/api/me/balance?year=${NY}`)).body;
  assert.equal(bal.balance.left, 2);
  assert.equal(bal.available, 0);
  r = await post(c, reqBody(range(NY, 5, 1)));
  assert.equal(r.status, 409);
  assert.match(r.body.error, new RegExp(`czekające wnioski z ${CY}`));
});

test('POST /api/requests: kolejny rok już na minusie nie blokuje wniosku, który go nie pogarsza', async () => {
  const { id, c } = await employee({ years: [CY] });
  s.setAllowance(id, NY, 26, 0);                                            // NY: ręczny zaległy 0 — nie zależy od CY
  s.addRequest(id, { ...range(NY, 2, 1), days: 30, status: 'approved' });   // NY: 26 − 30 = −4 (np. admin zmniejszył wymiar)
  assert.equal((await post(c, reqBody(range(CY, 3, 2)))).status, 201, 'wniosek w CY nie zmienia NY — przechodzi');
  // NY z automatycznym zaległym: teraz zależy od CY
  s.setAllowance(id, NY, 26, null);                                         // zaległy na NY = 26 − 2 = 24 → NY = 26 + 24 − 30 = 20
  s.addRequest(id, { ...range(NY, 4, 1), days: 20, status: 'approved' });   // NY = 0
  assert.equal((await post(c, reqBody(range(CY, 4, 1)))).status, 409, 'zabrałby zaległy, z którego NY wychodzi na zero');
});

test('POST /api/requests: zastępca i uwagi tylko jako liczba / tekst', async () => {
  const { c } = await employee();
  const sub = await s.addUser({ email: email() });
  const ok = range(NY, 10, 1);
  assert.equal((await post(c, reqBody(ok, 'wypoczynkowy', { substitute_id: true }))).status, 400);
  assert.equal((await post(c, reqBody(ok, 'wypoczynkowy', { substitute_id: ` ${sub} ` }))).status, 400);
  assert.equal((await post(c, reqBody(ok, 'wypoczynkowy', { substitute_id: 1.5 }))).status, 400);
  assert.equal((await post(c, reqBody(ok, 'wypoczynkowy', { note: {} }))).status, 400);
  assert.equal((await post(c, reqBody(ok, 'wypoczynkowy', { note: 5 }))).status, 400);
  assert.equal((await post(c, reqBody(ok, 'wypoczynkowy', { substitute_id: sub, note: null }))).status, 201);
});

test('POST /api/requests: limity rodzajów (na żądanie 4, opieka 2, siła wyższa 2)', async () => {
  const { id, c } = await employee();
  s.addRequest(id, { ...range(NY, 2, 3), days: 3, type: 'na_zadanie', status: 'approved' });
  const r = await post(c, reqBody(range(NY, 3, 2), 'na_zadanie'));
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Limit/);
  assert.equal((await post(c, reqBody(range(NY, 3, 1), 'na_zadanie'))).status, 201, 'czwarty dzień — OK');
  assert.equal((await post(c, reqBody(range(NY, 4, 3), 'opieka_188'))).status, 409);
  assert.equal((await post(c, reqBody(range(NY, 4, 2), 'opieka_188'))).status, 201);
  assert.equal((await post(c, reqBody(range(NY, 5, 3), 'sila_wyzsza'))).status, 409);
  const used = (await c.get(`/api/me/balance?year=${NY}`)).body.typeUsed;
  assert.deepEqual(used, { na_zadanie: 4, opieka_188: 2, sila_wyzsza: 0 });
});

test('POST /api/requests: daty w przeszłości dozwolone (decyzja: dowolne daty w roku)', async () => {
  const { c } = await employee({ years: [CY, NY] });
  const past = range(CY, 1, 1, 8);
  if (past.from >= PL.iso(new Date())) return; // na początku stycznia nie ma jeszcze przeszłości w tym roku
  assert.equal((await post(c, reqBody(past, 'opieka_188'))).status, 201);
});

// ---------- wycofanie ----------
test('cancel: czekający → wycofany, saldo wraca', async () => {
  const { c } = await employee();
  const r = await post(c, reqBody(range(NY, 3, 2)));
  const x = await c.req('POST', `/api/requests/${r.body.request.id}/cancel`);
  assert.equal(x.status, 200);
  assert.equal(x.body.status, 'cancelled');
  assert.equal((await c.get(`/api/me/balance?year=${NY}`)).body.balance.left, 26);
  assert.equal((await c.req('POST', `/api/requests/${r.body.request.id}/cancel`)).status, 409, 'drugi raz');
});

test('cancel: zatwierdzony w przyszłości → prośba o anulowanie (urlop nadal liczy się jako wykorzystany)', async () => {
  const { id, c } = await employee();
  const rid = Number(s.addRequest(id, { ...range(NY, 4, 3), days: 3, status: 'approved' }).lastInsertRowid);
  const x = await c.req('POST', `/api/requests/${rid}/cancel`);
  assert.equal(x.status, 200);
  assert.equal(x.body.status, 'cancel_requested');
  const b = (await c.get(`/api/me/balance?year=${NY}`)).body.balance;
  assert.equal(b.used, 3);
  const again = await c.req('POST', `/api/requests/${rid}/cancel`);
  assert.equal(again.status, 409);
  assert.match(again.body.error, /czeka na decyzję/);
});

test('cancel: zatwierdzony, który już się zaczął, i odrzucony → 409; cudzy wniosek → 404', async () => {
  const { id, c } = await employee({ years: [CY, NY] });
  const today = PL.iso(new Date());
  const started = Number(s.addRequest(id, { from: today, to: today, days: 1, status: 'approved', type: 'bezplatny' }).lastInsertRowid);
  const r1 = await c.req('POST', `/api/requests/${started}/cancel`);
  assert.equal(r1.status, 409);
  assert.match(r1.body.error, /zaczął/);
  const rejected = Number(s.addRequest(id, { ...range(NY, 5, 1), days: 1, status: 'rejected' }).lastInsertRowid);
  assert.equal((await c.req('POST', `/api/requests/${rejected}/cancel`)).status, 409);

  const other = await employee();
  const theirs = Number(s.addRequest(other.id, { ...range(NY, 6, 1), days: 1, status: 'pending' }).lastInsertRowid);
  assert.equal((await c.req('POST', `/api/requests/${theirs}/cancel`)).status, 404);
  assert.equal(s.db.prepare('SELECT status FROM leave_requests WHERE id = ?').pluck().get(theirs), 'pending');
  assert.equal((await c.req('POST', '/api/requests/abc/cancel')).status, 404);
});

test('/api/me/requests pokazuje tylko własne wnioski', async () => {
  const a = await employee(), b = await employee();
  s.addRequest(b.id, { ...range(NY, 7, 1), days: 1, status: 'pending' });
  assert.equal((await a.c.get('/api/me/requests')).body.requests.length, 0);
});

// ---------- kalendarz ----------
test('GET /api/calendar: dni wolne w firmie; urlopy innych tylko zatwierdzone i tylko gdy admin pozwala', async () => {
  const me = await employee({ first: 'Ewa', last: 'Ja' });
  const colleague = await employee({ first: 'Piotr', last: 'Nowak' });
  const pend = await employee({ first: 'Zofia', last: 'Czeka' });
  const off = await employee({ first: 'Olek', last: 'Wyłączony' });
  const r = range(NY, 11, 3, 10);
  s.addRequest(colleague.id, { ...r, days: 3, status: 'approved' });
  s.addRequest(pend.id, { ...r, days: 3, status: 'pending' });
  s.addRequest(me.id, { ...r, days: 3, status: 'approved' });
  s.addRequest(off.id, { ...r, days: 3, status: 'approved' });
  s.db.prepare("UPDATE users SET state = 'disabled' WHERE id = ?").run(off.id);
  s.db.prepare('INSERT OR IGNORE INTO company_days_off (date, name) VALUES (?, ?)').run(`${NY}-11-10`, 'Za 15 sierpnia');

  const q = `/api/calendar?from=${NY}-11-01&to=${NY}-11-30`;
  let cal = (await me.c.get(q)).body;
  assert.equal(cal.showAbsent, true);
  assert.deepEqual(cal.daysOff, [{ date: `${NY}-11-10`, name: 'Za 15 sierpnia' }]);
  assert.deepEqual(cal.absent.map(a => a.name), ['Piotr Nowak']);
  assert.deepEqual(Object.keys(cal.absent[0]).sort(), ['date_from', 'date_to', 'name'], 'bez rodzaju urlopu i uwag');

  assert.equal((await admin.req('PUT', '/api/admin/settings', { show_absent: false })).status, 200);
  cal = (await me.c.get(q)).body;
  assert.equal(cal.showAbsent, false);
  assert.deepEqual(cal.absent, []);
  await admin.req('PUT', '/api/admin/settings', { show_absent: true });

  assert.equal((await me.c.get('/api/calendar?from=x&to=y')).status, 400);
  assert.equal((await me.c.get(`/api/calendar?from=${NY}-12-01&to=${NY}-11-01`)).status, 400);
  assert.equal((await me.c.get(`/api/calendar?from=${CY - 5}-01-01&to=${NY}-12-31`)).status, 400, 'za długi zakres');
});

// ---------- osoby ----------
test('GET /api/people: aktywne osoby bez mnie, po polsku alfabetycznie', async () => {
  const s2 = await startServer();
  try {
    await s2.addUser({ email: 'ja@test.pl', first: 'Jan', last: 'Ja' });
    await s2.addUser({ email: 'z@test.pl', first: 'Żaneta', last: 'Żak' });
    await s2.addUser({ email: 'l@test.pl', first: 'Łukasz', last: 'Łącki' });
    await s2.addUser({ email: 'a@test.pl', first: 'Adam', last: 'Lis' });
    await s2.addUser({ email: 'off@test.pl', first: 'Off', last: 'Off', state: 'disabled' });
    await s2.addUser({ email: 'inv@test.pl', first: 'Inv', last: 'Inv', state: 'invited' });
    const c = await s2.login('ja@test.pl');
    const people = (await c.get('/api/people')).body.people.map(p => p.name);
    assert.deepEqual(people, ['Adam Lis', 'Łukasz Łącki', 'Żaneta Żak']);
  } finally {
    await s2.stop();
  }
});

test('API pracownika wymaga logowania i tokenu CSRF', async () => {
  assert.equal((await s.raw('GET', '/api/me/balance')).status, 401);
  assert.equal((await s.raw('POST', '/api/requests', { body: {} })).status, 401);
  const { c } = await employee();
  assert.equal((await c.req('POST', '/api/requests', reqBody(range(NY, 3, 1)), { csrf: false })).status, 403);
});
