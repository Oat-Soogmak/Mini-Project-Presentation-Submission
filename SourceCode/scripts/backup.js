'use strict';
/**
 * สำรองฐานข้อมูลแบบสอดคล้องกัน (VACUUM INTO) ขณะระบบกำลังทำงานอยู่ได้ ไม่ต้องหยุดเซิร์ฟเวอร์
 * ผลลัพธ์: BACKUP_DIR/helpdesk-<เวลา UTC>.db.gz แล้วลบไฟล์เก่าเหลือ BACKUP_KEEP ไฟล์ล่าสุด
 *
 *   DATA_DIR      โฟลเดอร์ข้อมูล (ค่าเริ่มต้น ./data)
 *   BACKUP_DIR    โฟลเดอร์เก็บไฟล์สำรอง (ค่าเริ่มต้น $DATA_DIR/backups)
 *   BACKUP_KEEP   จำนวนไฟล์ที่เก็บ (ค่าเริ่มต้น 14)
 *
 * ข้อควรจำ: ไฟล์สำรองที่อยู่เครื่องเดียวกับระบบไม่ช่วยถ้าเครื่องเสีย ต้องคัดลอกออกไปไว้ที่อื่นด้วย
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { DatabaseSync } = require('node:sqlite');

async function main() {
  require('../src/env').loadEnv();
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const backupDir = process.env.BACKUP_DIR || path.join(dataDir, 'backups');
  const keep = Math.max(1, Number(process.env.BACKUP_KEEP) || 14);
  const src = path.join(dataDir, 'helpdesk.db');
  if (!fs.existsSync(src)) throw new Error(`ไม่พบฐานข้อมูลที่ ${src}`);
  fs.mkdirSync(backupDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmp = path.join(backupDir, `.tmp-${stamp}.db`);
  const out = path.join(backupDir, `helpdesk-${stamp}.db.gz`);
  try {
    const db = new DatabaseSync(src);
    db.exec('PRAGMA busy_timeout = 10000');
    db.prepare('VACUUM INTO ?').run(tmp);
    db.close();

    // ตรวจว่าไฟล์สำรองอ่านได้และไม่เสียหายก่อนนับว่าสำเร็จ
    const check = new DatabaseSync(tmp);
    const verdict = check.prepare('PRAGMA integrity_check').get().integrity_check;
    const users = check.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const tickets = check.prepare('SELECT COUNT(*) AS n FROM tickets').get().n;
    check.close();
    if (verdict !== 'ok') throw new Error(`ไฟล์สำรองไม่ผ่านการตรวจความสมบูรณ์: ${verdict}`);

    await pipeline(fs.createReadStream(tmp), zlib.createGzip({ level: 9 }), fs.createWriteStream(out, { mode: 0o600 }));
    console.log(`[backup] สำเร็จ: ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB, ผู้ใช้ ${users}, ตั๋ว ${tickets})`);
  } catch (e) {
    fs.rmSync(out, { force: true }); // ไม่ทิ้งไฟล์ที่เขียนไม่จบไว้ให้ถูกเข้าใจผิดว่าใช้ได้
    throw e;
  } finally {
    fs.rmSync(tmp, { force: true });
  }

  const files = fs.readdirSync(backupDir).filter((f) => /^helpdesk-.*\.db\.gz$/.test(f)).sort(); // ชื่อมีเวลา ISO จึงเรียงตามเวลาได้
  for (const old of files.slice(0, Math.max(0, files.length - keep))) {
    fs.rmSync(path.join(backupDir, old));
    console.log(`[backup] ลบไฟล์เก่า ${old}`);
  }
}

main().catch((e) => {
  console.error(`[backup] ล้มเหลว: ${e.message}`);
  process.exit(1);
});
