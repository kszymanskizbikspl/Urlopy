// Krok 6: kto zatwierdza, lista do rozpatrzenia, decyzje, e-maile (kolejka mail_queue — bez SMTP wiadomości czekają w bazie).
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

let s;
let n = 0;
const email = p => `${p}${++n}@test.pl`;

let admin, admin2;
before(async () => {
  s = await startServer();
  admin = await person({ role: 'admin', first: 'Ada', last: 'Admin' });
  admin2 = await person({ role: 'admin', first: 'Bogdan', last: 'Admin' });
});
after(() => s && s.stop());

/** Osoba z pulą na NY, zalogowana */
async function person({ role = 'employee', managerId = null, first = 'Jan', last = 'Test', days = 26 } = {}) {
  const em = email(role);
  const id = await s.addUser({ email: em, role, managerId, first, last });
  s.setAllowance(id, NY, days);
  return { id, email: em, c: await s.login(em) };
}
const mails = (to, kind) => s.db.prepare('SELECT kind, subject, body_text, ics FROM mail_queue WHERE to_addr = ? AND kind = ? ORDER BY id').all(to, kind);
const submit = (p, r, extra = {}) => p.c.req('POST', '/api/requests', { date_from: r.from, date_to: r.to, type: 'wypoczynkowy', ...extra });
const status = id => s.db.prepare('SELECT status FROM leave_requests WHERE id = ?').pluck().get(id);
const list = (p, q = 'filter=pending') => p.c.get('/api/admin/requests?' + q);
const act = (p, id, action, reason) => p.c.req('POST', `/api/admin/requests/${id}/${action}`, reason === undefined ? {} : { reason });

// ---------- kierowanie wniosków i e-maile ----------
test('wniosek z przełożonym → e-mail tylko do przełożonego; przełożony widzi go jako swój', async () => {
  const boss = await person({ role: 'manager', first: 'Tomasz', last: 'Zieliński' });
  const emp = await person({ managerId: boss.id, first: 'Piotr', last: 'Nowak' });
  const r = await submit(emp, range(NY, 3, 3), { note: 'Sprawy przekazane' });
  assert.equal(r.status, 201);
  const m = mails(boss.email, 'request_new');
  assert.equal(m.length, 1);
  assert.match(m[0].subject, /Nowy wniosek urlopowy: Piotr Nowak/);
  assert.match(m[0].body_text, /Sprawy przekazane/);
  assert.match(m[0].body_text, /admin-wnioski\.html/);
  assert.equal(mails(admin.email, 'request_new').length, 0, 'admin bez e-maila, gdy jest przełożony');

  const l = (await list(boss)).body;
  const row = l.requests.find(x => x.id === r.body.request.id);
  assert.equal(row.mine, true);
  assert.equal(row.employee, 'Piotr Nowak');
  assert.equal(row.left, 23);
  assert.ok(l.pending_count >= 1);
  assert.equal((await boss.c.get('/api/me')).body.pending_count, l.pending_count);

  // admin też widzi (może zdecydować), ale jako cudzy: „czeka na” przełożonego
  const arow = (await list(admin)).body.requests.find(x => x.id === r.body.request.id);
  assert.equal(arow.mine, false);
  assert.deepEqual(arow.routed_to, ['Tomasz Zieliński']);
});

test('bez przełożonego (albo ustawienie „każdy administrator”) → e-mail do wszystkich adminów', async () => {
  const emp = await person();
  const before1 = mails(admin.email, 'request_new').length, before2 = mails(admin2.email, 'request_new').length;
  await submit(emp, range(NY, 4, 1));
  assert.equal(mails(admin.email, 'request_new').length, before1 + 1);
  assert.equal(mails(admin2.email, 'request_new').length, before2 + 1);

  const boss = await person({ role: 'manager' });
  const emp2 = await person({ managerId: boss.id });
  assert.equal((await admin.c.req('PUT', '/api/admin/settings', { approver: 'admins' })).status, 200);
  try {
    await submit(emp2, range(NY, 4, 1));
    assert.equal(mails(boss.email, 'request_new').length, 0, 'przełożony pomijany przy „każdy administrator”');
    assert.equal(mails(admin.email, 'request_new').length, before1 + 2);
    // przełożony nie może wtedy decydować o wnioskach swoich ludzi
    assert.equal((await list(boss)).body.requests.length, 0);
  } finally {
    await admin.c.req('PUT', '/api/admin/settings', { approver: 'manager' });
  }
});

