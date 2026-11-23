// Krok 7: dni wolne w firmie (zapis, walidacja, przeliczanie wniosków) i eksport CSV dla kadr.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const PL = require('../public/js/holidays.js');
const { startServer } = require('./helpers');

const CY = new Date().getFullYear();
const NY = CY + 1;
function range(y, month, n, startDay = 1) {
  let d = new Date(y, month - 1, startDay);
  while (!PL.isWorkingDay(d)) d = PL.addDays(d, 1);
  const from = PL.iso(d);
  for (let k = 1; k < n;) { d = PL.addDays(d, 1); if (PL.isWorkingDay(d)) k++; }
  return { from, to: PL.iso(d) };
}
const nextWorking = iso => { let d = PL.addDays(PL.parse(iso), 1); while (!PL.isWorkingDay(d)) d = PL.addDays(d, 1); return PL.iso(d); };

let s, admin;
let n = 0;
const email = () => `d${++n}@test.pl`;
before(async () => {
  s = await startServer();
  await s.addUser({ email: 'admin@test.pl', role: 'admin', first: 'Ada', last: 'Admin' });
  admin = await s.login('admin@test.pl');
});
after(() => s && s.stop());

const getOff = y => admin.get(`/api/admin/days-off/${y}`);
const putOff = (y, body) => admin.req('PUT', `/api/admin/days-off/${y}`, body);

// ---------- dni wolne ----------
test('GET: święta w sobotę w roku (2026: 15 sierpnia i 26 grudnia)', async () => {
  const r = await getOff(2026);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.saturdays.map(x => [x.date, x.replacement]), [['2026-08-15', null], ['2026-12-26', null]]);
  assert.deepEqual(r.body.extra, []);
});

