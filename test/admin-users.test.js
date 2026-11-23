// Krok 4: PATCH /api/admin/users/:id, PUT /api/admin/allowances/:userId/:year, POST /api/admin/allowances/copy
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let s, admin, adminId;
let n = 0;
const email = () => `osoba${++n}@test.pl`;
before(async () => {
  s = await startServer();
  adminId = await s.addUser({ email: 'admin@test.pl', role: 'admin' });
  admin = await s.login('admin@test.pl');
});
after(() => s && s.stop());

const user = id => s.db.prepare('SELECT role, state, manager_id FROM users WHERE id = ?').get(id);
const patch = (id, body) => admin.req('PATCH', `/api/admin/users/${id}`, body);

// ---------- PATCH ----------
test('zmiana roli i przełożonego', async () => {
  const boss = await s.addUser({ email: email(), role: 'manager' });
  const id = await s.addUser({ email: email() });
  const r = await patch(id, { role: 'manager', manager_id: boss });
  assert.equal(r.status, 200);
  assert.deepEqual(user(id), { role: 'manager', state: 'active', manager_id: boss });
  assert.equal((await patch(id, { manager_id: null })).status, 200);
  assert.equal(user(id).manager_id, null);
});

test('nieprawidłowe dane → 400, nieznana osoba → 404', async () => {
  const id = await s.addUser({ email: email() });
  const emp = await s.addUser({ email: email() });
  const off = await s.addUser({ email: email(), role: 'manager', state: 'disabled' });
  assert.equal((await patch(id, { role: 'szef' })).status, 400);
  assert.equal((await patch(id, { state: 'invited' })).status, 400);
  assert.equal((await patch(id, { manager_id: 'abc' })).status, 400);
  assert.equal((await patch(id, { manager_id: id })).status, 400, 'sam sobie przełożonym');
  assert.equal((await patch(id, { manager_id: emp })).status, 400, 'przełożony bez roli');
  assert.equal((await patch(id, { manager_id: off })).status, 400, 'przełożony z wyłączonym kontem');
  assert.equal((await patch(id, { manager_id: 99999 })).status, 400, 'nieistniejący przełożony');
  assert.equal((await patch(99999, { role: 'admin' })).status, 404);
  assert.deepEqual(user(id), { role: 'employee', state: 'active', manager_id: null });
});

test('zaproszonej osoby nie da się edytować → 409', async () => {
  const id = await s.addUser({ email: email(), state: 'invited' });
  assert.equal((await patch(id, { role: 'manager' })).status, 409);
});

test('admin nie zmienia własnej roli ani nie wyłącza własnego konta', async () => {
  assert.equal((await patch(adminId, { role: 'employee' })).status, 409);
  assert.equal((await patch(adminId, { state: 'disabled' })).status, 409);
  // bez zmiany (ta sama rola) — przechodzi
  assert.equal((await patch(adminId, { role: 'admin' })).status, 200);
  assert.equal(user(adminId).role, 'admin');
});

// Licznik „ostatniego admina” w transakcji zadziała tylko przy wyścigu dwóch żądań — wykonujący zmianę jest zawsze
// aktywnym adminem i nie może zmienić siebie. Sprawdzamy sekwencję, która bez tych zasad mogłaby skończyć się zerem.
test('dwaj admini: A degraduje B, potem B nie ma już uprawnień, żeby zdegradować A', async () => {
  const s2 = await startServer();
  try {
    const a = await s2.addUser({ email: 'a@test.pl', role: 'admin' });
    const b = await s2.addUser({ email: 'b@test.pl', role: 'admin' });
    const ca = await s2.login('a@test.pl'), cb = await s2.login('b@test.pl');
    assert.equal((await ca.req('PATCH', `/api/admin/users/${b}`, { role: 'employee' })).status, 200);
    assert.equal((await cb.req('PATCH', `/api/admin/users/${a}`, { role: 'employee' })).status, 403);
    assert.equal(s2.db.prepare("SELECT COUNT(*) FROM users WHERE role = 'admin' AND state = 'active'").pluck().get(), 1);
  } finally {
    await s2.stop();
  }
});

test('przełożony traci rolę → podwładni bez przełożonego, w odpowiedzi ich liczba', async () => {
  const boss = await s.addUser({ email: email(), role: 'manager' });
  const p1 = await s.addUser({ email: email(), managerId: boss });
  const p2 = await s.addUser({ email: email(), managerId: boss });
  const r = await patch(boss, { role: 'employee' });
  assert.equal(r.status, 200);
  assert.equal(r.body.cleared_subordinates, 2);
  assert.equal(user(p1).manager_id, null);
  assert.equal(user(p2).manager_id, null);
});

