'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/db');
const { createServer } = require('../src/server');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'helpdesk-db-'));

const ticket = (over = {}) => ({
  no: 1, title: 't', description: 'd', category: 'other', priority: 'low', status: 'open',
  images: [], notes: [], createdBy: 'u1', createdByName: 'U', assignedTo: null, assignedToName: null,
  createdAt: 'a', updatedAt: 'a', firstResponseAt: null, resolvedAt: null, ...over,
});

test('ข้อมูลคงอยู่หลังปิดแล้วเปิดใหม่ (ชนิดข้อมูลครบ: bool, JSON, null)', () => {
  const file = path.join(tmp(), 'x.db');
  const a = new Store(file);
  const u = a.users.insertOne({ username: 'u', name: 'ผู้ใช้', role: 'employee', passwordHash: 'h' });
  assert.equal(u.active, true); // ค่า default
  assert.equal(u.tokenVersion, 0);
  const t = a.tickets.insertOne(ticket({ no: a.nextTicketNo(), images: ['data:image/png;base64,AA=='], notes: [{ text: 'โน้ต' }] }));
  a.tickets.updateOne(t._id, { status: 'resolved', assignedTo: 'u9', resolvedAt: 'z' });
  a.users.updateOne(u._id, { active: false });
  a.close();

  const b = new Store(file);
  const t2 = b.tickets.findOne({ _id: t._id });
  assert.equal(t2.status, 'resolved');
  assert.equal(t2.assignedTo, 'u9');
  assert.deepEqual(t2.images, ['data:image/png;base64,AA==']);
  assert.deepEqual(t2.notes, [{ text: 'โน้ต' }]);
  assert.equal(t2.firstResponseAt, null);
  assert.equal(b.users.findOne({ username: 'u' }).active, false);
  assert.equal(b.nextTicketNo(), 2); // ลำดับเลขตั๋วต่อเนื่องหลังรีสตาร์ท
  b.close();
});

test('find: เงื่อนไขแบบ object, null, และฟังก์ชัน; ลำดับตามการเพิ่ม', () => {
  const s = new Store(null);
  for (let i = 1; i <= 3; i++) s.tickets.insertOne(ticket({ no: i, title: `t${i}`, status: i === 2 ? 'resolved' : 'open', assignedTo: i === 3 ? 'x' : null }));
  assert.deepEqual(s.tickets.find({ status: 'open' }).map((t) => t.no), [1, 3]);
  assert.deepEqual(s.tickets.find({ assignedTo: null }).map((t) => t.no), [1, 2]);
  assert.deepEqual(s.tickets.find((t) => t.no > 1).map((t) => t.no), [2, 3]);
  assert.equal(s.tickets.findOne({ no: 99 }), null);
  assert.equal(s.tickets.deleteOne(s.tickets.findOne({ no: 1 })._id), true);
  assert.equal(s.tickets.deleteOne('nope'), false);
  assert.equal(s.tickets.updateOne('nope', { title: 'x' }), null);
  s.close();
});

test('ข้อจำกัดของตาราง: username/เลขตั๋วซ้ำไม่ได้ และชื่อฟิลด์แปลกถูกปฏิเสธ (กัน SQL injection ผ่านชื่อคอลัมน์)', () => {
  const s = new Store(null);
  const u = { username: 'dup', name: 'n', role: 'employee', passwordHash: 'h' };
  s.users.insertOne(u);
  assert.throws(() => s.users.insertOne(u), /UNIQUE/);
  s.tickets.insertOne(ticket({ no: 5 }));
  assert.throws(() => s.tickets.insertOne(ticket({ no: 5 })), /UNIQUE/);
  assert.throws(() => s.users.find({ 'username; DROP TABLE users; --': 'x' }), /ไม่รู้จักฟิลด์/);
  assert.throws(() => s.users.updateOne('id', { evil: 1 }), /ไม่รู้จักฟิลด์/);
  // ค่าที่เป็น SQL ถูกผูกเป็นพารามิเตอร์ ไม่ถูกตีความ
  assert.equal(s.users.findOne({ username: "x' OR '1'='1" }), null);
  assert.equal(s.users.find().length, 1);
  s.close();
});

test('transaction: ยกเลิกทั้งชุดเมื่อเกิดข้อผิดพลาด', () => {
  const s = new Store(null);
  assert.throws(() =>
    s.transaction(() => {
      s.users.insertOne({ username: 'a', name: 'n', role: 'employee', passwordHash: 'h' });
      throw new Error('boom');
    }), /boom/);
  assert.equal(s.users.find().length, 0);
  s.close();
});

