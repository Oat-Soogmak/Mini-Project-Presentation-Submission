'use strict';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store } = require('./db');
const auth = require('./auth');
const { seed, usersWithDemoPassword } = require('./seed');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const API = '/api/v1';

const STATUSES = ['open', 'in_progress', 'resolved'];
const STATUS_ALIAS = { pending: 'open' }; // เอกสารใช้ ?status=pending
const NEXT_STATUS = { open: 'in_progress', in_progress: 'resolved' }; // Open -> In Progress -> Resolved
const PRIORITIES = ['low', 'medium', 'high'];
const STAFF = ['it_support', 'manager'];
const GUEST_ID = 'guest'; // ค่า createdBy ของตั๋วที่แจ้งโดยผู้ไม่มีบัญชี (ไม่ตรงกับบัญชีใดจึงไม่มีพนักงานคนไหนเห็น)

const MAX_BODY = 6 * 1024 * 1024;
const MAX_IMAGES = 3;
const MAX_IMAGE_CHARS = 1_800_000; // ~1.3MB ต่อรูป (base64)
const IMAGE_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function createServer(options = {}) {
  const ownStore = !options.store;
  // โฟลเดอร์เก็บข้อมูล (ฐานข้อมูล + กุญแจ JWT) ตั้งได้ด้วย DATA_DIR เพื่อชี้ไปที่ volume ของ Docker
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const store = options.store || new Store(options.dataFile ?? path.join(dataDir, 'helpdesk.db'));
  // ย้ายข้อมูลจากเวอร์ชันเก่า (ไฟล์ JSON) เข้า SQLite ครั้งเดียว ถ้าฐานข้อมูลยังว่าง
  const legacy = path.join(dataDir, 'db.json');
  if (ownStore && store.file && fs.existsSync(legacy) && store.users.find().length === 0) {
    const n = store.importLegacyJson(legacy);
    fs.renameSync(legacy, `${legacy}.migrated`); // เก็บไฟล์เดิมไว้เป็นข้อมูลสำรอง
    if (!options.quiet) console.log(`[migrate] นำเข้าข้อมูลเดิม ${n} รายการจาก db.json (เก็บสำรองเป็น db.json.migrated)`);
  }
  // โหมดสาธิต (บัญชี/ตั๋วตัวอย่างที่ใช้รหัสผ่านเปิดเผย) ต้องเปิดเองด้วย DEMO=1 เท่านั้น
  const demo = options.demo ?? process.env.DEMO === '1';
  const bootstrap = seed(store, {
    demo,
    initialManager: options.initialManager || {
      username: process.env.INITIAL_MANAGER_USERNAME,
      password: process.env.INITIAL_MANAGER_PASSWORD,
    },
  });
  if (!options.quiet) {
    if (bootstrap) {
      console.log(`[setup] สร้างผู้จัดการคนแรกแล้ว  ชื่อผู้ใช้: ${bootstrap.username}`);
      if (bootstrap.generated) {
        console.log(`[setup] รหัสผ่านที่สุ่มให้ (แสดงครั้งเดียวเท่านั้น): ${bootstrap.password}`);
        console.log('[setup] ล็อกอินแล้วเปลี่ยนรหัสผ่านทันที หรือกำหนดเองครั้งแรกด้วย INITIAL_MANAGER_PASSWORD');
      }
    }
    if (demo) console.warn('[warn] เปิดโหมดสาธิต (DEMO=1): มีบัญชีที่ใช้รหัสผ่าน password123 ห้ามใช้กับระบบจริง');
    else {
      const weak = usersWithDemoPassword(store);
      if (weak.length) console.warn(`[warn] พบบัญชีที่ยังใช้รหัสผ่านสาธิต (${weak.join(', ')}) กรุณาให้ผู้จัดการรีเซ็ตรหัสผ่านหรือปิดใช้งานบัญชีเหล่านี้`);
    }
  }

  // กุญแจเซ็น JWT: ตั้งเองด้วย JWT_SECRET > ไฟล์ที่ระบบสร้างไว้ใน data (คงอยู่หลังรีสตาร์ท) > สุ่มชั่วคราว (เฉพาะฐานข้อมูลในหน่วยความจำ)
  // ตรวจความยาวเฉพาะค่าที่ผู้ดูแลตั้งผ่านตัวแปรสภาพแวดล้อม (ค่าที่ส่งเป็นอ็อบเจกต์ตอนทดสอบไม่ถูกบังคับ)
  if (!options.jwtSecret && process.env.JWT_SECRET && process.env.JWT_SECRET.length < 16)
    throw new Error('JWT_SECRET สั้นเกินไป (อย่างน้อย 16 ตัวอักษร แนะนำ: openssl rand -hex 32)');
  let jwtSecret = options.jwtSecret || process.env.JWT_SECRET;
  if (!jwtSecret && ownStore && store.file) {
    const secretFile = path.join(path.dirname(store.file), 'jwt-secret');
    try {
      jwtSecret = fs.readFileSync(secretFile, 'utf8').trim();
    } catch {
      jwtSecret = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(secretFile, jwtSecret, { mode: 0o600 });
    }
    if (jwtSecret.length < 16) throw new Error(`ไฟล์ ${secretFile} เสียหาย ให้ลบไฟล์นี้แล้วเริ่มระบบใหม่ (ผู้ใช้ต้องล็อกอินใหม่)`);
  }
  if (!jwtSecret) jwtSecret = crypto.randomBytes(32).toString('hex');

  /* ---------- helpers ---------- */
  const publicUser = (u) => ({ id: u._id, username: u.username, name: u.name, role: u.role });
  const isActive = (u) => u.active !== false; // บัญชีเดิมที่ไม่มีฟิลด์ active ถือว่าใช้งานอยู่
  const adminUser = (u) => ({ ...publicUser(u), active: isActive(u), createdAt: u.createdAt || null });
  // trackHash เป็นความลับ ห้ามหลุดออกไปกับ response ใด ๆ
  const withoutSecrets = ({ trackHash, ...rest }) => rest;
  const listTicket = (t) => {
    const { images, trackHash, ...rest } = t;
    return { ...rest, guest: t.createdBy === GUEST_ID, imageCount: images.length };
  };

  // ตรวจและทำความสะอาดข้อมูลตั๋ว (ใช้ร่วมกันทั้งผู้ใช้ที่ล็อกอินและผู้แจ้งภายนอก)
  function parseTicketBody(body) {
    const { title, description, category, priority = 'medium', images = [] } = body || {};
    if (typeof title !== 'string' || title.trim().length < 3 || title.length > 120)
      throw new HttpError(400, 'หัวข้อต้องยาว 3-120 ตัวอักษร');
    if (typeof description !== 'string' || !description.trim() || description.length > 2000)
      throw new HttpError(400, 'กรุณาระบุรายละเอียดอาการ (ไม่เกิน 2000 ตัวอักษร)');
    if (!store.categories.findOne({ slug: category })) throw new HttpError(400, 'หมวดหมู่ไม่ถูกต้อง');
    if (!PRIORITIES.includes(priority)) throw new HttpError(400, 'ระดับความเร่งด่วนไม่ถูกต้อง');
    if (!Array.isArray(images) || images.length > MAX_IMAGES) throw new HttpError(400, `แนบรูปได้สูงสุด ${MAX_IMAGES} รูป`);
    for (const img of images) {
      if (typeof img !== 'string' || img.length > MAX_IMAGE_CHARS || !IMAGE_RE.test(img))
        throw new HttpError(400, 'ไฟล์รูปไม่ถูกต้องหรือมีขนาดใหญ่เกินไป (รองรับ png/jpeg/webp/gif)');
    }
    return { title: title.trim(), description: description.trim(), category, priority, images };
  }
  const log = (actor, action, ticket, detail = {}) =>
    store.logs.insertOne({ at: new Date().toISOString(), actorId: actor._id, actorName: actor.name, action, ticketId: ticket._id, detail });

  /* ---------- real-time (Server-Sent Events) ---------- */
  const clients = new Set();
  function broadcast(event, data, ownerId) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) {
      // พนักงานได้รับเฉพาะเหตุการณ์ของตั๋วตนเอง; ช่างและผู้จัดการได้รับทั้งหมด
      if (c.user.role === 'employee' && c.user._id !== ownerId) continue;
      c.res.write(payload);
    }
  }
  const heartbeat = setInterval(() => {
    for (const c of clients) c.res.write(': ping\n\n');
  }, 25000);
  heartbeat.unref();

  /* ---------- rate limit การล็อกอิน ---------- */
  const attempts = new Map();
  function checkLoginRate(ip) {
    const now = Date.now();
    const rec = attempts.get(ip);
    if (!rec || rec.resetAt < now) return true;
    return rec.count < 10;
  }
  function recordLoginFailure(ip) {
    const now = Date.now();
    const rec = attempts.get(ip);
    if (!rec || rec.resetAt < now) attempts.set(ip, { count: 1, resetAt: now + 60000 });
    else rec.count += 1;
  }

  /* ---------- rate limit ทั่วไป และการหา IP ผู้ใช้ ---------- */
  function makeLimiter(max, windowMs) {
    const hits = new Map();
    return {
      /** นับหนึ่งครั้ง คืน false เมื่อเกินโควตาในช่วงเวลานั้น */
      take(key) {
        const now = Date.now();
        if (hits.size > 5000) for (const [k, r] of hits) if (r.resetAt < now) hits.delete(k); // กันหน่วยความจำโต
        const rec = hits.get(key);
        if (!rec || rec.resetAt < now) {
          hits.set(key, { count: 1, resetAt: now + windowMs });
          return true;
        }
        if (rec.count >= max) return false;
        rec.count += 1;
        return true;
      },
    };
  }
  // หลัง reverse proxy ให้ตั้ง TRUST_PROXY=1 เพื่ออ่าน IP จริงจาก X-Forwarded-For (ค่าท้ายสุด = ที่ proxy เห็น)
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY === '1';
  function clientIp(req) {
    if (trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (xff.length) return xff[xff.length - 1];
    }
    return req.socket.remoteAddress || 'unknown';
  }
  const allowGuest = options.allowGuest ?? process.env.ALLOW_GUEST !== '0';
  const guestPerIp = makeLimiter(options.guestLimit ?? 5, 10 * 60 * 1000); // 5 เรื่อง / 10 นาที / IP
  const guestGlobal = makeLimiter(options.guestGlobalLimit ?? 100, 60 * 60 * 1000); // 100 เรื่อง / ชม. ทั้งระบบ
  const trackLimiter = makeLimiter(options.trackLimit ?? 60, 60 * 1000);

  /* ---------- routes ---------- */
  const routes = [];
  const route = (method, pattern, roles, handler) => {
    const keys = [];
    const re = new RegExp(
      '^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$',
    );
    routes.push({ method, re, keys, roles, handler });
  };

  route('POST', '/auth/login', null, async ({ body, req }) => {
    const ip = clientIp(req);
    if (!checkLoginRate(ip)) throw new HttpError(429, 'ลองเข้าสู่ระบบบ่อยเกินไป กรุณารอสักครู่');
    const { username, password } = body || {};
    const user = typeof username === 'string' ? store.users.findOne({ username: username.trim().toLowerCase() }) : null;
    const ok = user && typeof password === 'string' && auth.verifyPassword(password, user.passwordHash);
    if (!ok) {
      recordLoginFailure(ip);
      throw new HttpError(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
    }
    // เช็กหลังตรวจรหัสผ่านถูกแล้วเท่านั้น เพื่อไม่เปิดเผยสถานะบัญชีให้คนเดารหัส
    if (!isActive(user)) throw new HttpError(403, 'บัญชีนี้ถูกปิดใช้งาน กรุณาติดต่อผู้จัดการ');
    const token = auth.sign({ sub: user._id, role: user.role, tv: user.tokenVersion || 0 }, jwtSecret);
    return { status: 200, body: { token, user: publicUser(user) } };
  });

  route('GET', '/auth/me', [], async ({ user }) => ({ body: { user: publicUser(user) } }));

  route('GET', '/categories', [], async () => ({ body: { data: store.categories.find() } }));

  route('GET', '/users', STAFF, async ({ query }) => {
    const role = query.get('role');
    const users = store.users.find((u) => isActive(u) && (!role || u.role === role)).map(publicUser);
    return { body: { data: users } };
  });

  /* ---------- ผู้แจ้งภายนอก (ไม่ต้องมีบัญชี) ---------- */
  const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

  route('GET', '/public/config', null, async () => ({ body: { guestEnabled: allowGuest, demo } }));
  route('GET', '/public/categories', null, async () => ({ body: { data: store.categories.find() } }));

  // แจ้งซ่อมโดยไม่ต้องล็อกอิน: ได้ "รหัสติดตาม" กลับไปใช้ดูสถานะ (ระบบเก็บเฉพาะแฮช กู้คืนให้ไม่ได้)
  route('POST', '/public/tickets', null, async ({ body, req }) => {
    if (!allowGuest) throw new HttpError(403, 'ระบบปิดรับแจ้งซ่อมแบบไม่ต้องเข้าสู่ระบบ กรุณาเข้าสู่ระบบหรือติดต่อฝ่าย IT');
    if (!guestPerIp.take(clientIp(req)) || !guestGlobal.take('all'))
      throw new HttpError(429, 'มีการแจ้งซ่อมบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่ หรือติดต่อฝ่าย IT โดยตรง');
    // honeypot: ช่องที่คนมองไม่เห็น ถ้าถูกกรอกแปลว่าเป็นบอต ตอบเหมือนสำเร็จแต่ไม่บันทึกอะไร
    if (body && typeof body.website === 'string' && body.website.trim() !== '')
      return { status: 201, body: { no: 0, trackToken: crypto.randomBytes(16).toString('base64url') } };

    const { name, contact } = body || {};
    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 80)
      throw new HttpError(400, 'กรุณาระบุชื่อ-นามสกุล (2-80 ตัวอักษร)');
    if (typeof contact !== 'string' || contact.trim().length < 3 || contact.trim().length > 100)
      throw new HttpError(400, 'กรุณาระบุช่องทางติดต่อกลับ เช่น เบอร์โทร อีเมล หรือ LINE (3-100 ตัวอักษร)');
    const f = parseTicketBody(body);
    const trackToken = crypto.randomBytes(16).toString('base64url'); // 128 บิต เดาไม่ได้
    const now = new Date().toISOString();
    const ticket = store.tickets.insertOne({
      no: store.nextTicketNo(),
      ...f,
      status: 'open',
      notes: [],
      createdBy: GUEST_ID,
      createdByName: name.trim(),
      guestContact: contact.trim(),
      trackHash: sha256(trackToken),
      assignedTo: null,
      assignedToName: null,
      createdAt: now,
      updatedAt: now,
      firstResponseAt: null,
      resolvedAt: null,
    });
    log({ _id: GUEST_ID, name: `${name.trim()} (ผู้แจ้งภายนอก)` }, 'ticket.created', ticket);
    broadcast('ticket.created', { ticket: listTicket(ticket) }, GUEST_ID);
    return { status: 201, body: { no: ticket.no, trackToken } };
  });

  // ติดตามสถานะด้วยเลขตั๋ว + รหัสติดตาม (ส่งทาง POST เพื่อไม่ให้รหัสไปอยู่ใน URL/log)
  route('POST', '/public/track', null, async ({ body, req }) => {
    if (!trackLimiter.take(clientIp(req))) throw new HttpError(429, 'ค้นหาบ่อยเกินไป กรุณารอสักครู่');
    const no = Number(body && body.no);
    const token = body && body.token;
    if (!Number.isInteger(no) || no < 1 || typeof token !== 'string' || token.length < 10 || token.length > 64)
      throw new HttpError(400, 'กรุณาระบุเลขตั๋วและรหัสติดตามให้ครบ');
    const t = store.tickets.findOne({ no });
    const given = Buffer.from(sha256(token), 'hex');
    const stored = t && t.trackHash ? Buffer.from(t.trackHash, 'hex') : null;
    // ตอบข้อความเดียวกันทั้งกรณีไม่มีตั๋วและรหัสผิด ไม่เปิดเผยว่ามีเลขตั๋วนั้นอยู่
    if (!stored || stored.length !== given.length || !crypto.timingSafeEqual(given, stored))
      throw new HttpError(404, 'ไม่พบตั๋ว หรือรหัสติดตามไม่ถูกต้อง');
    const cat = store.categories.findOne({ slug: t.category });
    return {
      body: {
        ticket: {
          no: t.no, title: t.title, description: t.description, priority: t.priority, status: t.status,
          categoryName: cat ? cat.name : t.category,
          createdAt: t.createdAt, updatedAt: t.updatedAt, firstResponseAt: t.firstResponseAt, resolvedAt: t.resolvedAt,
          assignedToName: t.assignedToName,
          notes: t.notes.map(({ at, byName, text }) => ({ at, byName, text })),
        },
      },
    };
  });

  // สร้างตั๋วแจ้งซ่อมใหม่
  route('POST', '/tickets', ['employee', 'it_support', 'manager'], async ({ body, user }) => {
    const f = parseTicketBody(body);
    const now = new Date().toISOString();
    const ticket = store.tickets.insertOne({
      no: store.nextTicketNo(),
      ...f,
      status: 'open',
      notes: [],
      createdBy: user._id,
      createdByName: user.name,
      assignedTo: null,
      assignedToName: null,
      createdAt: now,
      updatedAt: now,
      firstResponseAt: null,
      resolvedAt: null,
    });
    log(user, 'ticket.created', ticket);
    const pub = listTicket(ticket);
    broadcast('ticket.created', { ticket: pub }, ticket.createdBy);
    return { status: 201, body: { ticket: pub } };
  });

  // รายการตั๋ว (พนักงานเห็นเฉพาะของตนเอง / ช่างและผู้จัดการเห็นทั้งหมด)
  route('GET', '/tickets', [], async ({ query, user }) => {
    let status = query.get('status');
    if (status) {
      status = STATUS_ALIAS[status] || status;
      if (!STATUSES.includes(status)) throw new HttpError(400, 'สถานะไม่ถูกต้อง');
    }
    const limit = Math.min(Math.max(parseInt(query.get('limit'), 10) || 100, 1), 200);
    const offset = Math.max(parseInt(query.get('offset'), 10) || 0, 0);
    const all = store.tickets
      .find((t) => (user.role !== 'employee' || t.createdBy === user._id) && (!status || t.status === status))
      .sort((a, b) => b.no - a.no);
    return { body: { data: all.slice(offset, offset + limit).map(listTicket), total: all.length } };
  });

  route('GET', '/tickets/:id', [], async ({ params, user }) => {
    const t = loadTicket(params.id, user);
    const history = store.logs.find({ ticketId: t._id }).map(({ at, actorName, action, detail }) => ({ at, actorName, action, detail }));
    return { body: { ticket: withoutSecrets(t), history } };
  });

  // มอบหมายงานให้ช่าง
  route('PATCH', '/tickets/:id/assign', STAFF, async ({ params, body, user }) => {
    const t = loadTicket(params.id, user);
    if (t.status === 'resolved') throw new HttpError(409, 'ตั๋วที่เสร็จสิ้นแล้วไม่สามารถมอบหมายใหม่ได้');
    let assigneeId = body && body.assigneeId;
    if (!assigneeId && user.role === 'it_support') assigneeId = user._id; // ช่างกดรับงานเอง
    const assignee = assigneeId ? store.users.findOne({ _id: assigneeId }) : null;
    if (!assignee || assignee.role !== 'it_support' || !isActive(assignee)) throw new HttpError(400, 'ผู้รับผิดชอบต้องเป็นช่าง IT ที่ยังใช้งานอยู่');
    if (user.role === 'it_support' && assignee._id !== user._id && t.assignedTo && t.assignedTo !== user._id)
      throw new HttpError(403, 'ช่างไม่สามารถโอนงานของผู้อื่นได้');
    const now = new Date().toISOString();
    const updated = store.tickets.updateOne(t._id, {
      assignedTo: assignee._id,
      assignedToName: assignee.name,
      firstResponseAt: t.firstResponseAt || now,
      updatedAt: now,
    });
    log(user, 'ticket.assigned', updated, { assignee: assignee.name });
    const pub = listTicket(updated);
    broadcast('ticket.updated', { ticket: pub }, updated.createdBy);
    return { body: { ticket: pub } };
  });

  // อัปเดตสถานะการซ่อม (รองรับทั้ง PUT ตามเอกสาร และ PATCH)
  const updateStatus = async ({ params, body, user }) => {
    const t = loadTicket(params.id, user);
    const next = body && body.status;
    if (!STATUSES.includes(next)) throw new HttpError(400, 'สถานะไม่ถูกต้อง');
    if (NEXT_STATUS[t.status] !== next)
      throw new HttpError(409, `ไม่สามารถเปลี่ยนจาก ${t.status} เป็น ${next} ได้ (ลำดับ: open → in_progress → resolved)`);
    if (user.role === 'it_support') {
      if (t.assignedTo && t.assignedTo !== user._id) throw new HttpError(403, 'งานนี้มอบหมายให้ช่างคนอื่นแล้ว');
    } else if (!t.assignedTo) {
      throw new HttpError(409, 'ต้องมอบหมายช่างก่อนเปลี่ยนสถานะ');
    }
    const note = body.note;
    if (note !== undefined && (typeof note !== 'string' || note.length > 1000))
      throw new HttpError(400, 'บันทึกต้องไม่เกิน 1000 ตัวอักษร');
    const now = new Date().toISOString();
    const patch = { status: next, updatedAt: now, firstResponseAt: t.firstResponseAt || now };
    if (!t.assignedTo) Object.assign(patch, { assignedTo: user._id, assignedToName: user.name }); // ช่างรับงานอัตโนมัติ
    if (next === 'resolved') patch.resolvedAt = now;
    if (note && note.trim()) patch.notes = [...t.notes, { at: now, byName: user.name, text: note.trim() }];
    const updated = store.tickets.updateOne(t._id, patch);
    log(user, 'ticket.status', updated, { from: t.status, to: next, note: note ? note.trim() : undefined });
    const pub = listTicket(updated);
    broadcast('ticket.updated', { ticket: pub }, updated.createdBy);
    return { body: { ticket: pub } };
  };
  route('PUT', '/tickets/:id/status', STAFF, updateStatus);
  route('PATCH', '/tickets/:id/status', STAFF, updateStatus);

  // เพิ่มบันทึก (โน้ต) ลงตั๋ว: ระบบประทับชื่อผู้บันทึกและเวลาให้เอง ทำได้ทุกสถานะ รวมถึงหลังปิดงาน
  route('POST', '/tickets/:id/notes', STAFF, async ({ params, body, user }) => {
    const t = loadTicket(params.id, user);
    if (user.role === 'it_support' && t.assignedTo && t.assignedTo !== user._id)
      throw new HttpError(403, 'งานนี้มอบหมายให้ช่างคนอื่นแล้ว');
    const text = body && body.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 1000)
      throw new HttpError(400, 'กรุณาพิมพ์บันทึก (ไม่เกิน 1000 ตัวอักษร)');
    if (t.notes.length >= 100) throw new HttpError(409, 'ตั๋วนี้มีบันทึกครบ 100 รายการแล้ว');
    const now = new Date().toISOString();
    const updated = store.tickets.updateOne(t._id, {
      notes: [...t.notes, { at: now, by: user._id, byName: user.name, text: text.trim() }],
      updatedAt: now,
    });
    log(user, 'ticket.note', updated);
    const pub = listTicket(updated);
    broadcast('ticket.updated', { ticket: pub }, updated.createdBy);
    return { status: 201, body: { ticket: pub } };
  });

  // ยกเลิกการแจ้งซ่อม (เฉพาะเจ้าของ และสถานะยังเป็น Open)
  route('DELETE', '/tickets/:id', ['employee'], async ({ params, user }) => {
    const t = loadTicket(params.id, user);
    if (t.status !== 'open') throw new HttpError(409, 'ยกเลิกได้เฉพาะตั๋วที่ยังเป็นสถานะ Open');
    store.tickets.deleteOne(t._id);
    log(user, 'ticket.cancelled', t, { title: t.title });
    broadcast('ticket.deleted', { _id: t._id }, t.createdBy);
    return { status: 200, body: { ok: true } };
  });

  // สถิติสำหรับผู้จัดการ
  route('GET', '/stats', ['manager'], async () => {
    const all = store.tickets.find();
    const mins = (a, b) => (new Date(b) - new Date(a)) / 60000;
    const avg = (xs) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, all.filter((t) => t.status === s).length]));
    const frt = all.filter((t) => t.firstResponseAt).map((t) => mins(t.createdAt, t.firstResponseAt));
    const res = all.filter((t) => t.resolvedAt).map((t) => mins(t.createdAt, t.resolvedAt));
    const technicians = store.users.find({ role: 'it_support' }).map((u) => {
      const mine = all.filter((t) => t.assignedTo === u._id);
      const done = mine.filter((t) => t.resolvedAt);
      return {
        id: u._id,
        name: u.name,
        active: mine.filter((t) => t.status !== 'resolved').length,
        resolved: done.length,
        avgResolutionMinutes: avg(done.map((t) => mins(t.createdAt, t.resolvedAt))),
      };
    });
    return {
      body: {
        total: all.length,
        byStatus,
        avgFirstResponseMinutes: avg(frt),
        avgResolutionMinutes: avg(res),
        technicians,
      },
    };
  });

  /* ---------- จัดการผู้ใช้ ---------- */
  const ROLES = ['employee', 'it_support', 'manager'];
  const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
  const validPassword = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 128;
  const PASSWORD_MSG = 'รหัสผ่านต้องยาว 8-128 ตัวอักษร';
  const validName = (n) => typeof n === 'string' && n.trim().length > 0 && n.trim().length <= 80;
  const NAME_MSG = 'กรุณาระบุชื่อ-นามสกุล (ไม่เกิน 80 ตัวอักษร)';

  const audit = (actor, action, target, detail = {}) =>
    store.logs.insertOne({
      at: new Date().toISOString(),
      actorId: actor._id,
      actorName: actor.name,
      action,
      ticketId: null,
      targetUserId: target._id,
      detail: { username: target.username, ...detail },
    });

  // ตัดการเชื่อมต่อ real-time ของผู้ใช้ เพื่อให้สิทธิ์ใหม่/บัญชีที่ปิดมีผลทันที (เว็บจะเชื่อมใหม่และถูกปฏิเสธเอง)
  function dropClients(userId) {
    for (const c of [...clients]) {
      if (c.user._id === userId) {
        c.res.end();
        clients.delete(c);
      }
    }
  }

  route('GET', '/admin/users', ['manager'], async () => ({
    body: { data: store.users.find().sort((a, b) => a.name.localeCompare(b.name, 'th')).map(adminUser) },
  }));

  route('POST', '/admin/users', ['manager'], async ({ body, user }) => {
    const { username, name, role, password } = body || {};
    const uname = typeof username === 'string' ? username.trim().toLowerCase() : '';
    if (!USERNAME_RE.test(uname))
      throw new HttpError(400, 'ชื่อผู้ใช้ใช้ได้เฉพาะ a-z 0-9 . _ - ยาว 3-32 ตัวอักษร และต้องขึ้นต้นด้วยตัวอักษรหรือตัวเลข');
    if (!validName(name)) throw new HttpError(400, NAME_MSG);
    if (!ROLES.includes(role)) throw new HttpError(400, 'บทบาทไม่ถูกต้อง');
    if (!validPassword(password)) throw new HttpError(400, PASSWORD_MSG);
    if (store.users.findOne({ username: uname })) throw new HttpError(409, 'ชื่อผู้ใช้นี้ถูกใช้แล้ว');
    const created = store.users.insertOne({
      username: uname,
      name: name.trim(),
      role,
      passwordHash: auth.hashPassword(password),
      active: true,
      tokenVersion: 0,
      createdAt: new Date().toISOString(),
    });
    audit(user, 'user.created', created, { role });
    return { status: 201, body: { user: adminUser(created) } };
  });

  route('PATCH', '/admin/users/:id', ['manager'], async ({ params, body, user }) => {
    const target = store.users.findOne({ _id: params.id });
    if (!target) throw new HttpError(404, 'ไม่พบผู้ใช้');
    const b = body || {};
    const patch = {};
    if (b.name !== undefined) {
      if (!validName(b.name)) throw new HttpError(400, NAME_MSG);
      patch.name = b.name.trim();
    }
    if (b.role !== undefined) {
      if (!ROLES.includes(b.role)) throw new HttpError(400, 'บทบาทไม่ถูกต้อง');
      patch.role = b.role;
    }
    if (b.active !== undefined) {
      if (typeof b.active !== 'boolean') throw new HttpError(400, 'ค่า active ต้องเป็น true/false');
      patch.active = b.active;
    }
    if (!Object.keys(patch).length) throw new HttpError(400, 'ไม่มีข้อมูลที่ต้องแก้ไข');

    const roleChanged = patch.role !== undefined && patch.role !== target.role;
    const deactivating = patch.active === false && isActive(target);
    // กันผู้จัดการล็อกตัวเองออกจากระบบ (ผู้จัดการคนสุดท้ายจึงไม่หายไปไหน)
    if (target._id === user._id && (roleChanged || patch.active === false))
      throw new HttpError(409, 'ไม่สามารถลดสิทธิ์หรือปิดใช้งานบัญชีของตนเองได้');
    // ช่างที่ยังมีงานค้างต้องไม่ถูกปิดบัญชี/เปลี่ยนบทบาท ไม่เช่นนั้นงานจะไม่มีเจ้าของ
    if (target.role === 'it_support' && (roleChanged || deactivating)) {
      const pending = store.tickets.find((t) => t.assignedTo === target._id && t.status !== 'resolved').length;
      if (pending)
        throw new HttpError(409, `ช่างคนนี้ยังมีงานค้าง ${pending} รายการ กรุณามอบหมายให้ช่างคนอื่นหรือรอให้เสร็จก่อน`);
    }

    const { tokenVersion: _ignored, ...changes } = patch;
    if (roleChanged || deactivating) patch.tokenVersion = (target.tokenVersion || 0) + 1; // บังคับล็อกอินใหม่
    const updated = store.users.updateOne(target._id, patch);
    if (patch.tokenVersion !== undefined) dropClients(target._id);

    // ชื่อถูกเก็บซ้ำไว้ในตั๋ว (denormalize) จึงต้องอัปเดตตามด้วย
    if (patch.name !== undefined && patch.name !== target.name) {
      for (const t of store.tickets.find((x) => x.createdBy === target._id || x.assignedTo === target._id)) {
        store.tickets.updateOne(t._id, {
          ...(t.createdBy === target._id ? { createdByName: patch.name } : {}),
          ...(t.assignedTo === target._id ? { assignedToName: patch.name } : {}),
        });
      }
    }
    audit(user, 'user.updated', updated, { changes });
    return { body: { user: adminUser(updated) } };
  });

  // ผู้จัดการรีเซ็ตรหัสผ่านให้ผู้อื่น
  route('POST', '/admin/users/:id/password', ['manager'], async ({ params, body, user }) => {
    const target = store.users.findOne({ _id: params.id });
    if (!target) throw new HttpError(404, 'ไม่พบผู้ใช้');
    if (target._id === user._id) throw new HttpError(409, 'บัญชีของตนเองให้ใช้เมนู “เปลี่ยนรหัสผ่าน”');
    if (!validPassword(body && body.password)) throw new HttpError(400, PASSWORD_MSG);
    store.users.updateOne(target._id, {
      passwordHash: auth.hashPassword(body.password),
      tokenVersion: (target.tokenVersion || 0) + 1,
    });
    dropClients(target._id);
    audit(user, 'user.password_reset', target);
    return { body: { ok: true } };
  });

  // ทุกคนเปลี่ยนรหัสผ่านของตนเอง (ได้ token ใหม่กลับไป ส่วน token เก่าและเซสชันอื่นจะใช้ไม่ได้)
  route('POST', '/auth/password', [], async ({ req, body, user }) => {
    const ip = clientIp(req);
    if (!checkLoginRate(ip)) throw new HttpError(429, 'ลองบ่อยเกินไป กรุณารอสักครู่');
    const { currentPassword, newPassword } = body || {};
    // ใช้ 403 (ไม่ใช่ 401) เพราะ 401 ทำให้หน้าเว็บออกจากระบบ
    if (typeof currentPassword !== 'string' || !auth.verifyPassword(currentPassword, user.passwordHash)) {
      recordLoginFailure(ip);
      throw new HttpError(403, 'รหัสผ่านปัจจุบันไม่ถูกต้อง');
    }
    if (!validPassword(newPassword)) throw new HttpError(400, PASSWORD_MSG);
    if (newPassword === currentPassword) throw new HttpError(400, 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม');
    const tv = (user.tokenVersion || 0) + 1;
    store.users.updateOne(user._id, { passwordHash: auth.hashPassword(newPassword), tokenVersion: tv });
    dropClients(user._id);
    audit(user, 'user.password_changed', user);
    return { body: { token: auth.sign({ sub: user._id, role: user.role, tv }, jwtSecret) } };
  });

  // ช่องทางอัปเดตแบบ Real-time (SSE)
  route('GET', '/events', [], async ({ req, res, user }) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\nevent: hello\ndata: {}\n\n');
    const client = { res, user };
    clients.add(client);
    req.on('close', () => clients.delete(client));
    return { handled: true };
  });

  function loadTicket(id, user) {
    const t = store.tickets.findOne({ _id: id });
    // ไม่เปิดเผยว่ามีตั๋วของคนอื่นอยู่ (ตอบ 404 เหมือนกัน)
    if (!t || (user.role === 'employee' && t.createdBy !== user._id)) throw new HttpError(404, 'ไม่พบตั๋วแจ้งซ่อม');
    return t;
  }

  /* ---------- http plumbing ---------- */
  function send(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new HttpError(413, 'ข้อมูลที่ส่งมีขนาดใหญ่เกินไป'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new HttpError(400, 'รูปแบบ JSON ไม่ถูกต้อง'));
        }
      });
      req.on('error', reject);
    });
  }

  function authenticate(req) {
    const header = req.headers.authorization || '';
    const m = /^Bearer (.+)$/.exec(header);
    const payload = m && auth.verify(m[1], jwtSecret);
    const user = payload && store.users.findOne({ _id: payload.sub });
    // token เก่า (หลังเปลี่ยนรหัสผ่าน/บทบาท) และบัญชีที่ปิดใช้งานแล้วต้องใช้ไม่ได้ทันที
    if (!user || !isActive(user) || (payload.tv || 0) !== (user.tokenVersion || 0)) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ');
    return user; // ดึงจาก DB ทุกครั้ง เพื่อให้การเปลี่ยนสิทธิ์มีผลทันที
  }

  async function handleApi(req, res, url) {
    const apiPath = url.pathname.slice(API.length) || '/';
    let matched = null;
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(apiPath);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== req.method) continue;
      matched = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
      break;
    }
    if (!matched) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'ไม่รองรับ method นี้' : 'ไม่พบ endpoint');
    const { r, params } = matched;
    let user = null;
    if (r.roles) {
      user = authenticate(req);
      if (r.roles.length && !r.roles.includes(user.role)) throw new HttpError(403, 'ไม่มีสิทธิ์ใช้งานส่วนนี้');
    }
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : undefined;
    const out = await r.handler({ req, res, params, query: url.searchParams, body, user });
    if (out && out.handled) return;
    send(res, out.status || 200, out.body);
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method Not Allowed');
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      throw new HttpError(400, 'Bad Request');
    }
    if (rel === '/') rel = '/index.html';
    if (rel.includes('\0') || rel.includes(':')) throw new HttpError(400, 'Bad Request'); // กัน NUL และ stream สลับ (file::$DATA) บน Windows
    const file = path.join(PUBLIC_DIR, rel);
    if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Forbidden');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, { error: 'ไม่พบหน้าที่ต้องการ' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  // บันทึกการเข้าใช้เป็น JSON บรรทัดละคำขอ (เฉพาะเวลา/วิธี/พาธ/สถานะ/ms/IP ไม่บันทึก query, header หรือ token)
  const accessLog = options.accessLog ?? (options.quiet || process.env.LOG_REQUESTS === '0' ? null : (line) => console.log(line));

  const listener = async (req, res) => {
    if (accessLog && req.url !== '/healthz') {
      const t0 = process.hrtime.bigint();
      res.on('close', () => {
        accessLog(
          JSON.stringify({
            t: new Date().toISOString(),
            m: req.method,
            p: req.url.split('?')[0].slice(0, 200),
            s: res.statusCode,
            ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10,
            ip: clientIp(req),
          }),
        );
      });
    }
    // ตรวจสุขภาพ: ใช้กับ Docker/ตัวเฝ้าระบบ ไม่ต้องล็อกอิน ไม่เปิดเผยข้อมูลใด ๆ และแตะฐานข้อมูลจริงเพื่อให้รู้ว่าใช้งานได้
    if (req.url === '/healthz') {
      try {
        store.db.prepare('SELECT 1').get();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end('{"ok":true}');
      } catch {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end('{"ok":false}');
      }
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    if (options.hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === API || url.pathname.startsWith(`${API}/`)) await handleApi(req, res, url);
      else serveStatic(req, res, url);
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      send(res, 500, { error: 'เกิดข้อผิดพลาดภายในระบบ' });
    }
  };

  const server = options.tls ? https.createServer(options.tls, listener) : http.createServer(listener);
  server.on('close', () => {
    clearInterval(heartbeat);
    for (const c of clients) c.res.end();
    clients.clear();
    if (ownStore) store.close();
  });
  server.store = store;
  server.bootstrap = bootstrap; // ผู้จัดการคนแรกที่เพิ่งสร้าง (ถ้ามี) ใช้ในการทดสอบ
  /** ปิดอย่างสุภาพ: ตัดสตรีม real-time, รอคำขอที่ค้างอยู่ให้จบ แล้วปิดฐานข้อมูล (บังคับตัดเมื่อเกิน 3 วินาที) */
  server.shutdown = () =>
    new Promise((resolve) => {
      for (const c of clients) c.res.end();
      server.close(() => resolve());
      server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), 3000).unref();
    });
  return server;
}