test('manager → admin nie czyści podwładnych', async () => {
  const boss = await s.addUser({ email: email(), role: 'manager' });
  const p = await s.addUser({ email: email(), managerId: boss });
  const r = await patch(boss, { role: 'admin' });
  assert.equal(r.body.cleared_subordinates, 0);
  assert.equal(user(p).manager_id, boss);
});

test('wyłączenie konta: podwładni wyczyszczeni, sesje usunięte, ponowne włączenie działa', async () => {
  const em = email();
  const boss = await s.addUser({ email: em, role: 'manager' });
  const p = await s.addUser({ email: email(), managerId: boss });
  const cBoss = await s.login(em);
  assert.equal((await cBoss.get('/api/me')).status, 200);

  const r = await patch(boss, { state: 'disabled' });
  assert.equal(r.status, 200);
  assert.equal(r.body.cleared_subordinates, 1);
  assert.equal(user(p).manager_id, null);
  assert.equal(s.db.prepare('SELECT COUNT(*) FROM sessions WHERE user_id = ?').pluck().get(boss), 0);
  assert.equal((await cBoss.get('/api/me')).status, 401);
  assert.equal((await s.login(em)).ok, false);

  assert.equal((await patch(boss, { state: 'active' })).status, 200);
  assert.equal((await s.login(em)).ok, true);
});

test('zmiany trafiają do logu audytowego', async () => {
  const id = await s.addUser({ email: email() });
  await patch(id, { role: 'manager' });
  const row = s.db.prepare("SELECT user_id, details FROM audit_log WHERE action = 'user_updated' ORDER BY id DESC LIMIT 1").get();
  assert.equal(row.user_id, adminId);
  assert.deepEqual(JSON.parse(row.details), { id, role: 'manager', cleared_subordinates: 0 });
});

// ---------- PUT wymiaru ----------
test('PUT wymiaru: tworzy, zmienia, null przywraca automat', async () => {
  const id = await s.addUser({ email: email() });
  s.setAllowance(id, 2024, 26);
  let r = await admin.req('PUT', `/api/admin/allowances/${id}/2025`, { days: 20, carry_override: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.balance.days, 20);
  assert.equal(r.body.balance.carried, 26);

  r = await admin.req('PUT', `/api/admin/allowances/${id}/2025`, { days: 26, carry_override: 3 });
  assert.equal(r.body.balance.carried, 3);
  assert.equal(r.body.balance.carryOverride, 3);
  assert.equal(r.body.balance.carryAuto, 26);

  r = await admin.req('PUT', `/api/admin/allowances/${id}/2025`, { days: 26, carry_override: 0 });
  assert.equal(r.body.balance.carried, 0, 'ręczne 0 to nie to samo co automat');

  r = await admin.req('PUT', `/api/admin/allowances/${id}/2025`, { days: 26, carry_override: null });
  assert.equal(r.body.balance.carryOverride, null);
  assert.equal(r.body.balance.carried, 26);
});

test('PUT wymiaru: walidacja', async () => {
  const id = await s.addUser({ email: email() });
  const put = (uid, year, body) => admin.req('PUT', `/api/admin/allowances/${uid}/${year}`, body);
  assert.equal((await put(id, 2025, { days: 41 })).status, 400);
  assert.equal((await put(id, 2025, { days: -1 })).status, 400);
  assert.equal((await put(id, 2025, { days: 2.5 })).status, 400);
  assert.equal((await put(id, 2025, {})).status, 400);
  assert.equal((await put(id, 2025, { days: 26, carry_override: 81 })).status, 400);
  assert.equal((await put(id, 1999, { days: 26 })).status, 400);
  assert.equal((await put(99999, 2025, { days: 26 })).status, 404);
  // Number(null) / Number('') / Number(true) nie mogą się zamienić w 0 / 1
  assert.equal((await put(id, 2025, { days: null })).status, 400);
  assert.equal((await put(id, 2025, { days: '' })).status, 400);
  assert.equal((await put(id, 2025, { days: true })).status, 400);
  assert.equal((await put(id, 2025, { days: 26, carry_override: true })).status, 400);
  assert.equal(s.db.prepare('SELECT COUNT(*) FROM allowances WHERE user_id = ?').pluck().get(id), 0);
  assert.equal((await put(id, 2025, { days: '20', carry_override: '' })).status, 200, 'liczba jako tekst, puste = automat');
  assert.deepEqual(s.db.prepare('SELECT days, carry_override FROM allowances WHERE user_id = ?').get(id), { days: 20, carry_override: null });
});

test('PUT wymiaru: nie można dodać roku przed pierwszym wymiarem osoby (zmieniłby zaległy)', async () => {
  const id = await s.addUser({ email: email() });
  s.setAllowance(id, 2026, 26);
  s.setAllowance(id, 2028, 26);
  const put = (year, body) => admin.req('PUT', `/api/admin/allowances/${id}/${year}`, body);
  const r = await put(2025, { days: 26 });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /2026/);
  assert.equal((await admin.get('/api/admin/users?year=2026')).body.users.find(u => u.id === id).balance.carried, 0);
  assert.equal((await put(2027, { days: 20 })).status, 200, 'luka między latami — OK');
  assert.equal((await put(2026, { days: 20 })).status, 200, 'zmiana pierwszego roku — OK');
  // osoba bez żadnego wymiaru — dowolny rok
  const none = await s.addUser({ email: email() });
  assert.equal((await admin.req('PUT', `/api/admin/allowances/${none}/2020`, { days: 26 })).status, 200);
});

