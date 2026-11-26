'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');
const { Store } = require('../src/db');

const servers = [];
async function boot(options = {}) {
  const server = createServer({ store: new Store(null), jwtSecret: 'test-secret', quiet: true, demo: true, guestLimit: 1000, guestGlobalLimit: 1000, ...options });
  await new Promise((r) => server.listen(0, r));
  servers.push(server);
  return `http://localhost:${server.address().port}`;
}

async function call(base, method, path, { token, body, raw } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, text, json: raw ? null : JSON.parse(text || 'null') };
}

const guestBody = (over = {}) => ({
  name: 'คุณสมศรี ผู้มาติดต่อ',
  contact: '081-234-5678',
  title: 'ปลั๊กไฟห้องประชุมไม่มีไฟ',
  description: 'เสียบแล้วไม่มีไฟเข้า ใช้โปรเจกเตอร์ไม่ได้',
  category: 'hardware',
  priority: 'high',
  ...over,
});

let base;
const tokens = {};
before(async () => {
  base = await boot();
  for (const u of ['somchai', 'tech1', 'tech2', 'manager']) {
    tokens[u] = (await call(base, 'POST', '/api/v1/auth/login', { body: { username: u, password: 'password123' } })).json.token;
  }
});
after(() => servers.forEach((s) => { s.close(); s.store.close(); }));

test('ข้อมูลตั้งต้นสำหรับหน้าสาธารณะเปิดได้โดยไม่ต้องล็อกอิน', async () => {
  const cfg = await call(base, 'GET', '/api/v1/public/config');
  assert.deepEqual(cfg.json, { guestEnabled: true, demo: true });
  const cats = await call(base, 'GET', '/api/v1/public/categories');
  assert.equal(cats.status, 200);
  assert.ok(cats.json.data.length >= 3);
  assert.equal((await call(base, 'GET', '/api/v1/categories')).status, 401); // ของเดิมยังต้องล็อกอิน
});

test('ผู้แจ้งภายนอกสร้างตั๋วได้โดยไม่ต้องล็อกอิน; ช่างเห็นข้อมูลติดต่อ; พนักงานคนอื่นไม่เห็น', async () => {
  const before = (await call(base, 'GET', '/api/v1/tickets', { token: tokens.tech1 })).json.total;
  const r = await call(base, 'POST', '/api/v1/public/tickets', { body: guestBody() });
  assert.equal(r.status, 201);
  assert.ok(r.json.no > 0);
  assert.ok(typeof r.json.trackToken === 'string' && r.json.trackToken.length >= 20);

  const list = await call(base, 'GET', '/api/v1/tickets', { token: tokens.tech1 });
  assert.equal(list.json.total, before + 1);
  const t = list.json.data.find((x) => x.no === r.json.no);
  assert.equal(t.guest, true);
  assert.equal(t.createdByName, 'คุณสมศรี ผู้มาติดต่อ');
  assert.equal(t.guestContact, '081-234-5678');
  assert.equal(t.status, 'open');

  // พนักงานที่ล็อกอินไม่เห็นตั๋วของผู้แจ้งภายนอก (ทั้งรายการ รายละเอียด และการยกเลิก)
  const mine = await call(base, 'GET', '/api/v1/tickets', { token: tokens.somchai });
  assert.ok(!mine.json.data.some((x) => x.no === r.json.no));
  assert.equal((await call(base, 'GET', `/api/v1/tickets/${t._id}`, { token: tokens.somchai })).status, 404);
  assert.equal((await call(base, 'DELETE', `/api/v1/tickets/${t._id}`, { token: tokens.somchai })).status, 404);
});

test('รหัสติดตาม (trackHash) ไม่หลุดออกไปกับ response ใดเลย', async () => {
  const r = await call(base, 'POST', '/api/v1/public/tickets', { body: guestBody({ title: 'ทดสอบความลับ' }) });
  const list = await call(base, 'GET', '/api/v1/tickets', { token: tokens.manager, raw: true });
  const id = JSON.parse(list.text).data.find((x) => x.no === r.json.no)._id;
  const detail = await call(base, 'GET', `/api/v1/tickets/${id}`, { token: tokens.manager, raw: true });
  for (const res of [list, detail, r]) {
    assert.ok(!res.text.includes('trackHash'), 'ต้องไม่มีฟิลด์ trackHash');
  }
  assert.ok(!list.text.includes(r.json.trackToken) && !detail.text.includes(r.json.trackToken));
});