/* ---------- เริ่มทำงานเมื่อรันตรง ๆ ---------- */
if (require.main === module) {
  require('./env').loadEnv(); // อ่าน .env (ค่าที่ตั้งไว้ในระบบมาก่อน)
  const port = Number(process.env.PORT) || 3000;
  let tls;
  if (process.env.TLS_KEY && process.env.TLS_CERT) {
    tls = { key: fs.readFileSync(process.env.TLS_KEY), cert: fs.readFileSync(process.env.TLS_CERT) };
  }
  const server = createServer({ tls, hsts: Boolean(tls) });
  const host = process.env.HOST || undefined; // เช่น HOST=127.0.0.1 เมื่อมี reverse proxy อยู่เครื่องเดียวกัน
  server.listen(port, host, () => {
    console.log(`IT Helpdesk รันที่ ${tls ? 'https' : 'http'}://${host || 'localhost'}:${port}`);
    if (!tls) console.log('หมายเหตุ: ใช้งานจริงต้องรันหลัง HTTPS (ตั้ง TLS_KEY/TLS_CERT หรือใช้ reverse proxy)');
  });
  let stopping = false;
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGBREAK']) { // SIGBREAK = Ctrl+Break / ปิดหน้าต่างคอนโซลบน Windows
    process.on(sig, async () => {
      if (stopping) return;
      stopping = true;
      console.log(`[stop] ได้รับ ${sig} กำลังปิดระบบ…`);
      await server.shutdown();
      process.exit(0);
    });
  }
}

module.exports = { createServer };