test('wniosek admina trafia do drugiego admina, nie do autora; autor nie widzi go do decyzji', async () => {
  const r = await submit(admin, range(NY, 5, 2));
  const id = r.body.request.id;
  assert.equal(mails(admin.email, 'request_new').filter(m => m.subject.includes('Ada Admin')).length, 0);
  assert.equal(mails(admin2.email, 'request_new').filter(m => m.subject.includes('Ada Admin')).length, 1);
  assert.ok(!(await list(admin)).body.requests.some(x => x.id === id));
  assert.equal((await act(admin, id, 'approve')).status, 404, 'nie zatwierdzi sam sobie');
  assert.equal((await act(admin2, id, 'approve')).status, 200);
});

test('jedyny administrator zatwierdza własny wniosek (bez e-maila do siebie), zapis w logu', async () => {
  const s2 = await startServer();
  try {
    const em = 'solo@test.pl';
    const id = await s2.addUser({ email: em, role: 'admin' });
    s2.setAllowance(id, NY, 26);
    const c = await s2.login(em);
    const r = await c.req('POST', '/api/requests', { ...(x => ({ date_from: x.from, date_to: x.to }))(range(NY, 3, 1)), type: 'wypoczynkowy' });
    assert.equal(r.status, 201);
    assert.equal(s2.db.prepare("SELECT COUNT(*) FROM mail_queue WHERE kind = 'request_new'").pluck().get(), 0);
    const l = (await c.get('/api/admin/requests?filter=pending')).body;
    assert.equal(l.requests.length, 1);
    assert.equal(l.requests[0].mine, true);
    assert.equal((await c.req('POST', `/api/admin/requests/${r.body.request.id}/approve`, {})).status, 200);
    const audit = s2.db.prepare("SELECT details FROM audit_log WHERE action = 'request_approve'").pluck().get();
    assert.equal(JSON.parse(audit).self, true);
  } finally {
    await s2.stop();
  }
});

test('przełożony widzi tylko swoich ludzi; pracownik nie ma dostępu', async () => {
  const boss = await person({ role: 'manager' });
  const other = await person({ role: 'manager' });
  const emp = await person({ managerId: boss.id });
  const r = await submit(emp, range(NY, 6, 1));
  const id = r.body.request.id;
  assert.ok(!(await list(other)).body.requests.some(x => x.id === id));
  assert.equal((await act(other, id, 'approve')).status, 404);
  assert.equal(status(id), 'pending');
  assert.equal((await list(emp)).status, 403);
  assert.equal((await act(emp, id, 'approve')).status, 403);
});

// ---------- decyzje ----------
test('zatwierdzenie: status, kto i kiedy, e-mail z plikiem .ics; drugi raz → 409', async () => {
  const boss = await person({ role: 'manager', first: 'Tomasz', last: 'Zieliński' });
  const emp = await person({ managerId: boss.id });
  const rg = range(NY, 7, 3);
  const id = (await submit(emp, rg)).body.request.id;
  const r = await act(boss, id, 'approve');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'approved');
  const row = s.db.prepare('SELECT status, decided_by, decided_at FROM leave_requests WHERE id = ?').get(id);
  assert.equal(row.decided_by, boss.id);
  assert.ok(row.decided_at);
  const m = mails(emp.email, 'decision');
  assert.equal(m.length, 1);
  assert.match(m[0].subject, /Urlop zatwierdzony/);
  assert.match(m[0].body_text, /Tomasz Zieliński zatwierdził\(a\)/);
  assert.match(m[0].ics, /METHOD:PUBLISH/);
  assert.match(m[0].ics, new RegExp(`DTSTART;VALUE=DATE:${rg.from.replace(/-/g, '')}`));
  assert.match(m[0].ics, new RegExp(`UID:urlop-${id}@`));
  assert.match(m[0].ics, /\r\nORGANIZER;CN="[^"]*":mailto:/);
  assert.match(m[0].ics, new RegExp(`\\r\\nATTENDEE;CN="Jan Test";ROLE=REQ-PARTICIPANT:mailto:${emp.email}`));
  assert.equal((await act(boss, id, 'approve')).status, 409);
  assert.equal((await act(admin, id, 'reject', 'za późno')).status, 409);
  // na liście przełożonego już nie ma do rozpatrzenia, jest w zatwierdzonych
  assert.ok(!(await list(boss)).body.requests.some(x => x.id === id));
  assert.ok((await list(boss, `filter=approved&year=${NY}`)).body.requests.some(x => x.id === id && x.decided_by === 'Tomasz Zieliński'));
});

