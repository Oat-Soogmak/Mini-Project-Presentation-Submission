'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createServer } = require('../src/server');
const { Store } = require('../src/db');
const { seed } = require('../src/seed');
const { verifyPassword } = require('../src/auth');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'helpdesk-prod-'));
const listen = (server) => new Promise((r) => server.listen(0, r));
const urlOf = (server) => `http://localhost:${server.address().port}`;
const login = async (base, username, password) =>
  (await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })).json();

test('/healthz: ไม่ต้องล็อกอิน ตอบ 200 และเป็น 503 เมื่อฐานข้อมูลใช้ไม่ได้', async () => {
  const server = createServer({ store: new Store(null), jwtSecret: 'test-secret-0123456789', quiet: true, demo: true });
  await listen(server);
  const ok = await fetch(`${urlOf(server)}/healthz`);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  server.store.close(); // จำลองฐานข้อมูลล่ม
  const bad = await fetch(`${urlOf(server)}/healthz`);
  assert.equal(bad.status, 503);
  assert.deepEqual(await bad.json(), { ok: false });
  await new Promise((r) => server.close(r));
});

test('access log: JSON ต่อคำขอ มีเวลา/วิธี/พาธ/สถานะ/IP แต่ไม่หลุด query, token หรือ header และไม่บันทึก /healthz', async () => {
  const lines = [];
  const server = createServer({ store: new Store(null), jwtSecret: 'test-secret-0123456789', quiet: true, demo: true, accessLog: (l) => lines.push(l) });
  await listen(server);
  const base = urlOf(server);
  const { token } = await login(base, 'manager', 'password123');
  await fetch(`${base}/api/v1/tickets?status=open&secret=abc123`, { headers: { Authorization: `Bearer ${token}` } });
  await fetch(`${base}/healthz`);
  await fetch(`${base}/`);
  await new Promise((r) => setTimeout(r, 100));

  const rows = lines.map((l) => JSON.parse(l));
  const t = rows.find((r) => r.p === '/api/v1/tickets');
  assert.ok(t, 'พบบรรทัดของ /api/v1/tickets (พาธไม่รวม query)');
  assert.equal(t.m, 'GET');
  assert.equal(t.s, 200);
  assert.equal(typeof t.ms, 'number');
  assert.match(t.t, /^\d{4}-\d\d-\d\dT/);
  assert.ok(t.ip);
  assert.ok(rows.some((r) => r.p === '/api/v1/auth/login' && r.m === 'POST'));
  assert.ok(!rows.some((r) => r.p === '/healthz'), 'ไม่บันทึก healthcheck');
  const all = lines.join('\n');
  assert.ok(!all.includes('abc123') && !all.includes(token) && !all.includes('password123') && !/bearer/i.test(all));
  await server.shutdown();
});

