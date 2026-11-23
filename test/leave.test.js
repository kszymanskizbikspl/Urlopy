// Saldo i zaległy urlop (PLAN.md, sekcja 4) — przez GET /api/admin/users?year=
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let s, admin;
before(async () => {
  s = await startServer();
  await s.addUser({ email: 'admin@test.pl', role: 'admin' });
  admin = await s.login('admin@test.pl');
});
after(() => s && s.stop());

const row = async (id, year) => (await admin.get(`/api/admin/users?year=${year}`)).body.users.find(u => u.id === id);

test('rok bez wymiaru → balance null, carry_auto nadal wyliczony', async () => {
  const id = await s.addUser({ email: 'a@test.pl' });
  s.setAllowance(id, 2024, 26);
  const r = await row(id, 2025);
  assert.equal(r.balance, null);
  assert.equal(r.carry_auto, 26);
});

test('zaległy przechodzi rekurencyjnie przez kolejne lata', async () => {
  const id = await s.addUser({ email: 'b@test.pl' });
  s.setAllowance(id, 2023, 20);
  s.setAllowance(id, 2024, 26);
  s.setAllowance(id, 2025, 26);
  s.addRequest(id, { from: '2023-07-03', to: '2023-07-14', days: 10 });         // 2023: zostaje 10
  s.addRequest(id, { from: '2024-08-01', to: '2024-08-30', days: 30 });         // 2024: 26 + 10 − 30 = 6
  const b = (await row(id, 2025)).balance;
  assert.equal(b.carryAuto, 6);
  assert.equal(b.carried, 6);
  assert.equal(b.left, 32);
});

test('carry_override zastępuje automat i jest punktem startowym dla następnych lat', async () => {
  const id = await s.addUser({ email: 'c@test.pl' });
  s.setAllowance(id, 2024, 26, 4);  // z kadr: 4 dni zaległego
  s.setAllowance(id, 2025, 26);
  const b24 = (await row(id, 2024)).balance;
  assert.equal(b24.carried, 4);
  assert.equal(b24.carryOverride, 4);
  assert.equal((await row(id, 2025)).balance.carried, 30);
});

test('wykorzystane = zatwierdzone (także cancel_requested), oczekujące osobno, inne typy poza pulą', async () => {
  const id = await s.addUser({ email: 'd@test.pl' });
  s.setAllowance(id, 2025, 26);
  s.addRequest(id, { from: '2025-02-03', days: 1, status: 'approved' });
  s.addRequest(id, { from: '2025-02-04', days: 1, type: 'na_zadanie', status: 'cancel_requested' });
  s.addRequest(id, { from: '2025-03-03', to: '2025-03-04', days: 2, status: 'pending' });
  s.addRequest(id, { from: '2025-04-01', days: 1, status: 'rejected' });
  s.addRequest(id, { from: '2025-04-02', days: 1, status: 'cancelled' });
  s.addRequest(id, { from: '2025-05-05', days: 1, type: 'okolicznosciowy', status: 'approved' });
  const b = (await row(id, 2025)).balance;
  assert.equal(b.used, 2);
  assert.equal(b.pending, 2);
  assert.equal(b.left, 22);
});

test('zaległy nie spada poniżej zera', async () => {
  const id = await s.addUser({ email: 'e@test.pl' });
  s.setAllowance(id, 2024, 20);
  s.setAllowance(id, 2025, 20);
  s.addRequest(id, { from: '2024-06-03', to: '2024-06-28', days: 20 });
  s.addRequest(id, { from: '2024-07-01', to: '2024-07-05', days: 5 });
  assert.equal((await row(id, 2025)).balance.carried, 0);
});