test('odrzucenie wymaga powodu; powód w e-mailu i w panelu pracownika', async () => {
  const emp = await person();
  const id = (await submit(emp, range(NY, 8, 2))).body.request.id;
  assert.equal((await act(admin, id, 'reject')).status, 400);
  assert.equal((await act(admin, id, 'reject', '   ')).status, 400);
  assert.equal((await act(admin, id, 'reject', { x: 1 })).status, 400);
  assert.equal(status(id), 'pending');
  assert.equal((await act(admin, id, 'reject', 'Odbiór końcowy na budowie')).status, 200);
  const m = mails(emp.email, 'decision');
  assert.match(m[0].subject, /odrzucony/);
  assert.match(m[0].body_text, /Powód: Odbiór końcowy na budowie/);
  assert.equal(m[0].ics, null);
  const mine = (await emp.c.get('/api/me/requests')).body.requests.find(x => x.id === id);
  assert.equal(mine.status, 'rejected');
  assert.equal(mine.decision_note, 'Odbiór końcowy na budowie');
  assert.equal((await emp.c.get(`/api/me/balance?year=${NY}`)).body.balance.left, 26);
});

test('zatwierdzenie zablokowane, gdy pula po zmianie wymiaru nie wystarcza', async () => {
  const emp = await person({ days: 10 });
  const id = (await submit(emp, range(NY, 9, 8))).body.request.id;
  s.setAllowance(emp.id, NY, 5);                       // admin zmniejszył wymiar po złożeniu wniosku
  const r = await act(admin, id, 'approve');
  assert.equal(r.status, 409);
  assert.match(r.body.error, /zabrakłoby 3 dni/);
  assert.equal(status(id), 'pending');
  assert.equal((await act(admin, id, 'reject', 'Za mało dni')).status, 200, 'odrzucić można');
});

test('zatwierdzenie liczy tylko ten wniosek — inne czekające go nie blokują', async () => {
  const emp = await person();
  const a = (await submit(emp, range(NY, 3, 5, 15))).body.request.id;   // 5 dni
  const b = (await submit(emp, range(NY, 6, 8, 15))).body.request.id;   // 8 dni
  s.setAllowance(emp.id, NY, 10);                                        // admin zmniejszył wymiar: razem 13 > 10
  assert.equal((await act(admin, a, 'approve')).status, 200, 'A sam się mieści (10 − 5)');
  const r = await act(admin, b, 'approve');
  assert.equal(r.status, 409, 'B już nie (10 − 5 − 8)');
  assert.match(r.body.error, /zabrakłoby 3 dni/);
});

test('zatwierdzenie nie może zabrać zaległego, z którego korzysta kolejny rok', async () => {
  const emp = await person();
  s.setAllowance(emp.id, CY, 10);                                        // CY: 10 dni → cały zaległy na NY
  s.addRequest(emp.id, { ...range(NY, 2, 1), days: 36, status: 'approved' }); // NY: 26 + 10 − 36 = 0
  const pid = Number(s.addRequest(emp.id, { ...range(CY, 12, 1, 7), days: 2, status: 'pending' }).lastInsertRowid);
  const r = await act(admin, pid, 'approve');
  assert.equal(r.status, 409);
  assert.match(r.body.error, new RegExp(`puli na ${NY} r\\. zabrakłoby 2 dni`));
});

test('wycofanie czekającego wniosku → e-mail „wniosek wycofany” do przełożonego, bez przycisku', async () => {
  const boss = await person({ role: 'manager' });
  const emp = await person({ managerId: boss.id, first: 'Ola', last: 'Wycofuje' });
  const id = (await submit(emp, range(NY, 7, 1, 20))).body.request.id;
  assert.equal((await emp.c.req('POST', `/api/requests/${id}/cancel`)).body.status, 'cancelled');
  const m = s.db.prepare("SELECT subject, body_text, body_html FROM mail_queue WHERE to_addr = ? AND kind = 'request_withdrawn'").all(boss.email);
  assert.equal(m.length, 1);
  assert.match(m[0].subject, /Wniosek wycofany: Ola Wycofuje/);
  assert.doesNotMatch(m[0].body_html, /Rozpatrz/);
});

test('e-maile: tabela z danymi poza <p> (poprawny HTML)', async () => {
  const html = s.db.prepare("SELECT body_html FROM mail_queue WHERE kind IN ('request_new', 'decision') AND body_html IS NOT NULL").pluck().all();
  assert.ok(html.length > 0);
  for (const h of html) {
    assert.match(h, /<table/);
    assert.doesNotMatch(h, /<p[^>]*>\s*<table/);
  }
});

test('lista: wnioski wymagające decyzji przed rozpatrzonymi', async () => {
  const rows = (await list(admin, `filter=all&year=${NY}`)).body.requests;
  const open = r => ['pending', 'cancel_requested'].includes(r.status);
  const firstDecided = rows.findIndex(r => !open(r));
  assert.ok(rows.some(open) && firstDecided > 0, 'są oba rodzaje');
  assert.ok(rows.slice(firstDecided).every(r => !open(r)), 'po pierwszym rozpatrzonym nie ma już czekających');
});

