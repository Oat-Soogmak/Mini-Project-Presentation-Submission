'use strict';
/**
 * ชั้นข้อมูลแบบ SQLite (node:sqlite ในตัว Node 22+ ไม่ต้องติดตั้งแพ็กเกจ)
 *
 * คงอินเทอร์เฟซแบบ collection เดิมไว้ (insertOne / find / findOne / updateOne / deleteOne / nextTicketNo)
 * ทำให้ server.js และ seed.js ไม่ต้องแก้ แต่ข้างในเป็นตารางจริง มีดัชนี และ UNIQUE constraint
 * - find({ฟิลด์: ค่า}) แปลงเป็น SQL WHERE (ใช้ดัชนีได้)
 * - find(ฟังก์ชัน) โหลดแล้วกรองในหน่วยความจำ (ใช้กับเงื่อนไขซับซ้อนเท่านั้น)
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// type: 'text' | 'int' | 'bool' | 'json'   nullable: true = อนุญาต NULL
const col = (name, type = 'text', opts = {}) => ({ name, type, ...opts });

const SCHEMA = {
  users: {
    columns: [
      col('username', 'text', { unique: true }),
      col('name'),
      col('role'),
      col('passwordHash'),
      col('active', 'bool', { default: 1 }),
      col('tokenVersion', 'int', { default: 0 }),
      col('createdAt', 'text', { nullable: true }),
    ],
  },
  categories: {
    columns: [col('slug', 'text', { unique: true }), col('name')],
  },
  tickets: {
    columns: [
      col('no', 'int', { unique: true }),
      col('title'),
      col('description'),
      col('category'),
      col('priority'),
      col('status', 'text', { index: true }),
      col('images', 'json', { default: '[]' }),
      col('notes', 'json', { default: '[]' }),
      col('createdBy', 'text', { index: true }),
      col('createdByName'),
      col('assignedTo', 'text', { nullable: true, index: true }),
      col('assignedToName', 'text', { nullable: true }),
      col('createdAt'),
      col('updatedAt'),
      col('firstResponseAt', 'text', { nullable: true }),
      col('resolvedAt', 'text', { nullable: true }),
      // ผู้แจ้งภายนอก (ไม่มีบัญชี): ข้อมูลติดต่อ และแฮช SHA-256 ของรหัสติดตามสถานะ (ไม่เก็บรหัสจริง)
      col('guestContact', 'text', { nullable: true }),
      col('trackHash', 'text', { nullable: true }),
    ],
  },
  logs: {
    columns: [
      col('at'),
      col('actorId'),
      col('actorName'),
      col('action'),
      col('ticketId', 'text', { nullable: true, index: true }),
      col('targetUserId', 'text', { nullable: true }),
      col('detail', 'json', { default: '{}' }),
    ],
  },
};

const SQL_TYPE = { text: 'TEXT', int: 'INTEGER', bool: 'INTEGER', json: 'TEXT' };

const defaultSql = (c) => (c.default === undefined ? '' : ` DEFAULT ${typeof c.default === 'string' ? `'${c.default}'` : c.default}`);

/** คำสั่งสร้างตาราง (ก่อน migrate) และดัชนี (หลัง migrate เพราะดัชนีอาจอ้างคอลัมน์ที่เพิ่งเพิ่ม) */
function ddl() {
  const tables = [`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)`];
  const indexes = [];
  for (const [table, { columns }] of Object.entries(SCHEMA)) {
    const defs = columns.map((c) => {
      let d = `${c.name} ${SQL_TYPE[c.type]}`;
      if (!c.nullable) d += ' NOT NULL';
      if (c.unique) d += ' UNIQUE';
      return d + defaultSql(c);
    });
    tables.push(`CREATE TABLE IF NOT EXISTS ${table} (_id TEXT PRIMARY KEY, ${defs.join(', ')})`);
    for (const c of columns) if (c.index) indexes.push(`CREATE INDEX IF NOT EXISTS idx_${table}_${c.name} ON ${table}(${c.name})`);
  }
  indexes.push(`INSERT OR IGNORE INTO meta (key, value) VALUES ('ticketSeq', 0)`);
  return { tables, indexes };
}

/**
 * อัปเกรดฐานข้อมูลที่สร้างจากเวอร์ชันเก่า: เพิ่มคอลัมน์ที่ยังไม่มีโดยไม่กระทบข้อมูลเดิม
 * (คอลัมน์ใหม่ต้อง nullable หรือมี default และห้าม UNIQUE เพราะ SQLite ไม่รองรับ ADD COLUMN แบบนั้น)
 */
