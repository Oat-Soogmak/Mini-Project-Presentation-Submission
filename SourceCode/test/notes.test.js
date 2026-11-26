'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');
const { Store } = require('../src/db');

let server;
let base;
const tokens = {};

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

before(async () => {
  server = createServer({ store: new Store(null), jwtSecret: 'test-secret', quiet: true, demo: true });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  for (const u of ['somchai', 'suda', 'tech1', 'tech2', 'manager']) {
    tokens[u] = (await call('POST', '/api/v1/auth/login', { body: { username: u, password: 'password123' } })).json.token;
  }
});

after(() => {
  server.close();
  server.store.close();
});

test('โน้ตถูกประทับชื่อผู้บันทึกและเวลาโดยระบบ (ส่งชื่อ/เวลามาเองไม่มีผล) และพนักงานเจ้าของตั๋วเห็นได้', async () => {
  const t = await call('POST', '/api/v1/tickets', { token: tokens.somchai, body: { title: 'ทดสอบโน้ต', description: 'd', category: 'other' } });
  const id = t.json.ticket._id;
  const before = Date.now();
  const r = await call('POST', `/api/v1/tickets/${id}/notes`, {
    token: tokens.tech1,
    body: { text: '  รับเรื่องแล้ว กำลังไปที่โต๊ะ  ', byName: 'ปลอมชื่อ', at: '2000-01-01T00:00:00Z' },
  });
  assert.equal(r.status, 201);
  const note = r.json.ticket.notes.at(-1);
  assert.equal(note.byName, 'ช่างวิทย์ ซ่อมเก่ง');
  assert.equal(note.text, 'รับเรื่องแล้ว กำลังไปที่โต๊ะ');
  assert.ok(new Date(note.at).getTime() >= before - 1000);

  const mine = await call('GET', `/api/v1/tickets/${id}`, { token: tokens.somchai });
  assert.equal(mine.status, 200);
  assert.equal(mine.json.ticket.notes[0].text, 'รับเรื่องแล้ว กำลังไปที่โต๊ะ');
  assert.ok(mine.json.history.some((h) => h.action === 'ticket.note' && h.actorName === 'ช่างวิทย์ ซ่อมเก่ง'));
});

test('สิทธิ์: พนักงานเพิ่มโน้ตไม่ได้, ช่างเพิ่มโน้ตในงานของช่างอื่นไม่ได้, ผู้จัดการได้, ต้องล็อกอิน', async () => {
  const t = await call('POST', '/api/v1/tickets', { token: tokens.suda, body: { title: 'สิทธิ์โน้ต', description: 'd', category: 'other' } });
  const id = t.json.ticket._id;
  const url = `/api/v1/tickets/${id}/notes`;
  assert.equal((await call('POST', url, { body: { text: 'x' } })).status, 401);
  assert.equal((await call('POST', url, { token: tokens.suda, body: { text: 'x' } })).status, 403);
  assert.equal((await call('PATCH', `/api/v1/tickets/${id}/assign`, { token: tokens.tech1, body: {} })).status, 200);
  const other = await call('POST', url, { token: tokens.tech2, body: { text: 'แทรกงานคนอื่น' } });
  assert.equal(other.status, 403);
  assert.equal((await call('POST', url, { token: tokens.tech1, body: { text: 'ของฉัน' } })).status, 201);
  assert.equal((await call('POST', url, { token: tokens.manager, body: { text: 'ผู้จัดการสอบถาม' } })).status, 201);
  assert.equal((await call('POST', '/api/v1/tickets/nope/notes', { token: tokens.tech1, body: { text: 'x' } })).status, 404);
});

test('ช่างโน้ตในตั๋วที่ยังไม่มอบหมายได้ และโน้ตหลังปิดงานได้', async () => {
  const t = await call('POST', '/api/v1/tickets', { token: tokens.somchai, body: { title: 'โน้ตหลังปิดงาน', description: 'd', category: 'other' } });
  const id = t.json.ticket._id;
  assert.equal((await call('POST', `/api/v1/tickets/${id}/notes`, { token: tokens.tech2, body: { text: 'ตรวจเบื้องต้น' } })).status, 201);
  await call('PUT', `/api/v1/tickets/${id}/status`, { token: tokens.tech2, body: { status: 'in_progress' } });
  await call('PUT', `/api/v1/tickets/${id}/status`, { token: tokens.tech2, body: { status: 'resolved' } });
  const after = await call('POST', `/api/v1/tickets/${id}/notes`, { token: tokens.tech2, body: { text: 'สรุป: เปลี่ยนอะไหล่แล้ว' } });
  assert.equal(after.status, 201);
  assert.equal(after.json.ticket.status, 'resolved'); // โน้ตไม่เปลี่ยนสถานะ
  assert.equal(after.json.ticket.notes.length, 2);
});

test('validation: ว่าง/ยาวเกิน/ไม่ใช่ข้อความ ถูกปฏิเสธ และโน้ตไม่เกิน 100 รายการ', async () => {
  const t = await call('POST', '/api/v1/tickets', { token: tokens.somchai, body: { title: 'ตรวจโน้ต', description: 'd', category: 'other' } });
  const url = `/api/v1/tickets/${t.json.ticket._id}/notes`;
  for (const text of ['', '   ', 'x'.repeat(1001), 123, null, undefined]) {
    assert.equal((await call('POST', url, { token: tokens.manager, body: { text } })).status, 400, `text=${String(text).slice(0, 8)}`);
  }
  assert.equal((await call('POST', url, { token: tokens.manager, body: { text: 'x'.repeat(1000) } })).status, 201);
  for (let i = 1; i < 100; i++) await call('POST', url, { token: tokens.manager, body: { text: `n${i}` } });
  assert.equal((await call('POST', url, { token: tokens.manager, body: { text: 'เกินกำหนด' } })).status, 409);
});