test('prośba o anulowanie: e-mail do przełożonego; zgoda → anulowany (+ .ics CANCEL), odmowa wymaga powodu', async () => {
  const boss = await person({ role: 'manager' });
  const emp = await person({ managerId: boss.id, first: 'Ewa', last: 'Kowalska' });
  const a = (await submit(emp, range(NY, 10, 2))).body.request.id;
  const b = (await submit(emp, range(NY, 11, 2))).body.request.id;
  await act(boss, a, 'approve'); await act(boss, b, 'approve');
  assert.equal((await emp.c.req('POST', `/api/requests/${a}/cancel`)).body.status, 'cancel_requested');
  assert.equal((await emp.c.req('POST', `/api/requests/${b}/cancel`)).body.status, 'cancel_requested');
  const m = mails(boss.email, 'cancel_request');
  assert.equal(m.length, 2);
  assert.match(m[0].subject, /Prośba o anulowanie urlopu: Ewa Kowalska/);
  const pend = (await list(boss)).body.requests.filter(x => x.status === 'cancel_requested').map(x => x.id).sort();
  assert.deepEqual(pend, [a, b].sort());

  assert.equal((await act(boss, a, 'cancel')).status, 200, 'zgoda bez powodu');
  assert.equal(status(a), 'cancelled');
  const dec = mails(emp.email, 'decision').at(-1);
  assert.match(dec.subject, /anulowany na Twoją prośbę/);
  assert.match(dec.ics, /METHOD:CANCEL/);
  assert.match(dec.ics, new RegExp(`UID:urlop-${a}@`));

  assert.equal((await act(boss, b, 'keep')).status, 400, 'odmowa bez powodu');
  assert.equal((await act(boss, b, 'keep', 'Zastępstwo już zaplanowane')).status, 200);
  assert.equal(status(b), 'approved');
  assert.match(mails(emp.email, 'decision').at(-1).subject, /Prośba o anulowanie odrzucona/);
  assert.equal((await act(boss, b, 'keep', 'x')).status, 409, 'keep tylko dla prośby o anulowanie');
  const bal = (await emp.c.get(`/api/me/balance?year=${NY}`)).body.balance;
  assert.equal(bal.used, 2, 'anulowany wrócił do puli, zatrzymany nadal wykorzystany');
});

test('przełożony anuluje zatwierdzony urlop (także trwający) tylko z powodem', async () => {
  const emp = await person();
  s.setAllowance(emp.id, CY, 26);
  const today = PL.iso(new Date());
  const rid = Number(s.addRequest(emp.id, { from: today, to: today, days: 1, status: 'approved' }).lastInsertRowid);
  assert.equal((await act(admin, rid, 'cancel')).status, 400);
  assert.equal((await act(admin, rid, 'cancel', 'Pracownik wrócił wcześniej')).status, 200);
  assert.equal(status(rid), 'cancelled');
  const dec = mails(emp.email, 'decision').at(-1);
  assert.match(dec.subject, /Urlop anulowany/);
  assert.match(dec.body_text, /Powód: Pracownik wrócił wcześniej/);
  assert.equal((await act(admin, rid, 'cancel', 'jeszcze raz')).status, 409);
  // czekającego nie „anuluje” się — odrzuca
  const pid = (await submit(emp, range(NY, 12, 1, 7))).body.request.id;
  assert.equal((await act(admin, pid, 'cancel', 'x')).status, 409);
});

test('lista: kolizje z zastępcą i innymi nieobecnymi', async () => {
  const boss = await person({ role: 'manager' });
  const sub = await person({ first: 'Marta', last: 'Wiśniewska' });
  const other = await person({ first: 'Kasia', last: 'Lis' });
  const emp = await person({ managerId: boss.id });
  const rg = range(NY, 2, 3, 15);
  s.addRequest(sub.id, { ...rg, days: 3, status: 'approved' });
  s.addRequest(other.id, { ...rg, days: 3, status: 'pending' });
  const id = (await submit(emp, rg, { substitute_id: sub.id })).body.request.id;
  const row = (await list(boss)).body.requests.find(x => x.id === id);
  assert.equal(row.substitute, 'Marta Wiśniewska');
  assert.equal(row.substitute_away.name, 'Marta Wiśniewska');
  assert.equal(row.substitute_away.status, 'approved');
  assert.deepEqual(row.overlaps.map(o => o.name).sort(), ['Kasia Lis', 'Marta Wiśniewska']);
});

test('lista: filtry i walidacja', async () => {
  assert.equal((await list(admin, 'filter=approved&year=abc')).status, 400);
  const all = (await list(admin, `filter=all&year=${NY}`)).body;
  assert.equal(all.year, NY);
  assert.ok(all.requests.every(r => r.date_from.startsWith(String(NY))));
  assert.ok(all.requests.every(r => r.user_id !== admin.id), 'bez własnych wniosków');
  const unknown = (await list(admin, 'filter=cokolwiek')).body;
  assert.equal(unknown.filter, 'pending');
});