test('เลขตั๋วไม่ซ้ำ แม้ขอหลายครั้งติดกัน', () => {
  const s = new Store(null);
  const nos = Array.from({ length: 50 }, () => s.nextTicketNo());
  assert.equal(new Set(nos).size, 50);
  s.close();
});

test('ย้ายข้อมูลจาก db.json เดิมเข้า SQLite เมื่อเริ่มเซิร์ฟเวอร์ (ครั้งเดียว) และล็อกอินด้วยรหัสเดิมได้', async () => {
  // สร้างไฟล์ JSON รูปแบบเวอร์ชันแรก (ไม่มี active / tokenVersion / createdAt)
  const { hashPassword } = require('../src/auth');
  const dir = tmp();
  const legacy = {
    meta: { ticketSeq: 7 },
    users: [{ _id: 'u-old', username: 'olduser', name: 'ผู้ใช้เก่า', role: 'employee', passwordHash: hashPassword('oldpass123') }],
    categories: [{ _id: 'c1', slug: 'other', name: 'อื่น ๆ' }],
    tickets: [{ _id: 't-old', no: 7, title: 'ตั๋วเก่า', description: 'd', category: 'other', priority: 'low', status: 'open', images: [], notes: [], createdBy: 'u-old', createdByName: 'ผู้ใช้เก่า', assignedTo: null, assignedToName: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', firstResponseAt: null, resolvedAt: null }],
    logs: [],
  };
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'db.json'), JSON.stringify(legacy));

  // createServer หาไฟล์เดิมจากโฟลเดอร์ data ของโปรเจกต์ จึงทดสอบ importLegacyJson โดยตรง
  const s = new Store(path.join(dir, 'data', 'helpdesk.db'));
  assert.equal(s.importLegacyJson(path.join(dir, 'data', 'db.json')), 3);
  assert.equal(s.nextTicketNo(), 8); // เลขตั๋วต่อจากของเดิม
  const u = s.users.findOne({ username: 'olduser' });
  assert.equal(u.active, true);
  assert.equal(u.tokenVersion, 0);
  assert.equal(s.tickets.findOne({ no: 7 }).title, 'ตั๋วเก่า');
  s.close();

  // และเซิร์ฟเวอร์ทำงานกับฐานข้อมูลที่ย้ายมาแล้วได้
  const server = createServer({ store: new Store(path.join(dir, 'data', 'helpdesk.db')), jwtSecret: 's', quiet: true });
  await new Promise((r) => server.listen(0, r));
  const res = await fetch(`http://localhost:${server.address().port}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'olduser', password: 'oldpass123' }),
  });
  assert.equal(res.status, 200);
  server.close();
  server.store.close();
});

test('migration: ฐานข้อมูลเวอร์ชันเก่า (ไม่มีคอลัมน์ผู้แจ้งภายนอก) ถูกอัปเกรดอัตโนมัติโดยข้อมูลเดิมครบ', () => {
  const file = path.join(tmp(), 'old.db');
  const a = new Store(file);
  const t = a.tickets.insertOne(ticket({ no: a.nextTicketNo(), title: 'ตั๋วจากเวอร์ชันเก่า' }));
  // จำลองฐานข้อมูลเก่า: ถอดคอลัมน์ที่เพิ่มใหม่ออก
  a.db.exec('ALTER TABLE tickets DROP COLUMN guestContact');
  a.db.exec('ALTER TABLE tickets DROP COLUMN trackHash');
  assert.ok(!a.db.prepare('PRAGMA table_info(tickets)').all().some((c) => c.name === 'trackHash'));
  a.close();

  const b = new Store(file); // เปิดด้วยโค้ดใหม่
  const cols = b.db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
  assert.ok(cols.includes('guestContact') && cols.includes('trackHash'));
  const old = b.tickets.findOne({ _id: t._id });
  assert.equal(old.title, 'ตั๋วจากเวอร์ชันเก่า');
  assert.equal(old.guestContact, null);
  assert.equal(old.trackHash, null);
  const fresh = b.tickets.insertOne(ticket({ no: b.nextTicketNo(), guestContact: '081-234-5678', trackHash: 'abc' }));
  assert.equal(fresh.guestContact, '081-234-5678');
  b.close();
  assert.doesNotThrow(() => new Store(file).close()); // เปิดซ้ำได้ (migrate ซ้ำไม่ทำอะไร)
});