test('PUT: dzień w zamian za sobotę i inne dni wolne; widoczne w kalendarzu pracownika', async () => {
  const r = await putOff(2026, {
    replacements: { '2026-08-15': '2026-11-10', '2026-12-26': '' },
    extra: [{ date: '2026-12-31', name: 'Sylwester' }, { date: '', name: '' }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.saturdays[0].replacement, '2026-11-10');
  assert.equal(r.body.saturdays[1].replacement, null);
  assert.deepEqual(r.body.extra, [{ date: '2026-12-31', name: 'Sylwester' }]);
  const row = s.db.prepare("SELECT name, for_holiday FROM company_days_off WHERE date = '2026-11-10'").get();
  assert.equal(row.for_holiday, '2026-08-15');
  assert.match(row.name, /Wniebowzięcie NMP \(15\/08\/2026\)/);

  const em = email();
  await s.addUser({ email: em });
  const c = await s.login(em);
  const cal = (await c.get('/api/calendar?from=2026-11-01&to=2026-12-31')).body;
  assert.deepEqual(cal.daysOff.map(d => d.date), ['2026-11-10', '2026-12-31']);
  // ponowny zapis zastępuje rok (nie dopisuje)
  assert.equal((await putOff(2026, { replacements: {}, extra: [] })).status, 200);
  assert.equal(s.db.prepare("SELECT COUNT(*) FROM company_days_off WHERE substr(date, 1, 4) = '2026'").pluck().get(), 0);
});

test('PUT: walidacja → 400, nic nie zapisane', async () => {
  const bad = [
    [{ replacements: { '2026-08-15': '2026-11-14' } }, /sobota/],                       // sobota
    [{ replacements: { '2026-08-15': '2026-11-11' } }, /święto/],                       // 11 listopada
    [{ replacements: { '2026-08-15': '2027-01-04' } }, /2026/],                         // inny rok
    [{ replacements: { '2026-08-16': '2026-11-10' } }, /nie jest świętem w sobotę/],    // to nie święto w sobotę
    [{ extra: [{ date: '2026-12-31', name: 'A' }, { date: '2026-12-31', name: 'B' }] }, /więcej niż raz/],
    [{ replacements: { '2026-08-15': '2026-12-31' }, extra: [{ date: '2026-12-31', name: 'B' }] }, /więcej niż raz/],
    [{ extra: [{ date: '', name: 'Bez daty' }] }, /wybierz datę/],
    [{ extra: [{ date: '2026-12-31', name: 'x'.repeat(101) }] }, /100 znaków/],
    [{ extra: 'nie-tablica' }, /Nieprawidłowe/],
    [{ replacements: [] }, /Nieprawidłowe/],
  ];
  for (const [body, msg] of bad) {
    const r = await putOff(2026, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, msg);
  }
  assert.equal(s.db.prepare("SELECT COUNT(*) FROM company_days_off WHERE substr(date, 1, 4) = '2026'").pluck().get(), 0);
  assert.equal((await admin.get('/api/admin/days-off/1999')).status, 400);
});

test('dni wolne tylko dla admina', async () => {
  const em = email();
  await s.addUser({ email: em, role: 'manager' });
  const c = await s.login(em);
  assert.equal((await c.get(`/api/admin/days-off/${NY}`)).status, 403);
  assert.equal((await c.req('PUT', `/api/admin/days-off/${NY}`, { extra: [] })).status, 403);
  assert.equal((await c.get(`/api/admin/export?year=${NY}`)).status, 403);
});

test('przeliczanie: dodanie dnia wolnego zmniejsza dni we wniosku, usunięcie przywraca', async () => {
  const em = email();
  const id = await s.addUser({ email: em, first: 'Ewa', last: 'Przeliczana' });
  s.setAllowance(id, NY, 26);
  const c = await s.login(em);
  const rg = range(NY, 3, 5, 8);
  const rid = (await c.req('POST', '/api/requests', { date_from: rg.from, date_to: rg.to, type: 'wypoczynkowy' })).body.request.id;
  const off = nextWorking(rg.from);
  let r = await putOff(NY, { extra: [{ date: off, name: 'Dzień wolny' }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.changed.map(x => [x.id, x.old, x.days, x.employee]), [[rid, 5, 4, 'Ewa Przeliczana']]);
  assert.equal((await c.get(`/api/me/balance?year=${NY}`)).body.balance.pending, 4);
  r = await putOff(NY, { extra: [] });
  assert.deepEqual(r.body.changed.map(x => [x.id, x.old, x.days]), [[rid, 4, 5]]);
  const audit = JSON.parse(s.db.prepare("SELECT details FROM audit_log WHERE action = 'days_off_saved' ORDER BY id DESC LIMIT 1").pluck().get());
  assert.deepEqual(audit.recalculated, [{ id: rid, old: 4, days: 5 }]);
});

test('przeliczanie: zakończone urlopy i inne statusy bez zmian; ujemna pula zgłoszona', async () => {
  const id = await s.addUser({ email: email(), first: 'Olek', last: 'Minus' });
  s.setAllowance(id, NY, 5);
  const rg = range(NY, 6, 6, 8);                                  // 6 dni roboczych
  const off = nextWorking(rg.from);
  // zatwierdzony urlop, który przy dniu wolnym liczył 5 dni (cała pula)
  const appr = Number(s.addRequest(id, { ...rg, days: 5, status: 'approved' }).lastInsertRowid);
  const rej = Number(s.addRequest(id, { ...range(NY, 7, 2, 8), days: 2, status: 'rejected' }).lastInsertRowid);
  // zakończony urlop z zeszłego roku — zapis dni wolnych na tamten rok go nie zmienia
  const old = Number(s.addRequest(id, { from: `${CY - 1}-03-02`, to: `${CY - 1}-03-06`, days: 5, status: 'approved' }).lastInsertRowid);
  assert.equal((await putOff(CY - 1, { extra: [{ date: `${CY - 1}-03-04`, name: 'Wstecz' }] })).body.changed.length, 0);
  assert.equal(s.db.prepare('SELECT days FROM leave_requests WHERE id = ?').pluck().get(old), 5);
  await putOff(CY - 1, { extra: [] });

  await putOff(NY, { extra: [{ date: off, name: 'Dzień wolny' }] });  // 6 → 5, pula 0
  const r = await putOff(NY, { extra: [] });                          // 5 → 6, pula −1
  assert.ok(r.body.changed.some(x => x.id === appr && x.days === 6));
  assert.ok(!r.body.changed.some(x => x.id === rej), 'odrzucony bez zmian');
  assert.deepEqual(r.body.problems, [{ kind: 'pool', user_id: id, employee: 'Olek Minus', year: NY, left: -1 }]);
});

test('przeliczanie: zgłasza minus w kolejnym roku (mniejszy zaległy) i przekroczony limit', async () => {
  const s2 = await startServer();
  try {
    await s2.addUser({ email: 'a@test.pl', role: 'admin' });
    const c = await s2.login('a@test.pl');
    const id = await s2.addUser({ email: 'p@test.pl', first: 'Piotr', last: 'Zaległy' });
    s2.setAllowance(id, NY, 10);
    s2.setAllowance(id, NY + 1, 0);                                    // NY+1: tylko zaległy z NY
    const rg = range(NY, 3, 4, 8);                                     // 4 dni robocze
    const off = nextWorking(rg.from);
    await c.req('PUT', `/api/admin/days-off/${NY}`, { extra: [{ date: off, name: 'X' }] });
    s2.addRequest(id, { ...rg, days: 3, status: 'pending' });          // przy dniu wolnym: 3
    s2.addRequest(id, { ...range(NY + 1, 2, 1), days: 7, status: 'approved' }); // NY+1: 0 + (10 − 3) − 7 = 0
    // na żądanie: 4 dni (limit), jeden z nich na dniu wolnym → po usunięciu dnia wolnego 5
    const nz = range(NY, 5, 5, 11);
    const nzOff = nextWorking(nz.from);
    await c.req('PUT', `/api/admin/days-off/${NY}`, { extra: [{ date: off, name: 'X' }, { date: nzOff, name: 'Y' }] });
    s2.addRequest(id, { ...nz, days: 4, type: 'na_zadanie', status: 'approved' });

    const r = await c.req('PUT', `/api/admin/days-off/${NY}`, { extra: [] });
    assert.equal(r.status, 200);
    const kinds = r.body.problems.map(p => (p.kind === 'pool' ? `pool:${p.year}:${p.left}` : `limit:${p.type}:${p.used}/${p.limit}`)).sort();
    // NY: 10 − 4 − 5 = 1 (bez minusa); NY+1: zaległy 10 − 4 − 5 = 1 → 1 − 7 = −6
    assert.deepEqual(kinds, [`limit:na_zadanie:5/4`, `pool:${NY + 1}:-6`]);
  } finally {
    await s2.stop();
  }
});

test('przeliczanie: wniosek, który cały wypadł na dzień wolny → 0 dni, oznaczony; nie da się go zatwierdzić; nie trafia do eksportu', async () => {
  const id = await s.addUser({ email: email(), first: 'Zenon', last: 'Zero' });
  s.setAllowance(id, NY, 26);
  const day = range(NY, 9, 1, 14).from;
  const pend = Number(s.addRequest(id, { from: day, to: day, days: 1, status: 'pending' }).lastInsertRowid);
  const appr = Number(s.addRequest(id, { from: nextWorking(day), to: nextWorking(day), days: 1, status: 'approved' }).lastInsertRowid);
  const r = await putOff(NY, { extra: [{ date: day, name: 'A' }, { date: nextWorking(day), name: 'B' }] });
  const z = r.body.changed.filter(c => c.zero).map(c => c.id).sort();
  assert.deepEqual(z, [pend, appr].sort());
  const ap = await admin.req('POST', `/api/admin/requests/${pend}/approve`, {});
  assert.equal(ap.status, 409);
  assert.match(ap.body.error, /żadnego dnia roboczego/);
  assert.equal((await admin.req('POST', `/api/admin/requests/${pend}/reject`, { reason: 'Dzień wolny w firmie' })).status, 200, 'odrzucić można');
  const csv = Buffer.from(await (await s.raw('GET', `/api/admin/export?kind=requests&year=${NY}`, { headers: { Cookie: admin.cookie } })).arrayBuffer()).toString('utf8');
  assert.ok(!csv.includes('Zero;Zenon'), 'zatwierdzony z 0 dni pominięty w eksporcie');
  await putOff(NY, { extra: [] });
});

test('PUT: elementy „extra” muszą być obiektami (np. same daty → 400, nic nie skasowane)', async () => {
  assert.equal((await putOff(2026, { extra: [{ date: '2026-12-31', name: 'Sylwester' }] })).status, 200);
  for (const extra of [['2026-12-31'], [5], [null], [['2026-12-31']], [{ date: '2026-12-31', name: 5 }]]) {
    const r = await putOff(2026, { extra });
    assert.equal(r.status, 400, JSON.stringify(extra));
  }
  assert.equal(s.db.prepare("SELECT COUNT(*) FROM company_days_off WHERE date = '2026-12-31'").pluck().get(), 1);
  await putOff(2026, { extra: [] });
});

// ---------- eksport ----------
const parseCsv = text => text.replace(/^﻿/, '').trim().split('\r\n').map(l => l.split(';'));

test('eksport: podsumowanie — BOM, średnik, liczby, bez osób bez puli i urlopu', async () => {
  const s2 = await startServer();
  try {
    await s2.addUser({ email: 'a@test.pl', role: 'admin', first: 'Ada', last: 'Admin' });
    const c = await s2.login('a@test.pl');
    const id = await s2.addUser({ email: 'zofia@test.pl', first: 'Zofia', last: 'Żak' });
    const id2 = await s2.addUser({ email: 'lech@test.pl', first: 'Lech', last: 'Łącki', state: 'disabled' });
    await s2.addUser({ email: 'inv@test.pl', state: 'invited' });
    s2.setAllowance(id, CY - 1, 20);
    s2.setAllowance(id, CY, 26);
    s2.setAllowance(id2, CY, 20);
    s2.addRequest(id, { from: `${CY}-02-02`, to: `${CY}-02-04`, days: 3, status: 'approved' });
    s2.addRequest(id, { from: `${CY}-02-09`, to: `${CY}-02-09`, days: 1, type: 'na_zadanie', status: 'cancel_requested' });
    s2.addRequest(id, { from: `${CY}-03-02`, to: `${CY}-03-03`, days: 2, type: 'okolicznosciowy', status: 'approved' });
    s2.addRequest(id, { from: `${CY}-04-01`, to: `${CY}-04-02`, days: 2, status: 'pending' });
    const res = await s2.raw('GET', `/api/admin/export?kind=summary&year=${CY}`, { headers: { Cookie: c.cookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv; charset=utf-8/);
    assert.match(res.headers.get('content-disposition'), new RegExp(`attachment; filename="urlopy-podsumowanie-${CY}.csv"`));
    // res.text() usuwa BOM — sprawdzamy surowe bajty (EF BB BF)
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM dla Excela');
    const rows = parseCsv(bytes.toString('utf8'));
    assert.equal(rows[0][0], 'Nazwisko');
    assert.equal(rows.length, 3, 'nagłówek + Łącki + Żak (bez admina bez puli i zaproszonego)');
    assert.deepEqual(rows.map(r => r[0]), ['Nazwisko', 'Łącki', 'Żak'], 'po polsku alfabetycznie');
    // Żak: wymiar 26, zaległy 20, pula 46, wykorzystane 4, czeka 2, pozostało 40, na żądanie 1, okolicznościowy 2
    assert.deepEqual(rows[2].slice(3), ['aktywne', '26', '20', '46', '4', '2', '40', '1', '2', '0', '0', '0']);
    assert.equal(rows[1][3], 'wyłączone');
  } finally {
    await s2.stop();
  }
});

test('eksport: zatwierdzone wnioski; ochrona przed formułami w Excelu', async () => {
  const s2 = await startServer();
  try {
    await s2.addUser({ email: 'a@test.pl', role: 'admin', first: 'Ada', last: 'Admin' });
    const c = await s2.login('a@test.pl');
    const id = await s2.addUser({ email: 'x@test.pl', first: 'Jan', last: '=HYPERLINK("http://zle")' });
    s2.setAllowance(id, CY, 26);
    s2.addRequest(id, { from: `${CY}-05-04`, to: `${CY}-05-06`, days: 3, status: 'approved' });
    s2.addRequest(id, { from: `${CY}-06-01`, to: `${CY}-06-01`, days: 1, status: 'pending' });
    s2.addRequest(id, { from: `${CY}-07-01`, to: `${CY}-07-01`, days: 1, status: 'rejected' });
    const res = await s2.raw('GET', `/api/admin/export?kind=requests&year=${CY}`, { headers: { Cookie: c.cookie } });
    assert.match(res.headers.get('content-disposition'), /urlopy-wnioski-/);
    const text = await res.text();
    const lines = text.replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(lines.length, 2, 'tylko zatwierdzony');
    assert.ok(lines[1].startsWith(`"'=HYPERLINK(""http://zle"")";Jan;`), lines[1]);
    assert.ok(lines[1].includes(`;Wypoczynkowy;04/05/${CY};06/05/${CY};3;zatwierdzony;`));
  } finally {
    await s2.stop();
  }
});
