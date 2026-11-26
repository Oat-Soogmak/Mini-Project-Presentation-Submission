'use strict';
/**
 * ข้อมูลตั้งต้นตอนฐานข้อมูลยังว่าง
 *  - โหมดปกติ (ค่าเริ่มต้น): สร้างหมวดหมู่ + ผู้จัดการคนแรก 1 บัญชี ไม่มีบัญชีหรือตั๋วตัวอย่าง
 *  - โหมดสาธิต (DEMO=1): สร้างบัญชีและตั๋วตัวอย่าง ใช้รหัสผ่านที่เปิดเผยต่อสาธารณะ ห้ามใช้กับระบบจริง
 */
const crypto = require('node:crypto');
const { hashPassword, verifyPassword } = require('./auth');

const DEMO_PASSWORD = 'password123';
const MIN_PASSWORD = 8;

const CATEGORIES = [
  ['hardware', 'ฮาร์ดแวร์ (คอมพิวเตอร์/เครื่องพิมพ์)'],
  ['software', 'ซอฟต์แวร์/โปรแกรม'],
  ['network', 'เครือข่าย/อินเทอร์เน็ต'],
  ['account', 'บัญชีผู้ใช้/รหัสผ่าน'],
  ['other', 'อื่น ๆ'],
];

const newUser = (u, password) => ({
  ...u,
  passwordHash: hashPassword(password),
  active: true,
  tokenVersion: 0,
  createdAt: new Date().toISOString(),
});

/** รหัสผ่านสุ่ม 16 ตัวอักษร ตัดตัวที่สับสนง่าย (0/O, 1/l/I) */
function randomPassword() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from({ length: 16 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
}

/**
 * @param {object} store
 * @param {{demo?: boolean, initialManager?: {username?: string, password?: string}}} [opts]
 * @returns {{username: string, password: string, generated: boolean} | null} ข้อมูลผู้จัดการที่เพิ่งสร้าง (ถ้ามี)
 */
function seed(store, opts = {}) {
  if (store.categories.find().length === 0) {
    for (const [slug, name] of CATEGORIES) store.categories.insertOne({ slug, name });
  }
  if (store.users.find().length > 0) return null;

  if (opts.demo) {
    seedDemo(store);
    return null;
  }

  const username = ((opts.initialManager && opts.initialManager.username) || 'admin').trim().toLowerCase();
  let password = opts.initialManager && opts.initialManager.password;
  const generated = !password;
  if (generated) password = randomPassword();
  else if (password.length < MIN_PASSWORD) throw new Error(`INITIAL_MANAGER_PASSWORD ต้องยาวอย่างน้อย ${MIN_PASSWORD} ตัวอักษร`);
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) throw new Error('INITIAL_MANAGER_USERNAME ใช้ได้เฉพาะ a-z 0-9 . _ - ยาว 3-32 ตัวอักษร');

  store.users.insertOne(newUser({ username, name: 'ผู้ดูแลระบบ', role: 'manager' }, password));
  return { username, password, generated };
}

function seedDemo(store) {
  const users = [
    { username: 'somchai', name: 'สมชาย ใจดี', role: 'employee' },
    { username: 'suda', name: 'สุดา รักงาน', role: 'employee' },
    { username: 'tech1', name: 'ช่างวิทย์ ซ่อมเก่ง', role: 'it_support' },
    { username: 'tech2', name: 'ช่างนิด แก้ไว', role: 'it_support' },
    { username: 'manager', name: 'ผู้จัดการ ภาพรวม', role: 'manager' },
  ];
  const created = {};
  for (const u of users) created[u.username] = store.users.insertOne(newUser(u, DEMO_PASSWORD));

  const now = Date.now();
  const mk = (owner, title, description, category, priority, minsAgo) => {
    const at = new Date(now - minsAgo * 60000).toISOString();
    return store.tickets.insertOne({
      no: store.nextTicketNo(),
      title,
      description,
      category,
      priority,
      status: 'open',
      images: [],
      notes: [],
      createdBy: owner._id,
      createdByName: owner.name,
      assignedTo: null,
      assignedToName: null,
      createdAt: at,
      updatedAt: at,
      firstResponseAt: null,
      resolvedAt: null,
    });
  };
  mk(created.somchai, 'เครื่องพิมพ์ชั้น 2 กระดาษติด', 'กระดาษติดในถาด 2 ดึงออกไม่ได้', 'hardware', 'medium', 45);
  mk(created.suda, 'เชื่อมต่อ Wi-Fi ไม่ได้', 'ใช้งาน Wi-Fi ห้องประชุม B ไม่ได้ตั้งแต่เช้า', 'network', 'high', 20);
}

/** ชื่อผู้ใช้ที่ยังใช้รหัสผ่านสาธิตอยู่ (ใช้เตือนตอนเริ่มระบบที่ไม่ได้เปิดโหมดสาธิต เช่น ฐานข้อมูลเก่าจากเวอร์ชันก่อน) */
function usersWithDemoPassword(store) {
  return store.users.find((u) => u.active !== false && verifyPassword(DEMO_PASSWORD, u.passwordHash)).map((u) => u.username);
}

module.exports = { seed, usersWithDemoPassword, randomPassword, DEMO_PASSWORD };
