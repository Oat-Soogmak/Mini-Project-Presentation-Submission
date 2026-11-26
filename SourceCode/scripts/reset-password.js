'use strict';
/**
 * รีเซ็ตรหัสผ่านโดยตรงที่ฐานข้อมูล สำหรับกรณีผู้ดูแลระบบลืมรหัส (คนอื่นรีเซ็ตให้ไม่ได้เพราะไม่มีผู้จัดการคนอื่น)
 *
 *   node scripts/reset-password.js <ชื่อผู้ใช้>             สุ่มรหัสผ่านใหม่แล้วพิมพ์ให้
 *   NEW_PASSWORD='...' node scripts/reset-password.js <ชื่อผู้ใช้>   กำหนดเอง (ยาว 8 ตัวขึ้นไป)
 *
 * ผลข้างเคียง: เปิดใช้งานบัญชีอีกครั้ง และบังคับให้ทุกอุปกรณ์ของบัญชีนั้นล็อกอินใหม่
 * ใน Docker:  docker compose exec app node scripts/reset-password.js admin
 */
const path = require('node:path');
const { Store } = require('../src/db');
const { hashPassword } = require('../src/auth');
const { randomPassword } = require('../src/seed');

require('../src/env').loadEnv();
const username = (process.argv[2] || '').trim().toLowerCase();
if (!username) {
  console.error('วิธีใช้: node scripts/reset-password.js <ชื่อผู้ใช้>');
  process.exit(1);
}
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const store = new Store(path.join(dataDir, 'helpdesk.db'));
try {
  const user = store.users.findOne({ username });
  if (!user) throw new Error(`ไม่พบผู้ใช้ "${username}"`);
  const given = process.env.NEW_PASSWORD;
  if (given !== undefined && (given.length < 8 || given.length > 128)) throw new Error('NEW_PASSWORD ต้องยาว 8-128 ตัวอักษร');
  const password = given || randomPassword();
  store.users.updateOne(user._id, { passwordHash: hashPassword(password), tokenVersion: (user.tokenVersion || 0) + 1, active: true });
  store.logs.insertOne({
    at: new Date().toISOString(),
    actorId: 'system',
    actorName: 'ผู้ดูแลเซิร์ฟเวอร์ (สคริปต์)',
    action: 'user.password_reset',
    ticketId: null,
    targetUserId: user._id,
    detail: { username, via: 'reset-password.js' },
  });
  console.log(`[reset] รีเซ็ตรหัสผ่านของ ${username} (${user.role}) แล้ว`);
  if (!given) console.log(`[reset] รหัสผ่านใหม่: ${password}`);
} catch (e) {
  console.error(`[reset] ล้มเหลว: ${e.message}`);
  process.exitCode = 1;
} finally {
  store.close();
}
