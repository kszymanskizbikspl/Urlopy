// Logowanie, sesja, ochrona API według ról, CSRF.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let s;
before(async () => {
  s = await startServer();
  await s.addUser({ email: 'admin@test.pl', role: 'admin' });
  await s.addUser({ email: 'jan@test.pl', role: 'employee' });
  await s.addUser({ email: 'off@test.pl', role: 'employee', state: 'disabled' });
});
after(() => s && s.stop());

test('logowanie poprawnym hasłem → sesja i /api/me', async () => {
  const c = await s.login('admin@test.pl');
  assert.ok(c.ok);
  assert.equal(c.location, '/panel.html');
  assert.equal(c.me.email, 'admin@test.pl');
  assert.equal(c.me.role, 'admin');
  assert.ok(c.me.csrf);
});

test('złe hasło, nieznane konto i wyłączone konto → ten sam błąd, bez sesji', async () => {
  for (const [email, pw] of [['admin@test.pl', 'zle-haslo-123'], ['nikt@test.pl', 'cokolwiek-123'], ['off@test.pl', undefined]]) {
    const c = await s.login(email, pw);
    assert.equal(c.ok, false, email);
    assert.equal(c.location, '/login.html?error=1', email);
  }
});

test('API bez sesji → 401', async () => {
  assert.equal((await s.raw('GET', '/api/me')).status, 401);
  assert.equal((await s.raw('GET', '/api/admin/users')).status, 401);
});

test('pracownik nie ma dostępu do /api/admin → 403', async () => {
  const c = await s.login('jan@test.pl');
  assert.equal((await c.get('/api/admin/users')).status, 403);
  assert.equal((await c.req('PATCH', '/api/admin/users/1', { role: 'admin' })).status, 403);
});

test('zmiana danych bez tokenu CSRF → 403', async () => {
  const c = await s.login('admin@test.pl');
  const r = await c.req('PUT', '/api/admin/allowances/2/2026', { days: 26 }, { csrf: false });
  assert.equal(r.status, 403);
});

test('żądanie z obcej strony (Origin) → 403', async () => {
  const c = await s.login('admin@test.pl');
  const r = await s.raw('PUT', '/api/admin/allowances/2/2026', {
    body: { days: 26 }, headers: { Cookie: c.cookie, 'X-CSRF-Token': c.me.csrf, Origin: 'http://zla-strona.pl' },
  });
  assert.equal(r.status, 403);
});

test('strony admina chronione: pracownik nie dostaje admin-pracownicy.html', async () => {
  const c = await s.login('jan@test.pl');
  const r = await s.raw('GET', '/admin-pracownicy.html', { headers: { Cookie: c.cookie } });
  assert.notEqual(r.status, 200);
});
