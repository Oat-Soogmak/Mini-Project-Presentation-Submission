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
    const r = await call('POST', '/api/v1/auth/login', { body: { username: u, password: 'password123' } });
    assert.equal(r.status, 200);
    tokens[u] = r.json.token;
  }
});

after(() => server.close());

test('ล็อกอินผิดได้ 401 และไม่มี token ได้ 401', async () => {
  const bad = await call('POST', '/api/v1/auth/login', { body: { username: 'somchai', password: 'wrong' } });
  assert.equal(bad.status, 401);
  assert.equal((await call('GET', '/api/v1/tickets')).status, 401);
  assert.equal((await call('GET', '/api/v1/tickets', { token: tokens.somchai + 'x' })).status, 401);
});

test('พนักงานเห็นเฉพาะตั๋วของตนเอง ส่วนช่างเห็นทั้งหมด', async () => {
  const mine = await call('GET', '/api/v1/tickets', { token: tokens.somchai });
  assert.ok(mine.json.data.length >= 1);
  assert.ok(mine.json.data.every((t) => t.createdByName === 'สมชาย ใจดี'));
  const all = await call('GET', '/api/v1/tickets', { token: tokens.tech1 });
  assert.ok(all.json.total > mine.json.total);
});

let ticketId;
test('สร้างตั๋วพร้อมรูป และตรวจ validation', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const ok = await call('POST', '/api/v1/tickets', {
    token: tokens.somchai,
    body: { title: 'จอมอนิเตอร์ดับ', description: 'เปิดเครื่องแล้วจอไม่ติด', category: 'hardware', priority: 'high', images: [png] },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.ticket.status, 'open');
  assert.equal(ok.json.ticket.imageCount, 1);
  ticketId = ok.json.ticket._id;

  const bad = await call('POST', '/api/v1/tickets', { token: tokens.somchai, body: { title: 'x', description: '', category: 'nope' } });
  assert.equal(bad.status, 400);
  const badImg = await call('POST', '/api/v1/tickets', {
    token: tokens.somchai,
    body: { title: 'รูปไม่ปลอดภัย', description: 'ทดสอบ', category: 'other', images: ['data:text/html;base64,PHNjcmlwdD4='] },
  });
  assert.equal(badImg.status, 400);
});

test('พนักงานคนอื่นเปิดดูตั๋วไม่ได้ (404) และมอบหมาย/เปลี่ยนสถานะไม่ได้ (403)', async () => {
  assert.equal((await call('GET', `/api/v1/tickets/${ticketId}`, { token: tokens.suda })).status, 404);
  assert.equal((await call('PATCH', `/api/v1/tickets/${ticketId}/assign`, { token: tokens.somchai, body: {} })).status, 403);
  assert.equal((await call('PUT', `/api/v1/tickets/${ticketId}/status`, { token: tokens.somchai, body: { status: 'in_progress' } })).status, 403);
});

test('filter status=pending เป็นนามแฝงของ open', async () => {
  const r = await call('GET', '/api/v1/tickets?status=pending', { token: tokens.tech1 });
  assert.equal(r.status, 200);
  assert.ok(r.json.data.every((t) => t.status === 'open'));
  assert.equal((await call('GET', '/api/v1/tickets?status=bogus', { token: tokens.tech1 })).status, 400);
});