test('validation: ข้อมูลไม่ครบ/ผิดรูปแบบถูกปฏิเสธ และไม่สร้างตั๋ว', async () => {
  const total = () => call(base, 'GET', '/api/v1/tickets', { token: tokens.manager }).then((r) => r.json.total);
  const n0 = await total();
  const bad = [
    { name: '' }, { name: 'ก' }, { name: 'x'.repeat(81) }, { contact: '' }, { contact: 'ab' }, { contact: 'x'.repeat(101) },
    { title: 'ab' }, { description: '   ' }, { category: 'nope' }, { priority: 'urgent' },
    { images: ['data:text/html;base64,PHNjcmlwdD4='] }, { images: Array(4).fill('data:image/png;base64,iVBORw0KGgo=') },
    { name: 123 },
  ];
  for (const over of bad) {
    const r = await call(base, 'POST', '/api/v1/public/tickets', { body: guestBody(over) });
    assert.equal(r.status, 400, JSON.stringify(over).slice(0, 60));
  }
  assert.equal((await call(base, 'POST', '/api/v1/public/tickets', { body: guestBody({ images: ['data:image/png;base64,iVBORw0KGgo='] }) })).status, 201);
  assert.equal(await total(), n0 + 1);
});

test('honeypot: บอตที่กรอกช่องซ่อนถูกเมินเงียบ ๆ (ตอบเหมือนสำเร็จแต่ไม่บันทึก)', async () => {
  const n0 = (await call(base, 'GET', '/api/v1/tickets', { token: tokens.manager })).json.total;
  const r = await call(base, 'POST', '/api/v1/public/tickets', { body: guestBody({ website: 'http://spam.example' }) });
  assert.equal(r.status, 201);
  assert.equal(r.json.no, 0);
  assert.equal((await call(base, 'GET', '/api/v1/tickets', { token: tokens.manager })).json.total, n0);
  const miss = await call(base, 'POST', '/api/v1/public/track', { body: { no: 0, token: r.json.trackToken } });
  assert.ok([400, 404].includes(miss.status)); // รหัสปลอมใช้ติดตามไม่ได้
});

test('ติดตามสถานะ: ถูกต้องเห็นความคืบหน้าและโน้ตจากช่าง; ผิดรหัส/ผิดเลขได้ 404 เหมือนกัน', async () => {
  const r = await call(base, 'POST', '/api/v1/public/tickets', { body: guestBody({ title: 'ติดตามสถานะ' }) });
  const { no, trackToken } = r.json;
  const track = (body) => call(base, 'POST', '/api/v1/public/track', { body });

  const first = await track({ no, token: trackToken });
  assert.equal(first.status, 200);
  assert.equal(first.json.ticket.status, 'open');
  assert.equal(first.json.ticket.assignedToName, null);
  assert.equal(first.json.ticket.categoryName, 'ฮาร์ดแวร์ (คอมพิวเตอร์/เครื่องพิมพ์)');

  // ช่างรับงาน + โน้ต + เริ่มดำเนินการ: ผู้แจ้งภายนอกเห็นความคืบหน้า
  const id = (await call(base, 'GET', '/api/v1/tickets', { token: tokens.tech1 })).json.data.find((x) => x.no === no)._id;
  await call(base, 'PATCH', `/api/v1/tickets/${id}/assign`, { token: tokens.tech1, body: {} });
  await call(base, 'POST', `/api/v1/tickets/${id}/notes`, { token: tokens.tech1, body: { text: 'กำลังไปตรวจที่ห้องประชุม' } });
  await call(base, 'PUT', `/api/v1/tickets/${id}/status`, { token: tokens.tech1, body: { status: 'in_progress' } });
  const mid = (await track({ no, token: trackToken })).json.ticket;
  assert.equal(mid.status, 'in_progress');
  assert.equal(mid.assignedToName, 'ช่างวิทย์ ซ่อมเก่ง');
  assert.ok(mid.firstResponseAt);
  assert.equal(mid.notes[0].text, 'กำลังไปตรวจที่ห้องประชุม');
  assert.equal(mid.notes[0].byName, 'ช่างวิทย์ ซ่อมเก่ง');

  // ข้อมูลภายในต้องไม่หลุด
  const raw = JSON.stringify(mid);
  for (const secret of ['guestContact', '081-234-5678', 'trackHash', 'images', 'createdBy']) assert.ok(!raw.includes(secret), secret);

  const wrongToken = await track({ no, token: 'x'.repeat(22) });
  const wrongNo = await track({ no: 99999, token: trackToken });
  assert.equal(wrongToken.status, 404);
  assert.equal(wrongNo.status, 404);
  assert.equal(wrongToken.json.error, wrongNo.json.error); // ไม่บอกว่ามีเลขตั๋วนั้นหรือไม่
  assert.equal((await track({ no })).status, 400);
  assert.equal((await track({ no: 'abc', token: trackToken })).status, 400);
  assert.equal((await track({ no, token: 'short' })).status, 400);
  assert.equal((await track({ no, token: { $ne: 1 } })).status, 400);
  // รหัสติดตามของตั๋วหนึ่งใช้กับอีกใบไม่ได้ และตั๋วของพนักงาน (ไม่มีรหัส) ติดตามผ่านช่องทางนี้ไม่ได้
  const other = await call(base, 'POST', '/api/v1/public/tickets', { body: guestBody({ title: 'อีกใบ' }) });
  assert.equal((await track({ no: other.json.no, token: trackToken })).status, 404);
  assert.equal((await track({ no: 1, token: trackToken })).status, 404);
});

