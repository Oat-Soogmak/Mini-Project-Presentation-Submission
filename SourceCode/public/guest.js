/* หน้าสาธารณะ (ไม่ต้องล็อกอิน): แจ้งซ่อม (report.html) และติดตามสถานะ (track.html) */
(() => {
  'use strict';

  const API = '/api/v1';
  const STATUS_LABEL = { open: 'รอรับเรื่อง', in_progress: 'กำลังดำเนินการ', resolved: 'เสร็จสิ้น' };
  const STATUS_PCT = { open: 33, in_progress: 66, resolved: 100 };
  const STATUS_MSG = {
    open: 'ฝ่าย IT ได้รับเรื่องของคุณแล้ว กำลังรอช่างรับงาน',
    in_progress: 'ช่างกำลังดำเนินการแก้ไข',
    resolved: 'แก้ไขเสร็จสิ้นแล้ว หากยังพบปัญหา กรุณาแจ้งซ่อมใหม่อีกครั้ง',
  };
  const PRIORITY_LABEL = { low: 'ต่ำ', medium: 'ปานกลาง', high: 'เร่งด่วน' };
  const MAX_IMAGES = 3;
  const MAX_IMAGE_BYTES = 1.3 * 1024 * 1024;
  const SAVED_KEY = 'helpdesk.myReports';
  const POLL_MS = 10000;

  const page = document.body.dataset.page;
  const root = document.getElementById('root');
  const $toasts = document.getElementById('toasts');

  /* ---------- helpers ---------- */
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === undefined || c === null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }
  const fmtTime = (iso) => new Date(iso).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
  const ticketNo = (n) => `#${String(n).padStart(4, '0')}`;
  const trackUrl = (no, token) => `${location.origin}/track.html#no=${no}&t=${encodeURIComponent(token)}`;

  function toast(text, isError = false) {
    const t = el('div', { class: `toast${isError ? ' err' : ''}`, role: isError ? 'alert' : 'status', text });
    $toasts.append(t);
    setTimeout(() => t.remove(), 4000);
  }

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(API + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(json.error || `เกิดข้อผิดพลาด (${res.status})`);
      e.status = res.status;
      throw e;
    }
    return json;
  }

  // รายการที่เคยแจ้งจากเครื่องนี้ (เก็บในเบราว์เซอร์เครื่องนี้เท่านั้น ไม่ขึ้นเซิร์ฟเวอร์) ใช้ try/catch เพราะบางโหมดปิด storage
  function loadSaved() {
    try {
      const v = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }
  function saveReport(r) {
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify([r, ...loadSaved().filter((x) => x.no !== r.no)].slice(0, 20)));
    } catch {
      /* ไม่เป็นไร: ผู้ใช้ยังมีลิงก์ติดตามจากหน้าสำเร็จ */
    }
  }
  function clearSaved() {
    try {
      localStorage.removeItem(SAVED_KEY);
    } catch {
      /* ignore */
    }
  }

  function savedPanel() {
    const list = loadSaved();
    if (!list.length) return null;
    const box = el('section', { class: 'panel saved' });
    box.append(
      el('div', { class: 'panel-head' }, el('h2', { text: 'เรื่องที่เคยแจ้งจากเครื่องนี้' }), el('button', {
        class: 'btn small',
        type: 'button',
        text: 'ล้างรายการ',
        on: { click: () => { clearSaved(); box.remove(); } },
      })),
      el('ul', { class: 'history' }, list.map((r) => el('li', {}, el('a', { href: trackUrl(r.no, r.token), text: `${ticketNo(r.no)} ${r.title}` })))),
      el('p', { class: 'hint', text: 'รายการนี้เก็บในเบราว์เซอร์เครื่องนี้เท่านั้น ถ้าใช้เครื่องสาธารณะ ควรกด “ล้างรายการ” ก่อนออก' }),
    );
    return box;
  }

  /* ---------- หน้าแจ้งซ่อม ---------- */
  async function initReport() {
    let cfg;
    let cats;
    try {
      cfg = await api('/public/config');
      cats = (await api('/public/categories')).data;
    } catch (e) {
      root.append(el('section', { class: 'panel' }, el('h2', { text: 'โหลดหน้านี้ไม่สำเร็จ' }), el('p', { text: e.message })));
      return;
    }
    if (!cfg.guestEnabled) {
      root.append(
        el('section', { class: 'panel' }, el('h2', { text: 'ปิดรับแจ้งซ่อมแบบไม่ต้องเข้าสู่ระบบ' }), el('p', {}, 'กรุณา ', el('a', { href: '/', text: 'เข้าสู่ระบบ' }), ' หรือติดต่อฝ่าย IT โดยตรง')),
      );
      return;
    }
    renderForm(cats);
  }

  function renderForm(cats) {
    root.replaceChildren();
    const name = el('input', { type: 'text', name: 'name', maxlength: '80', required: true, autocomplete: 'name' });
    const contact = el('input', { type: 'text', name: 'contact', maxlength: '100', required: true, autocomplete: 'off', placeholder: 'เบอร์โทร / อีเมล / LINE ID' });
    const category = el('select', { name: 'category' }, cats.map((c) => el('option', { value: c.slug, text: c.name })));
    const priority = el('select', { name: 'priority' }, ['medium', 'high', 'low'].map((p) => el('option', { value: p, text: PRIORITY_LABEL[p] })));
    const title = el('input', { type: 'text', name: 'title', maxlength: '120', required: true });
    const desc = el('textarea', { name: 'description', maxlength: '2000', required: true, placeholder: 'อธิบายอาการ เช่น เกิดขึ้นเมื่อไหร่ ที่ไหน ทำอะไรอยู่' });
    // honeypot: คนมองไม่เห็นและโฟกัสไม่ได้ แต่บอตมักกรอกทุกช่อง
    const trap = el('input', { type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
    const previews = el('div', { class: 'previews' });
    let images = [];
    const file = el('input', {
      type: 'file',
      accept: 'image/png,image/jpeg,image/webp,image/gif',
      multiple: true,
      on: {
        change: async () => {
          images = [];
          previews.replaceChildren();
          if (file.files.length > MAX_IMAGES) toast(`แนบได้สูงสุด ${MAX_IMAGES} รูป`, true);
          for (const f of [...file.files].slice(0, MAX_IMAGES)) {
            if (f.size > MAX_IMAGE_BYTES) { toast(`${f.name} ใหญ่เกิน 1.3 MB`, true); continue; }
            const url = await new Promise((resolve, reject) => {
              const r = new FileReader();
              r.onload = () => resolve(r.result);
              r.onerror = reject;
              r.readAsDataURL(f);
            });
            images.push(url);
            previews.append(el('img', { src: url, alt: f.name }));
          }
        },
      },
    });
    const err = el('div', { class: 'error', role: 'alert' });
    const submit = el('button', { class: 'btn primary', type: 'submit', text: 'ส่งเรื่องแจ้งซ่อม' });
    const form = el(
      'form',
      {
        class: 'form-grid',
        on: {
          submit: async (e) => {
            e.preventDefault();
            err.textContent = '';
            submit.disabled = true;
            try {
              const body = {
                name: name.value, contact: contact.value, category: category.value, priority: priority.value,
                title: title.value, description: desc.value, images, website: trap.value,
              };
              const out = await api('/public/tickets', { method: 'POST', body });
              saveReport({ no: out.no, token: out.trackToken, title: title.value.trim() });
              renderSuccess(out, cats);
            } catch (ex) {
              err.textContent = ex.message;
              submit.disabled = false;
            }
          },
        },
      },
      el('label', {}, 'ชื่อ-นามสกุล', name),
      el('label', {}, 'ช่องทางติดต่อกลับ', contact),
      el('label', { class: 'full' }, 'หัวข้อ', title),
      el('label', {}, 'หมวดหมู่', category),
      el('label', {}, 'ความเร่งด่วน', priority),
      el('label', { class: 'full' }, 'รายละเอียดอาการ', desc),
      el('label', { class: 'full' }, `แนบรูปอาการเสีย (ไม่เกิน ${MAX_IMAGES} รูป)`, file, previews),
      el('div', { class: 'hp', 'aria-hidden': 'true' }, el('label', {}, 'อย่ากรอกช่องนี้', trap)),
      el('div', { class: 'full' }, err, submit),
    );
    root.append(
      el(
        'section',
        { class: 'panel' },
        el('h2', { text: 'แจ้งซ่อมอุปกรณ์ไอที' }),
        el('p', { class: 'hint', text: 'ไม่ต้องสมัครสมาชิก กรอกข้อมูลแล้วส่งได้เลย ระบบจะให้ลิงก์สำหรับติดตามสถานะการซ่อม ข้อมูลติดต่อของคุณมีเฉพาะฝ่าย IT เท่านั้นที่เห็น' }),
        form,
      ),
    );
    const saved = savedPanel();
    if (saved) root.append(saved);
    name.focus();
  }

  function renderSuccess(out, cats) {
    root.replaceChildren();
    const url = trackUrl(out.no, out.trackToken);
    const box = el('input', { type: 'text', readonly: true, value: url, 'aria-label': 'ลิงก์ติดตามสถานะ' });
    const copy = el('button', {
      class: 'btn',
      type: 'button',
      text: 'คัดลอกลิงก์',
      on: {
        click: async () => {
          try {
            await navigator.clipboard.writeText(url);
          } catch {
            box.select();
            document.execCommand('copy');
          }
          toast('คัดลอกลิงก์แล้ว');
        },
      },
    });
    root.append(
      el(
        'section',
        { class: 'panel success' },
        el('h2', { text: `ส่งเรื่องแจ้งซ่อมแล้ว ${ticketNo(out.no)}` }),
        el('p', { text: 'ฝ่าย IT ได้รับเรื่องของคุณแล้ว ใช้ลิงก์ด้านล่างเพื่อติดตามสถานะการซ่อมได้ตลอดเวลา' }),
        el('div', { class: 'linkbox' }, box, copy),
        el('p', { class: 'notice', text: 'โปรดเก็บลิงก์นี้ไว้ (บันทึกบุ๊กมาร์กหรือคัดลอกไปเก็บ) ลิงก์นี้เป็นเพียงวิธีเดียวที่จะดูสถานะเรื่องนี้ ระบบไม่สามารถกู้คืนให้ได้ถ้าหาย' }),
        el(
          'div',
          { class: 'actions' },
          el('a', { class: 'btn primary', href: url, text: 'ดูสถานะตอนนี้' }),
          el('button', { class: 'btn', type: 'button', text: 'แจ้งเรื่องอื่นเพิ่ม', on: { click: () => renderForm(cats) } }),
        ),
      ),
    );
    box.select();
  }

  /* ---------- หน้าติดตามสถานะ ---------- */
  let pollTimer = null;

  function initTrack() {
    const params = new URLSearchParams(location.hash.slice(1));
    const no = Number(params.get('no'));
    const token = params.get('t');
    if (Number.isInteger(no) && no > 0 && token) startTracking(no, token);
    else showLookup();
  }

  function showLookup(message) {
    clearInterval(pollTimer);
    root.replaceChildren();
    const no = el('input', { type: 'text', inputmode: 'numeric', name: 'no', required: true, placeholder: 'เช่น 5' });
    const token = el('input', { type: 'text', name: 'token', required: true, autocomplete: 'off', placeholder: 'รหัสในลิงก์ติดตาม' });
    const err = el('div', { class: 'error', role: 'alert', text: message || '' });
    root.append(
      el(
        'section',
        { class: 'panel' },
        el('h2', { text: 'ติดตามสถานะแจ้งซ่อม' }),
        el('p', { class: 'hint', text: 'เปิดลิงก์ติดตามที่ได้รับหลังแจ้งซ่อม หรือกรอกเลขตั๋วและรหัสติดตามด้านล่าง' }),
        el(
          'form',
          {
            class: 'form-grid',
            on: {
              submit: (e) => {
                e.preventDefault();
                const n = Number(no.value.replace('#', '').trim());
                if (!Number.isInteger(n) || n < 1) { err.textContent = 'เลขตั๋วไม่ถูกต้อง'; return; }
                location.hash = `no=${n}&t=${encodeURIComponent(token.value.trim())}`;
                startTracking(n, token.value.trim());
              },
            },
          },
          el('label', {}, 'เลขตั๋ว', no),
          el('label', {}, 'รหัสติดตาม', token),
          el('div', { class: 'full' }, err, el('button', { class: 'btn primary', type: 'submit', text: 'ดูสถานะ' })),
        ),
      ),
    );
    const saved = savedPanel();
    if (saved) root.append(saved);
    no.focus();
  }

  function buildTrackView() {
    const r = {
      no: el('span', { class: 't-no' }),
      title: el('span', { class: 't-title' }),
      prio: el('span', { class: 'badge' }),
      cat: el('span', { class: 'badge' }),
      msg: el('p', { class: 'notice' }),
      meta: el('div', { class: 't-meta' }),
      desc: el('p', { class: 't-desc' }),
      fill: el('div', { class: 'fill' }),
      steps: el('div', { class: 'steps' }, Object.entries(STATUS_LABEL).map(([s, label]) => el('span', { 'data-s': s, text: label }))),
      notes: el('ul', { class: 'history' }),
      notesWrap: el('div', { class: 'detail' }),
      conn: el('p', { class: 'hint' }),
    };
    r.bar = el('div', { class: 'track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, r.fill);
    r.notesWrap.append(el('b', { text: 'ความคืบหน้าจากช่าง' }), r.notes);
    const card = el(
      'section',
      { class: 'panel' },
      el('div', { class: 't-head' }, r.no, r.title, r.prio, r.cat),
      r.meta,
      r.msg,
      r.desc,
      el('div', { class: 'progress' }, r.bar, r.steps),
      r.notesWrap,
      r.conn,
      el('p', { class: 'hint', text: 'หน้านี้อัปเดตอัตโนมัติ ไม่ต้องรีเฟรช' }),
    );
    r.update = (t) => {
      document.title = `${ticketNo(t.no)} ${STATUS_LABEL[t.status]} – IT Helpdesk`;
      r.no.textContent = ticketNo(t.no);
      r.title.textContent = t.title;
      r.prio.textContent = PRIORITY_LABEL[t.priority];
      r.prio.classList.toggle('high', t.priority === 'high');
      r.cat.textContent = t.categoryName;
      const parts = [`แจ้งเมื่อ ${fmtTime(t.createdAt)}`, `ผู้รับผิดชอบ: ${t.assignedToName || 'ยังไม่มอบหมาย'}`];
      if (t.assignedToName && t.firstResponseAt) parts.push(`รับเรื่องเมื่อ ${fmtTime(t.firstResponseAt)}`);
      if (t.resolvedAt) parts.push(`เสร็จเมื่อ ${fmtTime(t.resolvedAt)}`);
      r.meta.textContent = parts.join(' · ');
      r.msg.textContent = STATUS_MSG[t.status];
      r.desc.textContent = t.description;
      r.fill.className = `fill ${t.status}`;
      r.fill.style.width = `${STATUS_PCT[t.status]}%`;
      r.bar.setAttribute('aria-valuenow', String(STATUS_PCT[t.status]));
      r.bar.setAttribute('aria-valuetext', STATUS_LABEL[t.status]);
      r.steps.querySelectorAll('span').forEach((s) => s.classList.toggle('cur', s.dataset.s === t.status));
      r.notesWrap.hidden = t.notes.length === 0;
      r.notes.replaceChildren(...t.notes.map((n) => el('li', { text: `${fmtTime(n.at)} · ${n.byName}: ${n.text}` })));
      r.conn.textContent = '';
    };
    return { card, r };
  }

  function startTracking(no, token) {
    clearInterval(pollTimer);
    root.replaceChildren();
    const { card, r } = buildTrackView();
    let shown = false;

    async function refresh() {
      try {
        const out = await api('/public/track', { method: 'POST', body: { no, token } });
        if (!shown) { root.replaceChildren(card); shown = true; }
        r.update(out.ticket);
      } catch (e) {
        if (!shown) return showLookup(e.status === 404 || e.status === 400 ? 'ไม่พบตั๋ว หรือรหัสติดตามไม่ถูกต้อง กรุณาตรวจสอบลิงก์อีกครั้ง' : e.message);
        r.conn.textContent = 'เชื่อมต่อไม่ได้ชั่วคราว กำลังลองใหม่อัตโนมัติ…'; // คงข้อมูลล่าสุดไว้
      }
    }
    refresh();
    pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  }

  window.addEventListener('hashchange', () => {
    if (page === 'track') initTrack();
  });

  if (page === 'report') initReport();
  else if (page === 'track') initTrack();
})();
