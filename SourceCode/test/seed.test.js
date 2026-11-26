'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');
const { Store } = require('../src/db');
const { seed, usersWithDemoPassword } = require('../src/seed');

async function boot(options) {
  const server = createServer({ store: new Store(null), jwtSecret: 'test-secret', quiet: true, ...options });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const post = async (path, body) => {
    const res = await fetch(base + '/api/v1' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { server, base, post, close: () => { server.close(); server.store.close(); } };
}

test('โหมดปกติ (ไม่เปิด DEMO): ไม่มีบัญชี/ตั๋วสาธิต มีแต่หมวดหมู่และผู้จัดการคนแรก', async () => {
  const s = await boot({ demo: false, initialManager: { username: 'Boss', password: 'my-strong-pass-1' } });
  assert.deepEqual(s.server.store.users.find().map((u) => u.username), ['boss']);
  assert.equal(s.server.store.tickets.find().length, 0);
  assert.equal(s.server.store.categories.find().length, 5);
  for (const u of ['somchai', 'suda', 'tech1', 'tech2', 'manager']) {
    assert.equal((await s.post('/auth/login', { username: u, password: 'password123' })).status, 401, u);
  }
  assert.equal((await s.post('/auth/login', { username: 'boss', password: 'password123' })).status, 401);
  const ok = await s.post('/auth/login', { username: 'BOSS', password: 'my-strong-pass-1' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.role, 'manager');
  assert.deepEqual(await (await fetch(s.base + '/api/v1/public/config')).json(), { guestEnabled: true, demo: false });
  s.close();
});

test('ไม่ตั้งรหัสผ่านเริ่มต้น: ระบบสุ่มรหัส 16 ตัวให้ ใช้ล็อกอินได้ และสุ่มไม่ซ้ำกันทุกครั้ง', async () => {
  const a = await boot({ demo: false, initialManager: {} });
  const b = await boot({ demo: false, initialManager: {} });
  assert.equal(a.server.bootstrap.username, 'admin');
  assert.equal(a.server.bootstrap.generated, true);
  assert.match(a.server.bootstrap.password, /^[A-Za-z0-9]{16}$/);
  assert.notEqual(a.server.bootstrap.password, b.server.bootstrap.password);
  assert.equal((await a.post('/auth/login', { username: 'admin', password: a.server.bootstrap.password })).status, 200);
  assert.equal((await a.post('/auth/login', { username: 'admin', password: b.server.bootstrap.password })).status, 401);
  a.close();
  b.close();
});

test('รหัสผ่านเริ่มต้นสั้นไป/ชื่อผู้ใช้ผิดรูปแบบ: ปฏิเสธการเริ่มระบบ (ไม่สร้างบัญชีอ่อนแอเงียบ ๆ)', () => {
  assert.throws(() => seed(new Store(null), { initialManager: { password: 'short' } }), /อย่างน้อย 8/);
  assert.throws(() => seed(new Store(null), { initialManager: { username: 'a b', password: 'long-enough-1' } }), /INITIAL_MANAGER_USERNAME/);
});

test('โหมดสาธิต (DEMO): มีบัญชีและตั๋วตัวอย่าง และแจ้งให้หน้าเว็บแสดงปุ่มสาธิต', async () => {
  const s = await boot({ demo: true });
  assert.equal(s.server.store.users.find().length, 5);
  assert.equal(s.server.store.tickets.find().length, 2);
  assert.equal(s.server.bootstrap, null);
  assert.equal((await s.post('/auth/login', { username: 'manager', password: 'password123' })).status, 200);
  assert.equal((await (await fetch(s.base + '/api/v1/public/config')).json()).demo, true);
  s.close();
});

test('ฐานข้อมูลที่มีผู้ใช้อยู่แล้วไม่ถูกแตะ (ไม่สร้างผู้จัดการซ้ำเมื่อรีสตาร์ท) และตรวจเจอบัญชีที่ยังใช้รหัสสาธิต', () => {
  const store = new Store(null);
  seed(store, { demo: true });
  const before = store.users.find().length;
  assert.equal(seed(store, { demo: false, initialManager: { password: 'another-pass-1' } }), null);
  assert.equal(store.users.find().length, before);
  assert.deepEqual(usersWithDemoPassword(store).sort(), ['manager', 'somchai', 'suda', 'tech1', 'tech2']);
  store.users.updateOne(store.users.findOne({ username: 'manager' })._id, { active: false });
  assert.ok(!usersWithDemoPassword(store).includes('manager')); // บัญชีที่ปิดแล้วไม่ต้องเตือน
  store.close();
});
