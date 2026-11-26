'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');
const { Store } = require('../src/db');

let server;
let base;
const tokens = {};
const ids = {};

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const login = (username, password = 'password123') => call('POST', '/api/v1/auth/login', { body: { username, password } });

before(async () => {
  server = createServer({ store: new Store(null), jwtSecret: 'test-secret', quiet: true, demo: true });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  for (const u of ['somchai', 'suda', 'tech1', 'tech2', 'manager']) {
    const r = await login(u);
    tokens[u] = r.json.token;
    ids[u] = r.json.user.id;
  }
});

after(() => server.close());

test('เฉพาะผู้จัดการเข้าถึง /admin/users และไม่มี passwordHash หลุดออกมา', async () => {
  for (const u of ['somchai', 'tech1']) {
    assert.equal((await call('GET', '/api/v1/admin/users', { token: tokens[u] })).status, 403);
  }
  assert.equal((await call('GET', '/api/v1/admin/users')).status, 401);
  const r = await call('GET', '/api/v1/admin/users', { token: tokens.manager });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.length, 5);
  assert.ok(r.json.data.every((u) => u.active === true && !('passwordHash' in u)));
});

test('สร้างผู้ใช้: ตรวจ validation, ชื่อซ้ำ (ไม่สนตัวพิมพ์), และล็อกอินได้', async () => {
  const mgr = (body) => call('POST', '/api/v1/admin/users', { token: tokens.manager, body });
  const good = { username: 'newbie', name: 'พนักงาน ใหม่', role: 'employee', password: 'longenough1' };
  assert.equal((await mgr({ ...good, username: 'ab' })).status, 400);
  assert.equal((await mgr({ ...good, username: 'bad name!' })).status, 400);
  assert.equal((await mgr({ ...good, password: 'short' })).status, 400);
  assert.equal((await mgr({ ...good, role: 'admin' })).status, 400);
  assert.equal((await mgr({ ...good, name: '   ' })).status, 400);
  assert.equal((await mgr({ ...good, username: 'SomChai' })).status, 409);

  const ok = await mgr({ ...good, username: 'NewBie' });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.user.username, 'newbie');
  assert.equal('passwordHash' in ok.json.user, false);

  const l = await login('NEWBIE', 'longenough1');
  assert.equal(l.status, 200);
  assert.equal(l.json.user.role, 'employee');
});

test('แก้ชื่อ: อัปเดตชื่อที่เก็บซ้ำในตั๋วด้วย', async () => {
  const r = await call('PATCH', `/api/v1/admin/users/${ids.somchai}`, { token: tokens.manager, body: { name: 'สมชาย ชื่อใหม่' } });
  assert.equal(r.status, 200);
  const list = await call('GET', '/api/v1/tickets', { token: tokens.somchai }); // ชื่อเปลี่ยนแต่ token เดิมยังใช้ได้
  assert.equal(list.status, 200);
  assert.ok(list.json.data.every((t) => t.createdByName === 'สมชาย ชื่อใหม่'));
  assert.equal((await call('PATCH', `/api/v1/admin/users/${ids.somchai}`, { token: tokens.manager, body: {} })).status, 400);
  assert.equal((await call('PATCH', `/api/v1/admin/users/${ids.somchai}`, { token: tokens.manager, body: { active: 'no' } })).status, 400);
  assert.equal((await call('PATCH', '/api/v1/admin/users/nope', { token: tokens.manager, body: { name: 'x' } })).status, 404);
});

test('ผู้จัดการลดสิทธิ์/ปิดใช้งานบัญชีตัวเองไม่ได้', async () => {
  const p = (body) => call('PATCH', `/api/v1/admin/users/${ids.manager}`, { token: tokens.manager, body });
  assert.equal((await p({ role: 'employee' })).status, 409);
  assert.equal((await p({ active: false })).status, 409);
  assert.equal((await call('POST', `/api/v1/admin/users/${ids.manager}/password`, { token: tokens.manager, body: { password: 'whatever123' } })).status, 409);
});

test('ช่างที่ยังมีงานค้างปิดบัญชี/เปลี่ยนบทบาทไม่ได้ จนกว่างานจะเสร็จ', async () => {
  const t = await call('POST', '/api/v1/tickets', {
    token: tokens.suda,
    body: { title: 'งานค้างของช่าง', description: 'ทดสอบ', category: 'other' },
  });
  const tid = t.json.ticket._id;
  await call('PATCH', `/api/v1/tickets/${tid}/assign`, { token: tokens.tech2, body: {} });

  const p = (body) => call('PATCH', `/api/v1/admin/users/${ids.tech2}`, { token: tokens.manager, body });
  const blocked = await p({ active: false });
  assert.equal(blocked.status, 409);
  assert.match(blocked.json.error, /งานค้าง 1/);
  assert.equal((await p({ role: 'employee' })).status, 409);

  await call('PUT', `/api/v1/tickets/${tid}/status`, { token: tokens.tech2, body: { status: 'in_progress' } });
  await call('PUT', `/api/v1/tickets/${tid}/status`, { token: tokens.tech2, body: { status: 'resolved' } });
  assert.equal((await p({ active: false })).status, 200);
});