test('PATCH: manager_id true nie zamienia się w id 1', async () => {
  const id = await s.addUser({ email: email() });
  assert.equal((await patch(id, { manager_id: true })).status, 400);
  assert.equal(user(id).manager_id, null);
});

// ---------- kopiowanie wymiarów ----------
test('copy: przenosi wymiar bez ręcznego zaległego, pomija wyłączonych i już ustawione', async () => {
  const s2 = await startServer();
  try {
    await s2.addUser({ email: 'admin@test.pl', role: 'admin' });
    const c = await s2.login('admin@test.pl');
    const a = await s2.addUser({ email: 'a@test.pl' });
    const b = await s2.addUser({ email: 'b@test.pl' });
    const off = await s2.addUser({ email: 'off@test.pl', state: 'disabled' });
    const inv = await s2.addUser({ email: 'inv@test.pl', state: 'invited' });
    const none = await s2.addUser({ email: 'none@test.pl' }); // brak wymiaru w 2030
    const later = await s2.addUser({ email: 'later@test.pl' }); // pierwszy wymiar w 2032 — 2031 się nie liczy
    const invNone = await s2.addUser({ email: 'inv2@test.pl', state: 'invited' }); // zaproszony bez wymiaru — nie ma „Edytuj”
    s2.setAllowance(later, 2032, 26);
    s2.setAllowance(invNone, 2032, 26);
    s2.setAllowance(a, 2030, 20, 5);
    s2.setAllowance(b, 2030, 26);
    s2.setAllowance(b, 2031, 22);   // już ustawiony — bez zmian
    s2.setAllowance(off, 2030, 26);
    s2.setAllowance(inv, 2030, 26);

    const r = await c.req('POST', '/api/admin/allowances/copy', { from: 2030, to: 2031 });
    assert.equal(r.status, 200);
    assert.equal(r.body.copied, 2, 'a i zaproszony');
    assert.equal(r.body.missing, 2, 'admin i none — aktywni, bez wymiaru w 2030; bez later, zaproszonych i wyłączonych');

    const get = (id, y) => s2.db.prepare('SELECT days, carry_override FROM allowances WHERE user_id = ? AND year = ?').get(id, y);
    assert.deepEqual(get(a, 2031), { days: 20, carry_override: null });
    assert.deepEqual(get(b, 2031), { days: 22, carry_override: null });
    assert.equal(get(off, 2031), undefined);
    assert.deepEqual(get(inv, 2031), { days: 26, carry_override: null });
    assert.equal(get(none, 2031), undefined);

    // ponowne kliknięcie nic nie psuje
    const again = await c.req('POST', '/api/admin/allowances/copy', { from: 2030, to: 2031 });
    assert.equal(again.body.copied, 0);
  } finally {
    await s2.stop();
  }
});

test('copy: tylko z roku na następny', async () => {
  assert.equal((await admin.req('POST', '/api/admin/allowances/copy', { from: 2024, to: 2026 })).status, 400);
  assert.equal((await admin.req('POST', '/api/admin/allowances/copy', { from: 2025, to: 2024 })).status, 400);
  assert.equal((await admin.req('POST', '/api/admin/allowances/copy', {})).status, 400);
});

// ---------- lista ----------
test('GET /api/admin/users zwraca manager_id i carry_auto', async () => {
  const boss = await s.addUser({ email: email(), role: 'manager' });
  const id = await s.addUser({ email: email(), managerId: boss });
  s.setAllowance(id, 2040, 20);
  const r = (await admin.get('/api/admin/users?year=2041')).body.users.find(u => u.id === id);
  assert.equal(r.manager_id, boss);
  assert.equal(r.balance, null);
  assert.equal(r.carry_auto, 20);
  assert.equal(r.first_year, 2040);
});
