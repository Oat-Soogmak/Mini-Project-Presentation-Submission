'use strict';
/**
 * อ่านไฟล์ .env เข้า process.env โดยไม่พึ่งแพ็กเกจ (ใช้กับ Windows/การรันตรงที่ไม่มี Docker ช่วยส่งค่าให้)
 * - รองรับไฟล์ที่บันทึกจาก Notepad: BOM (UTF-8) และบรรทัดจบแบบ CRLF
 * - รองรับ  KEY=value  /  KEY="value"  /  KEY='value'  / บรรทัดที่ขึ้นต้นด้วย # / "export KEY=value"
 * - ไม่ทับตัวแปรที่ถูกตั้งไว้แล้วในสภาพแวดล้อม (ค่าจริงของระบบมาก่อนไฟล์)
 */
const fs = require('node:fs');
const path = require('node:path');

function parse(text) {
  const out = {};
  const src = String(text).replace(/^﻿/, '');
  for (const rawLine of src.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    const q = value[0];
    if ((q === '"' || q === "'") && value.lastIndexOf(q) > 0) {
      value = value.slice(1, value.lastIndexOf(q)); // ในเครื่องหมายคำพูด เก็บ # ไว้ตามเดิม
    } else {
      value = value.replace(/\s+#.*$/, '').trim(); // ตัดคอมเมนต์ท้ายบรรทัด (ต้องมีช่องว่างนำหน้า #)
    }
    out[m[1]] = value;
  }
  return out;
}

/** โหลด .env จากรากโปรเจกต์ (หรือ ENV_FILE) คืนรายชื่อตัวแปรที่ตั้งเพิ่ม */
function loadEnv(file) {
  const target = file || process.env.ENV_FILE || path.join(__dirname, '..', '.env');
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const set = [];
  for (const [k, v] of Object.entries(parse(text))) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
      set.push(k);
    }
  }
  return set;
}

module.exports = { loadEnv, parse };