test('ปิดใช้งาน: ล็อกอินไม่ได้, token เก่าใช้ไม่ได้, หายจากรายชื่อช่าง, มอบหมายไม่ได้; เปิดใหม่แล้วล็อกอินได้', async () => {
  // tech2 ถูกปิดจากเทสต์ก่อนหน้า
  const l = await login('tech2');
  assert.equal(l.status, 403);
  assert.equal((await login('tech2', 'wrong-password')).status, 401); // รหัสผิดยังตอบ 401 ไม่เปิดเผยสถานะ
  assert.equal((await call('GET', '/api/v1/tickets', { token: tokens.tech2 })).status, 401);

  const techs = await call('GET', '/api/v1/users?role=it_support', { token: tokens.manager });
  assert.deepEqual(techs.json.data.map((u) => u.username), ['tech1']);

  const t = await call('POST', '/api/v1/tickets', { token: tokens.suda, body: { title: 'มอบหมายคนที่ปิดบัญชี', description: 'ทดสอบ', category: 'other' } });
  const bad = await call('PATCH', `/api/v1/tickets/${t.json.ticket._id}/assign`, { token: tokens.manager, body: { assigneeId: ids.tech2 } });
  assert.equal(bad.status, 400);

  assert.equal((await call('PATCH', `/api/v1/admin/users/${ids.tech2}`, { token: tokens.manager, body: { active: true } })).status, 200);
  const again = await login('tech2');
  assert.equal(again.status, 200);
  tokens.tech2 = again.json.token;
  assert.equal((await call('GET', '/api/v1/tickets', { token: tokens.tech2 })).status, 200);
});

test('เปลี่ยนบทบาท: token เก่าใช้ไม่ได้และสิทธิ์ใหม่มีผลหลังล็อกอินใหม่', async () => {
  const before = await call('GET', '/api/v1/tickets', { token: tokens.suda });
  assert.ok(before.json.data.every((t) => t.createdByName === 'สุดา รักงาน'));
  assert.equal((await call('PATCH', `/api/v1/admin/users/${ids.suda}`, { token: tokens.manager, body: { role: 'it_support' } })).status, 200);
  assert.equal((await call('GET', '/api/v1/tickets', { token: tokens.suda })).status, 401);
  const re = await login('suda');
  assert.equal(re.json.user.role, 'it_support');
  const all = await call('GET', '/api/v1/tickets', { token: re.json.token });
  assert.ok(all.json.total > before.json.total);
});

test('รีเซ็ตรหัสผ่านโดยผู้จัดการ: รหัสเก่า/token เก่าใช้ไม่ได้', async () => {
  const url = `/api/v1/admin/users/${ids.somchai}/password`;
  assert.equal((await call('POST', url, { token: tokens.tech1, body: { password: 'newpassword1' } })).status, 403);
  assert.equal((await call('POST', url, { token: tokens.manager, body: { password: 'short' } })).status, 400);
  assert.equal((await call('POST', url, { token: tokens.manager, body: { password: 'newpassword1' } })).status, 200);
  assert.equal((await login('somchai')).status, 401);
  assert.equal((await call('GET', '/api/v1/tickets', { token: tokens.somchai })).status, 401);
  assert.equal((await login('somchai', 'newpassword1')).status, 200);
});

test('เปลี่ยนรหัสผ่านของตนเอง: ตรวจรหัสเดิม, ได้ token ใหม่, token เก่าใช้ไม่ได้', async () => {
  const pw = (token, body) => call('POST', '/api/v1/auth/password', { token, body });
  assert.equal((await pw(undefined, { currentPassword: 'password123', newPassword: 'another-pass1' })).status, 401);
  assert.equal((await pw(tokens.tech1, { currentPassword: 'wrong', newPassword: 'another-pass1' })).status, 403);
  assert.equal((await pw(tokens.tech1, { currentPassword: 'password123', newPassword: 'short' })).status, 400);
  assert.equal((await pw(tokens.tech1, { currentPassword: 'password123', newPassword: 'password123' })).status, 400);

  const ok = await pw(tokens.tech1, { currentPassword: 'password123', newPassword: 'another-pass1' });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/api/v1/tickets', { token: tokens.tech1 })).status, 401);
  assert.equal((await call('GET', '/api/v1/tickets', { token: ok.json.token })).status, 200);
  assert.equal((await login('tech1')).status, 401);
  assert.equal((await login('tech1', 'another-pass1')).status, 200);
});

test('ปิดใช้งานแล้วสตรีม real-time ของผู้ใช้นั้นถูกตัดทันที', async () => {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/v1/events`, { headers: { Authorization: `Bearer ${tokens.somchai}` }, signal: ac.signal });
  // somchai ถูกรีเซ็ตรหัสผ่านไปแล้ว: token เดิมเชื่อมไม่ได้ ใช้ token ใหม่
  assert.equal(res.status, 401);
  const fresh = (await login('somchai', 'newpassword1')).json.token;
  const res2 = await fetch(`${base}/api/v1/events`, { headers: { Authorization: `Bearer ${fresh}` }, signal: ac.signal });
  assert.equal(res2.status, 200);
  const reader = res2.body.getReader();
  await reader.read(); // hello
  const ended = (async () => (await reader.read()).done)();
  assert.equal((await call('PATCH', `/api/v1/admin/users/${ids.somchai}`, { token: tokens.manager, body: { active: false } })).status, 200);
  assert.equal(await Promise.race([ended, new Promise((r) => setTimeout(() => r('timeout'), 2000))]), true);
  ac.abort();
});