function migrate(db) {
  for (const [table, { columns }] of Object.entries(SCHEMA)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
    for (const c of columns) {
      if (have.has(c.name)) continue;
      if (c.unique || (!c.nullable && c.default === undefined))
        throw new Error(`เพิ่มคอลัมน์ ${table}.${c.name} ด้วย migration ไม่ได้ (ต้อง nullable หรือมี default และห้าม UNIQUE)`);
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${c.name} ${SQL_TYPE[c.type]}${c.nullable ? '' : ' NOT NULL'}${defaultSql(c)}`);
    }
  }
}

function toParam(c, v) {
  if (v === undefined || v === null) return null;
  if (c.type === 'bool') return v ? 1 : 0;
  if (c.type === 'json') return JSON.stringify(v);
  return v;
}

class Collection {
  constructor(store, table) {
    this.store = store;
    this.table = table;
    this.columns = SCHEMA[table].columns;
    this.byName = new Map([['_id', col('_id')], ...this.columns.map((c) => [c.name, c])]);
  }

  fromRow(row) {
    const doc = { _id: row._id };
    for (const c of this.columns) {
      const v = row[c.name];
      doc[c.name] = v === null ? null : c.type === 'bool' ? v === 1 : c.type === 'json' ? JSON.parse(v) : v;
    }
    return doc;
  }

  column(key) {
    const c = this.byName.get(key);
    if (!c) throw new Error(`ไม่รู้จักฟิลด์ "${key}" ในตาราง ${this.table}`); // ชื่อคอลัมน์ไม่เคยมาจากผู้ใช้ จึงไม่มี SQL injection
    return c;
  }

  insertOne(doc) {
    const row = { _id: crypto.randomUUID(), ...doc };
    for (const k of Object.keys(row)) this.column(k);
    const names = ['_id', ...this.columns.map((c) => c.name)];
    const values = names.map((n) => {
      const c = this.byName.get(n);
      const v = row[n];
      // ฟิลด์ที่ไม่ส่งมาใช้ค่า default ของตาราง
      if (v === undefined && c.default !== undefined) return toParam(c, c.type === 'json' ? JSON.parse(c.default) : c.default);
      return toParam(c, v);
    });
    this.store.db.prepare(`INSERT INTO ${this.table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...values);
    return this.findOne({ _id: row._id });
  }

  find(filter) {
    if (typeof filter === 'function') {
      return this.find().filter(filter);
    }
    const where = [];
    const params = [];
    for (const [k, v] of Object.entries(filter || {})) {
      const c = this.column(k);
      if (v === null || v === undefined) where.push(`${k} IS NULL`);
      else {
        where.push(`${k} = ?`);
        params.push(toParam(c, v));
      }
    }
    const sql = `SELECT * FROM ${this.table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid`;
    return this.store.db.prepare(sql).all(...params).map((r) => this.fromRow(r));
  }

  findOne(filter) {
    if (typeof filter === 'function') return this.find(filter)[0] || null;
    const where = [];
    const params = [];
    for (const [k, v] of Object.entries(filter || {})) {
      const c = this.column(k);
      if (v === null || v === undefined) where.push(`${k} IS NULL`);
      else {
        where.push(`${k} = ?`);
        params.push(toParam(c, v));
      }
    }
    const sql = `SELECT * FROM ${this.table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid LIMIT 1`;
    const row = this.store.db.prepare(sql).get(...params);
    return row ? this.fromRow(row) : null;
  }

  updateOne(id, patch) {
    const keys = Object.keys(patch).filter((k) => k !== '_id');
    if (keys.length) {
      const sets = keys.map((k) => `${this.column(k).name} = ?`);
      const values = keys.map((k) => toParam(this.byName.get(k), patch[k]));
      const res = this.store.db.prepare(`UPDATE ${this.table} SET ${sets.join(', ')} WHERE _id = ?`).run(...values, id);
      if (res.changes === 0) return null;
    }
    return this.findOne({ _id: id });
  }

  deleteOne(id) {
    return this.store.db.prepare(`DELETE FROM ${this.table} WHERE _id = ?`).run(id).changes > 0;
  }
}

class Store {
  /** @param {string|null} file พาธไฟล์ฐานข้อมูล SQLite (null = ในหน่วยความจำ ใช้ตอนทดสอบ) */
  constructor(file) {
    this.file = file || null;
    if (this.file) fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file || ':memory:');
    if (this.file) {
      this.db.exec('PRAGMA journal_mode = WAL'); // อ่าน/เขียนพร้อมกันได้ และทนต่อไฟดับ
      this.db.exec('PRAGMA synchronous = NORMAL');
    }
    this.db.exec('PRAGMA busy_timeout = 5000');
    const { tables, indexes } = ddl();
    for (const sql of tables) this.db.exec(sql);
    migrate(this.db);
    for (const sql of indexes) this.db.exec(sql);
    for (const table of Object.keys(SCHEMA)) this[table] = new Collection(this, table);
  }

  /** เลขตั๋วถัดไป (เพิ่มและอ่านในคำสั่งเดียว จึงไม่ซ้ำแม้เรียกพร้อมกัน) */
  nextTicketNo() {
    return this.db.prepare(`UPDATE meta SET value = value + 1 WHERE key = 'ticketSeq' RETURNING value`).get().value;
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** นำเข้าข้อมูลจากไฟล์ JSON ของเวอร์ชันก่อนหน้า (data/db.json) คืนจำนวนแถวที่นำเข้า */
  importLegacyJson(file) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    let count = 0;
    this.transaction(() => {
      for (const table of ['users', 'categories', 'tickets', 'logs']) {
        const cols = new Set(['_id', ...SCHEMA[table].columns.map((c) => c.name)]);
        for (const doc of data[table] || []) {
          const clean = Object.fromEntries(Object.entries(doc).filter(([k]) => cols.has(k)));
          const names = Object.keys(clean);
          const values = names.map((n) => toParam(this[table].byName.get(n), clean[n]));
          // ฟิลด์ที่ไฟล์เก่าไม่มี (เช่น active, tokenVersion) ใช้ค่า default ของตาราง
          this.db.prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...values);
          count += 1;
        }
      }
      const seq = Number(data.meta && data.meta.ticketSeq) || 0;
      this.db.prepare(`UPDATE meta SET value = MAX(value, ?) WHERE key = 'ticketSeq'`).run(seq);
    });
    return count;
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* ปิดไปแล้ว */
    }
  }
}

module.exports = { Store };
