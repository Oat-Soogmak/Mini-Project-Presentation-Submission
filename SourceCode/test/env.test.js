'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parse, loadEnv } = require('../src/env');

test('parse: BOM, CRLF, คำพูด, คอมเมนต์, export', () => {
  const text = '﻿# หัวข้อ\r\nPORT=8080\r\nA = "x # y"\r\nB=\'q\'\r\nC=val # note\r\nexport D=4\r\n\r\nE=\r\nbad line\r\nF=a#b\r\n';
  assert.deepStrictEqual(parse(text), { PORT: '8080', A: 'x # y', B: 'q', C: 'val', D: '4', E: '', F: 'a#b' });
});

test('loadEnv: ไม่ทับค่าที่ตั้งไว้แล้ว และไม่พังเมื่อไม่มีไฟล์', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-'));
  const f = path.join(dir, '.env');
  fs.writeFileSync(f, 'ZZ_ENV_A=1\r\nZZ_ENV_B=2\r\n');
  process.env.ZZ_ENV_B = 'keep';
  try {
    assert.deepStrictEqual(loadEnv(f), ['ZZ_ENV_A']);
    assert.strictEqual(process.env.ZZ_ENV_A, '1');
    assert.strictEqual(process.env.ZZ_ENV_B, 'keep');
    assert.deepStrictEqual(loadEnv(path.join(dir, 'nope')), []);
  } finally {
    delete process.env.ZZ_ENV_A;
    delete process.env.ZZ_ENV_B;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
