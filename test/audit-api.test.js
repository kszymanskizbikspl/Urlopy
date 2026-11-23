// Krok 8: log zdarzeń, stan zadań i kopia na żądanie — przez API (tylko administrator).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let s, admin, adminId;
before(async () => {
  s = await startServer();
  adminId = await s.addUser({ email: 'admin@test.pl', role: 'admin', first: 'Ada', last: 'Admin' });
  admin = await s.login('admin@test.pl');
});
after(() => s && s.stop());

test('log: najnowsze pierwsze, z osobą; filtr grupy; stronicowanie', async () => {
  const id = await s.addUser({ email: 'jan@test.pl', first: 'Jan', last: 'Kowalski' });
  await admin.req('PUT', `/api/admin/allowances/${id}/2030`, { days: 26 });
  await admin.req('PUT', '/api/admin/settings', { weekly_digest: true });
  await s.login('jan@test.pl', 'zle-haslo-123');

  let r = await admin.get('/api/admin/audit');
  assert.equal(r.status, 200);
  const actions = r.body.rows.map(x => x.action);
  assert.deepEqual(actions.slice(0, 3), ['login_failed', 'settings_changed', 'allowance_set']);
  const allowance = r.body.rows.find(x => x.action === 'allowance_set');
  assert.equal(allowance.user_name, 'Ada Admin');
  assert.deepEqual(allowance.details, { id, year: 2030, days: 26, carry_override: null }, 'szczegóły jako obiekt');

  r = await admin.get('/api/admin/audit?group=allowances');
  assert.deepEqual(r.body.rows.map(x => x.action), ['allowance_set']);
  r = await admin.get('/api/admin/audit?group=logins');
  assert.ok(r.body.rows.every(x => ['login', 'login_failed', 'logout'].includes(x.action)));
  r = await admin.get(`/api/admin/audit?user=${adminId}`);
  assert.ok(r.body.rows.length > 0 && r.body.rows.every(x => x.user_id === adminId));

  // stronicowanie: po 1, aż do końca
  const seen = [];
  let before;
  for (let i = 0; i < 50; i++) {
    const page = (await admin.get(`/api/admin/audit?limit=1${before ? `&before=${before}` : ''}`)).body;
    seen.push(...page.rows.map(x => x.id));
    if (!page.next) break;
    before = page.next;
  }
  const all = (await admin.get('/api/admin/audit?limit=200')).body.rows.map(x => x.id);
  assert.deepEqual(seen, all);
  // błędne parametry → 400 (nie 404 i nie 500)
  for (const qs of ['before=abc', 'before=0', 'user=0', 'user=x', 'limit=1.5', 'limit=-3']) {
    assert.equal((await admin.get('/api/admin/audit?' + qs)).status, 400, qs);
  }
  assert.equal((await admin.get('/api/admin/audit?limit=5000')).body.rows.length, Math.min(200, all.length), 'limit obcięty do 200');
});

test('kopia na żądanie i stan zadań', async () => {
  let r = await admin.get('/api/admin/jobs');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.runs, {});
  assert.deepEqual(r.body.backups, []);
  assert.equal(r.body.keep_days, 30);
  r = await admin.req('POST', '/api/admin/backups');
  assert.equal(r.status, 201);
  assert.match(r.body.name, /-reczna\.sqlite$/);
  assert.ok(r.body.size > 0);
  assert.deepEqual(r.body.backups.map(b => b.name), [r.body.name]);
  const a = (await admin.get('/api/admin/audit?group=settings')).body.rows[0];
  assert.equal(a.action, 'backup_manual');
});

test('moje powiadomienia: przełożony sam włącza / wyłącza poniedziałkową listę; pracownik nie', async () => {
  const bossId = await s.addUser({ email: 'kierownik@test.pl', role: 'manager', first: 'Tomasz', last: 'Kierownik' });
  const c = await s.login('kierownik@test.pl');
  let me = (await c.get('/api/me')).body;
  assert.equal(me.weekly_digest, true, 'domyślnie włączone');
  assert.equal(me.weekly_digest_global, true);
  let r = await c.req('PUT', '/api/me/notifications', { weekly_digest: false });
  assert.equal(r.status, 200);
  assert.equal(s.db.prepare('SELECT weekly_digest FROM users WHERE id = ?').pluck().get(bossId), 0);
  assert.equal((await c.get('/api/me')).body.weekly_digest, false);
  for (const bad of [{}, { weekly_digest: 'nie' }, { weekly_digest: 0 }]) {
    assert.equal((await c.req('PUT', '/api/me/notifications', bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await c.req('PUT', '/api/me/notifications', { weekly_digest: true }, { csrf: false })).status, 403);
  // wyłączona wysyłka dla wszystkich — widać to w /api/me
  await admin.req('PUT', '/api/admin/settings', { weekly_digest: false });
  me = (await c.get('/api/me')).body;
  assert.equal(me.weekly_digest_global, false);
  await admin.req('PUT', '/api/admin/settings', { weekly_digest: true });

  await s.addUser({ email: 'prac@test.pl' });
  const e = await s.login('prac@test.pl');
  assert.equal((await e.req('PUT', '/api/me/notifications', { weekly_digest: true })).status, 403);
  assert.equal((await e.get('/api/me')).body.weekly_digest, undefined, 'pracownik bez tego ustawienia');
});

test('admin zmienia poniedziałkową listę innej osobie (Pracownicy → Edytuj)', async () => {
  const id = await s.addUser({ email: 'kier2@test.pl', role: 'manager' });
  let r = await admin.req('PATCH', `/api/admin/users/${id}`, { weekly_digest: false });
  assert.equal(r.status, 200);
  const row = (await admin.get('/api/admin/users')).body.users.find(u => u.id === id);
  assert.equal(row.weekly_digest, false);
  assert.equal((await admin.req('PATCH', `/api/admin/users/${id}`, { weekly_digest: 'tak' })).status, 400);
  r = await admin.req('PATCH', `/api/admin/users/${adminId}`, { weekly_digest: false });
  assert.equal(r.status, 200, 'własne powiadomienia admin może zmienić (to nie rola ani konto)');
  const a = (await admin.get('/api/admin/audit?group=accounts')).body.rows[0];
  assert.equal(a.action, 'user_updated');
  assert.equal(a.details.weekly_digest, 0);
});

test('log, zadania i kopie tylko dla administratora', async () => {
  await s.addUser({ email: 'boss@test.pl', role: 'manager' });
  const c = await s.login('boss@test.pl');
  assert.equal((await c.get('/api/admin/audit')).status, 403);
  assert.equal((await c.get('/api/admin/jobs')).status, 403);
  assert.equal((await c.req('POST', '/api/admin/backups')).status, 403);
  assert.equal((await admin.req('POST', '/api/admin/backups', undefined, { csrf: false })).status, 403);
});