test('กุญแจ JWT: ถูกสร้างเก็บไว้ในโฟลเดอร์ข้อมูล (สิทธิ์ 600) ทำให้ล็อกอินค้างอยู่ได้หลังรีสตาร์ท; JWT_SECRET สั้นไปถูกปฏิเสธ', async () => {
  const dir = tmp();
  const opts = { dataDir: dir, quiet: true, demo: false, initialManager: { username: 'boss', password: 'my-strong-pass-1' } };
  const a = createServer(opts);
  await listen(a);
  const { token } = await login(urlOf(a), 'boss', 'my-strong-pass-1');
  assert.ok(token);
  await a.shutdown();

  const secretFile = path.join(dir, 'jwt-secret');
  assert.ok(fs.existsSync(secretFile));
  if (process.platform !== 'win32') assert.equal(fs.statSync(secretFile).mode & 0o777, 0o600);

  const b = createServer(opts); // รีสตาร์ท: ใช้กุญแจเดิม
  await listen(b);
  const me = await fetch(`${urlOf(b)}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(me.status, 200, 'token เดิมยังใช้ได้หลังรีสตาร์ท');
  assert.equal((await me.json()).user.username, 'boss');
  await b.shutdown();

  const saved = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'short';
  try {
    assert.throws(() => createServer({ store: new Store(null), quiet: true }), /JWT_SECRET สั้นเกินไป/);
  } finally {
    if (saved === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = saved;
  }
});

test('shutdown: ตัดสตรีม real-time ที่เปิดค้างอยู่และปิดเซิร์ฟเวอร์ได้ในเวลาอันสั้น', async () => {
  const server = createServer({ store: new Store(null), jwtSecret: 'test-secret-0123456789', quiet: true, demo: true });
  await listen(server);
  const base = urlOf(server);
  const { token } = await login(base, 'somchai', 'password123');
  const res = await fetch(`${base}/api/v1/events`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  await reader.read(); // hello
  const closed = (async () => { for (;;) { const { done } = await reader.read(); if (done) return true; } })();
  const t0 = Date.now();
  await server.shutdown();
  assert.ok(Date.now() - t0 < 2500, 'ปิดภายใน 2.5 วินาที แม้มี SSE ค้าง');
  assert.equal(await closed, true);
});

/* ---------- สคริปต์สำรอง / กู้คืน / รีเซ็ตรหัสผ่าน ---------- */
const run = (script, args, env) =>
  spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'scripts', script), ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });

test('backup: สำรองได้ขณะระบบยังเปิดฐานข้อมูลอยู่ (รวมข้อมูลที่ยังอยู่ใน WAL) ตรวจความสมบูรณ์ และเก็บแค่ BACKUP_KEEP ไฟล์ล่าสุด', () => {
  const dir = tmp();
  const store = new Store(path.join(dir, 'helpdesk.db'));
  seed(store, { demo: true }); // 5 ผู้ใช้, 2 ตั๋ว — การเชื่อมต่อนี้ยังเปิดค้างไว้ระหว่างสำรอง
  const env = { DATA_DIR: dir, BACKUP_KEEP: '2' };

  for (let i = 0; i < 3; i++) {
    const r = run('backup.js', [], env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /สำเร็จ.*ผู้ใช้ 5, ตั๋ว 2/);
  }
  const files = fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.endsWith('.db.gz'));
  assert.equal(files.length, 2, 'เก็บแค่ 2 ไฟล์ล่าสุด');
  assert.ok(!fs.readdirSync(path.join(dir, 'backups')).some((f) => f.startsWith('.tmp-')), 'ไม่ทิ้งไฟล์ชั่วคราว');

  // ไฟล์สำรองเป็น SQLite ที่เปิดอ่านได้จริง
  const raw = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'backups', files.sort().at(-1))));
  const copy = path.join(dir, 'check.db');
  fs.writeFileSync(copy, raw);
  const db = new DatabaseSync(copy);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, 2);
  db.close();
  store.close();
});

test('backup: ไม่มีฐานข้อมูล → ล้มเหลวชัดเจน (exit 1) และไม่สร้างไฟล์สำรองเปล่า', () => {
  const dir = tmp();
  const r = run('backup.js', [], { DATA_DIR: dir });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ไม่พบฐานข้อมูล/);
  assert.ok(!fs.existsSync(path.join(dir, 'backups')) || fs.readdirSync(path.join(dir, 'backups')).length === 0);
});

test('restore: กู้คืนข้อมูลกลับไปเป็นตอนสำรอง เก็บฐานข้อมูลเดิมไว้ก่อน และปฏิเสธไฟล์ที่ไม่ใช่ฐานข้อมูลโดยไม่แตะของเดิม', () => {
  const dir = tmp();
  const dbFile = path.join(dir, 'helpdesk.db');
  let store = new Store(dbFile);
  seed(store, { demo: true });
  store.close();
  assert.equal(run('backup.js', [], { DATA_DIR: dir }).status, 0);
  const backup = path.join(dir, 'backups', fs.readdirSync(path.join(dir, 'backups')).find((f) => f.endsWith('.db.gz')));

  // ข้อมูลเปลี่ยนหลังสำรอง (เพิ่มผู้ใช้ + ลบตั๋ว)
  store = new Store(dbFile);
  store.users.insertOne({ username: 'late', name: 'มาทีหลัง', role: 'employee', passwordHash: 'x' });
  store.tickets.deleteOne(store.tickets.find()[0]._id);
  assert.equal(store.users.find().length, 6);
  store.close();

  // ไฟล์เสีย: ต้องไม่แตะฐานข้อมูลปัจจุบัน
  const junk = path.join(dir, 'junk.db.gz');
  fs.writeFileSync(junk, zlib.gzipSync(Buffer.from('this is not a sqlite database at all')));
  const bad = run('restore.js', [junk], { DATA_DIR: dir });
  assert.equal(bad.status, 1);
  store = new Store(dbFile);
  assert.equal(store.users.find().length, 6, 'ฐานข้อมูลเดิมยังอยู่ครบหลังกู้คืนไฟล์เสียล้มเหลว');
  store.close();

  const r = run('restore.js', [backup], { DATA_DIR: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ผู้ใช้ 5, ตั๋ว 2/);
  store = new Store(dbFile);
  assert.equal(store.users.find().length, 5);
  assert.equal(store.users.findOne({ username: 'late' }), null);
  assert.equal(store.tickets.find().length, 2);
  store.close();

  const kept = fs.readdirSync(dir).find((f) => f.startsWith('pre-restore-'));
  assert.ok(kept, 'มีโฟลเดอร์เก็บฐานข้อมูลก่อนกู้คืน');
  const old = new Store(path.join(dir, kept, 'helpdesk.db'));
  assert.equal(old.users.find().length, 6);
  old.close();
  assert.equal(run('restore.js', [], { DATA_DIR: dir }).status, 1); // ไม่ระบุไฟล์
});

test('reset-password: รีเซ็ตรหัสให้ผู้ดูแลที่ลืมรหัส (สุ่มหรือกำหนดเอง) เปิดบัญชีที่ถูกปิด ตัด token เก่า และบันทึก log', async () => {
  const dir = tmp();
  const store = new Store(path.join(dir, 'helpdesk.db'));
  seed(store, { demo: false, initialManager: { username: 'admin', password: 'forgotten-pass-1' } });
  const admin = store.users.findOne({ username: 'admin' });
  store.users.updateOne(admin._id, { active: false });
  store.close();

  const r = run('reset-password.js', ['ADMIN'], { DATA_DIR: dir });
  assert.equal(r.status, 0, r.stderr);
  const pw = /รหัสผ่านใหม่: (\S+)/.exec(r.stdout)[1];
  assert.match(pw, /^[A-Za-z0-9]{16}$/);

  const s2 = new Store(path.join(dir, 'helpdesk.db'));
  const u = s2.users.findOne({ username: 'admin' });
  assert.equal(verifyPassword(pw, u.passwordHash), true);
  assert.equal(verifyPassword('forgotten-pass-1', u.passwordHash), false);
  assert.equal(u.active, true);
  assert.equal(u.tokenVersion, 1);
  assert.ok(s2.logs.find({ action: 'user.password_reset' }).length === 1);
  s2.close();

  // ล็อกอินผ่านเซิร์ฟเวอร์จริงด้วยรหัสใหม่ได้
  const server = createServer({ dataDir: dir, jwtSecret: 'test-secret-0123456789', quiet: true, demo: false });
  await listen(server);
  assert.ok((await login(urlOf(server), 'admin', pw)).token);
  await server.shutdown();

  const custom = run('reset-password.js', ['admin'], { DATA_DIR: dir, NEW_PASSWORD: 'my-own-new-pass-9' });
  assert.equal(custom.status, 0);
  assert.ok(!custom.stdout.includes('my-own-new-pass-9'), 'ไม่พิมพ์รหัสผ่านที่กำหนดเองซ้ำออกหน้าจอ');
  assert.equal(run('reset-password.js', ['nobody'], { DATA_DIR: dir }).status, 1);
  assert.equal(run('reset-password.js', ['admin'], { DATA_DIR: dir, NEW_PASSWORD: 'short' }).status, 1);
  assert.equal(run('reset-password.js', [], { DATA_DIR: dir }).status, 1);
});