test('rate limit: แจ้งเกินโควตาต่อ IP ได้ 429 (นับทุกครั้งที่ส่ง) และค้นหาเกินโควตาได้ 429', async () => {
  const b = await boot({ guestLimit: 3, trackLimit: 4 });
  for (let i = 0; i < 3; i++) assert.equal((await call(b, 'POST', '/api/v1/public/tickets', { body: guestBody() })).status, 201);
  const blocked = await call(b, 'POST', '/api/v1/public/tickets', { body: guestBody() });
  assert.equal(blocked.status, 429);
  const t = await call(b, 'POST', '/api/v1/public/track', { body: { no: 1, token: 'x'.repeat(22) } });
  assert.equal(t.status, 404);
  for (let i = 0; i < 3; i++) await call(b, 'POST', '/api/v1/public/track', { body: { no: 1, token: 'x'.repeat(22) } });
  assert.equal((await call(b, 'POST', '/api/v1/public/track', { body: { no: 1, token: 'x'.repeat(22) } })).status, 429);
});

test('rate limit ทั้งระบบ: เกินโควตารวมต่อชั่วโมงได้ 429 แม้มาจากหลาย IP (จำลองด้วย X-Forwarded-For)', async () => {
  const b = await boot({ guestGlobalLimit: 2, trustProxy: true });
  const post = (ip) =>
    fetch(`${b}/api/v1/public/tickets`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: JSON.stringify(guestBody()) });
  assert.equal((await post('10.0.0.1')).status, 201);
  assert.equal((await post('10.0.0.2')).status, 201);
  assert.equal((await post('10.0.0.3')).status, 429);
});

test('ปิดฟีเจอร์ได้ (ALLOW_GUEST=0): ส่งไม่ได้ และ config แจ้งว่าปิด', async () => {
  const b = await boot({ allowGuest: false });
  assert.deepEqual((await call(b, 'GET', '/api/v1/public/config')).json, { guestEnabled: false, demo: true });
  assert.equal((await call(b, 'POST', '/api/v1/public/tickets', { body: guestBody() })).status, 403);
});

test('สถิติและการทำงานของช่างรองรับตั๋วผู้แจ้งภายนอก (รับงาน เปลี่ยนสถานะ ปิดงาน)', async () => {
  const r = await call(base, 'POST', '/api/v1/public/tickets', { body: guestBody({ title: 'วงจรเต็ม' }) });
  const id = (await call(base, 'GET', '/api/v1/tickets', { token: tokens.tech2 })).json.data.find((x) => x.no === r.json.no)._id;
  assert.equal((await call(base, 'PATCH', `/api/v1/tickets/${id}/assign`, { token: tokens.tech2, body: {} })).status, 200);
  assert.equal((await call(base, 'PUT', `/api/v1/tickets/${id}/status`, { token: tokens.tech2, body: { status: 'in_progress' } })).status, 200);
  assert.equal((await call(base, 'PUT', `/api/v1/tickets/${id}/status`, { token: tokens.tech2, body: { status: 'resolved', note: 'เปลี่ยนปลั๊กแล้ว' } })).status, 200);
  const final = await call(base, 'POST', '/api/v1/public/track', { body: { no: r.json.no, token: r.json.trackToken } });
  assert.equal(final.json.ticket.status, 'resolved');
  assert.ok(final.json.ticket.resolvedAt);
  assert.ok(final.json.ticket.notes.some((n) => n.text === 'เปลี่ยนปลั๊กแล้ว'));
  assert.equal((await call(base, 'GET', '/api/v1/stats', { token: tokens.manager })).status, 200);
});

test('หน้า static สาธารณะเปิดได้และมี CSP', async () => {
  for (const p of ['/report.html', '/track.html']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  }
});