test('ลำดับสถานะ: ข้ามขั้นไม่ได้ และรับงาน/จบงานได้ตามลำดับ', async () => {
  const skip = await call('PUT', `/api/v1/tickets/${ticketId}/status`, { token: tokens.tech1, body: { status: 'resolved' } });
  assert.equal(skip.status, 409);

  const assign = await call('PATCH', `/api/v1/tickets/${ticketId}/assign`, { token: tokens.tech1, body: {} });
  assert.equal(assign.status, 200);
  assert.equal(assign.json.ticket.assignedToName, 'ช่างวิทย์ ซ่อมเก่ง');
  assert.ok(assign.json.ticket.firstResponseAt);

  // ช่างอีกคนแก้งานของคนอื่นไม่ได้
  const other = await call('PUT', `/api/v1/tickets/${ticketId}/status`, { token: tokens.tech2, body: { status: 'in_progress' } });
  assert.equal(other.status, 403);

  const start = await call('PUT', `/api/v1/tickets/${ticketId}/status`, { token: tokens.tech1, body: { status: 'in_progress' } });
  assert.equal(start.status, 200);
  const done = await call('PATCH', `/api/v1/tickets/${ticketId}/status`, { token: tokens.tech1, body: { status: 'resolved', note: 'เปลี่ยนสายสัญญาณแล้ว' } });
  assert.equal(done.status, 200);
  assert.equal(done.json.ticket.status, 'resolved');
  assert.ok(done.json.ticket.resolvedAt);
});

test('รายละเอียดตั๋วมีรูปและประวัติการดำเนินการ', async () => {
  const r = await call('GET', `/api/v1/tickets/${ticketId}`, { token: tokens.somchai });
  assert.equal(r.status, 200);
  assert.equal(r.json.ticket.images.length, 1);
  assert.ok(r.json.history.length >= 4);
});

test('ยกเลิกได้เฉพาะสถานะ Open และเฉพาะเจ้าของ', async () => {
  assert.equal((await call('DELETE', `/api/v1/tickets/${ticketId}`, { token: tokens.somchai })).status, 409); // resolved แล้ว
  const t = await call('POST', '/api/v1/tickets', {
    token: tokens.suda,
    body: { title: 'ขอยกเลิกทดสอบ', description: 'ทดสอบยกเลิก', category: 'other' },
  });
  const id = t.json.ticket._id;
  assert.equal((await call('DELETE', `/api/v1/tickets/${id}`, { token: tokens.somchai })).status, 404);
  assert.equal((await call('DELETE', `/api/v1/tickets/${id}`, { token: tokens.suda })).status, 200);
  assert.equal((await call('GET', `/api/v1/tickets/${id}`, { token: tokens.suda })).status, 404);
});

test('สถิติเข้าถึงได้เฉพาะผู้จัดการ', async () => {
  assert.equal((await call('GET', '/api/v1/stats', { token: tokens.tech1 })).status, 403);
  const r = await call('GET', '/api/v1/stats', { token: tokens.manager });
  assert.equal(r.status, 200);
  assert.ok(r.json.total >= 3);
  assert.equal(typeof r.json.avgFirstResponseMinutes, 'number');
  assert.equal(r.json.technicians.length, 2);
});

test('SSE: แจ้งเฉพาะเหตุการณ์ที่ผู้ใช้มีสิทธิ์เห็น', async () => {
  async function open(token) {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/v1/events`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const state = { text: '' };
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          state.text += dec.decode(value, { stream: true });
        }
      } catch { /* aborted */ }
    })();
    return { state, close: () => ac.abort() };
  }
  const owner = await open(tokens.somchai);
  const stranger = await open(tokens.suda);
  const staff = await open(tokens.tech1);
  await new Promise((r) => setTimeout(r, 100));

  const created = await call('POST', '/api/v1/tickets', {
    token: tokens.somchai,
    body: { title: 'ทดสอบเหตุการณ์สด', description: 'ตรวจ SSE', category: 'software' },
  });
  await call('PATCH', `/api/v1/tickets/${created.json.ticket._id}/assign`, { token: tokens.tech1, body: {} });
  await new Promise((r) => setTimeout(r, 200));

  assert.match(owner.state.text, /event: ticket\.created/);
  assert.match(owner.state.text, /event: ticket\.updated/);
  assert.match(staff.state.text, /event: ticket\.updated/);
  assert.doesNotMatch(stranger.state.text, /ticket\./);
  owner.close();
  stranger.close();
  staff.close();
});

test('ไฟล์ static ปลอดภัยจาก path traversal', async () => {
  const r = await fetch(`${base}/..%2f..%2fetc%2fpasswd`);
  assert.ok([403, 404].includes(r.status));
  const csp = (await fetch(base + '/')).headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
});
