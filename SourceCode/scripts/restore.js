'use strict';
/**
 * กู้คืนฐานข้อมูลจากไฟล์สำรอง:  node scripts/restore.js <ไฟล์.db.gz>
 *
 * ต้อง "หยุดเซิร์ฟเวอร์ก่อน" (docker compose stop app) แล้วค่อยกู้คืน มิฉะนั้นระบบที่ทำงานอยู่จะยังถือไฟล์เก่าไว้
 * ฐานข้อมูลปัจจุบันไม่ถูกลบ: ย้ายไปไว้ที่ DATA_DIR/pre-restore-<เวลา>/ เผื่อกู้คืนผิดไฟล์
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { DatabaseSync } = require('node:sqlite');

async function main() {
  require('../src/env').loadEnv();
  const file = process.argv[2];
  if (!file) throw new Error('วิธีใช้: node scripts/restore.js <ไฟล์สำรอง .db.gz>');
  if (!fs.existsSync(file)) throw new Error(`ไม่พบไฟล์ ${file}`);
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const live = path.join(dataDir, 'helpdesk.db');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmp = path.join(dataDir, `.restore-${stamp}.db`);

  try {
    await pipeline(fs.createReadStream(file), zlib.createGunzip(), fs.createWriteStream(tmp, { mode: 0o600 }));
    const check = new DatabaseSync(tmp);
    const verdict = check.prepare('PRAGMA integrity_check').get().integrity_check;
    const users = check.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const tickets = check.prepare('SELECT COUNT(*) AS n FROM tickets').get().n;
    check.close();
    if (verdict !== 'ok') throw new Error(`ไฟล์สำรองเสียหาย: ${verdict} (ไม่แตะฐานข้อมูลปัจจุบัน)`);

    const existing = ['', '-wal', '-shm'].map((s) => live + s).filter((p) => fs.existsSync(p));
    if (existing.length) {
      const keepDir = path.join(dataDir, `pre-restore-${stamp}`);
      fs.mkdirSync(keepDir);
      for (const p of existing) fs.renameSync(p, path.join(keepDir, path.basename(p)));
      console.log(`[restore] เก็บฐานข้อมูลเดิมไว้ที่ ${keepDir}`);
    }
    fs.renameSync(tmp, live);
    console.log(`[restore] กู้คืนสำเร็จ (ผู้ใช้ ${users}, ตั๋ว ${tickets}) กรุณาเริ่มเซิร์ฟเวอร์ใหม่`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

main().catch((e) => {
  console.error(`[restore] ล้มเหลว: ${e.message}`);
  process.exit(1);
});
