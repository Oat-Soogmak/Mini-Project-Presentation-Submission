(() => {
  'use strict';

  const API = '/api/v1';
  const STATUS_LABEL = { open: 'รอรับเรื่อง', in_progress: 'กำลังดำเนินการ', resolved: 'เสร็จสิ้น' };
  const STATUS_PCT = { open: 33, in_progress: 66, resolved: 100 };
  const PRIORITY_LABEL = { low: 'ต่ำ', medium: 'ปานกลาง', high: 'เร่งด่วน' };
  const ROLE_LABEL = { employee: 'พนักงาน', it_support: 'ช่าง IT', manager: 'ผู้ดูแลระบบ/ผู้จัดการ' };
  const MAX_IMAGES = 3;
  const MAX_IMAGE_BYTES = 1.3 * 1024 * 1024;

  const state = {
    token: sessionStorage.getItem('token'),
    me: null,
    tickets: new Map(),
    cards: new Map(),
    techs: [],
    categories: new Map(),
    filter: 'all',
    expanded: new Set(),
    events: null, // AbortController ของ SSE
    statsTimer: null,
  };

  const $app = document.getElementById('app');
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
  const ticketNo = (t) => `#${String(t.no).padStart(4, '0')}`;
  function fmtDur(min) {
    if (min === null || min === undefined) return '–';
    if (min < 60) return `${Math.round(min)} นาที`;
    if (min < 60 * 48) return `${(min / 60).toFixed(1)} ชม.`;
    return `${(min / 1440).toFixed(1)} วัน`;
  }

  function toast(text, isError = false) {
    const t = el('div', { class: `toast${isError ? ' err' : ''}`, role: isError ? 'alert' : 'status', text });
    $toasts.append(t);
    setTimeout(() => t.remove(), 4000);
  }

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(API + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/auth/login') {
      logout('เซสชันหมดอายุ หรือสิทธิ์ของบัญชีมีการเปลี่ยนแปลง กรุณาเข้าสู่ระบบใหม่');
      throw new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
    }
    if (!res.ok) throw new Error(json.error || `เกิดข้อผิดพลาด (${res.status})`);
    return json;
  }

  async function run(btn, fn) {
    if (btn) btn.disabled = true;
    try {
      await fn();
    } catch (e) {
      toast(e.message, true);
    } finally {
      if (btn && btn.isConnected) btn.disabled = false;
    }
  }

  /* ---------- login ---------- */
  function showLogin(message) {
    stopEvents();
    $app.replaceChildren();
    const err = el('div', { class: 'error', role: 'alert', text: message || '' });
    const user = el('input', { type: 'text', id: 'username', autocomplete: 'username', required: true });
    const pass = el('input', { type: 'password', id: 'password', autocomplete: 'current-password', required: true });
    const submit = el('button', { class: 'btn primary', type: 'submit', text: 'เข้าสู่ระบบ' });
    const form = el(
      'form',
      {
        on: {
          submit: async (e) => {
            e.preventDefault();
            err.textContent = '';
            submit.disabled = true;
            try {
              const out = await api('/auth/login', { method: 'POST', body: { username: user.value.trim(), password: pass.value } });
              state.token = out.token;
              sessionStorage.setItem('token', out.token);
              state.me = out.user;
              await showMain();
            } catch (ex) {
              err.textContent = ex.message;
            } finally {
              submit.disabled = false;
            }
          },
        },
      },
      el('label', {}, 'ชื่อผู้ใช้', user),
      el('label', {}, 'รหัสผ่าน', pass),
      err,
      submit,
    );
    const demo = el(
      'div',
      { hidden: true }, // แสดงเฉพาะเมื่อเซิร์ฟเวอร์เปิดโหมดสาธิต (DEMO=1)
      el('div', { class: 'hint', text: 'บัญชีสาธิต (รหัสผ่าน password123): กดเพื่อกรอกชื่อผู้ใช้' }),
      el(
        'div',
        { class: 'demo' },
        [
          ['somchai', 'พนักงาน'],
          ['tech1', 'ช่าง IT 1'],
          ['tech2', 'ช่าง IT 2'],
          ['manager', 'ผู้จัดการ'],
        ].map(([u, label]) =>
          el('button', {
            class: 'btn small',
            type: 'button',
            text: label,
            on: { click: () => { user.value = u; pass.value = 'password123'; submit.focus(); } },
          }),
        ),
      ),
    );
    // ผู้ไม่มีบัญชีแจ้งซ่อมได้เองและติดตามสถานะด้วยลิงก์ (ซ่อนลิงก์แจ้งซ่อมถ้าผู้ดูแลปิดฟีเจอร์ไว้)
    const reportLink = el('a', { class: 'btn', href: '/report.html', text: 'แจ้งซ่อมโดยไม่ต้องสมัคร / ไม่ต้องเข้าสู่ระบบ' });
    const guestLinks = el(
      'div',
      { class: 'guest-links' },
      el('div', { class: 'hint', text: 'ไม่มีบัญชีผู้ใช้?' }),
      el('div', { class: 'demo' }, reportLink, el('a', { class: 'btn', href: '/track.html', text: 'ติดตามสถานะที่แจ้งไว้' })),
    );
    api('/public/config').then((c) => { reportLink.hidden = !c.guestEnabled; demo.hidden = !c.demo; }).catch(() => {});
    $app.append(el('main', { class: 'login' }, el('h1', { text: 'IT Helpdesk' }), el('p', { class: 'hint', text: 'ระบบแจ้งซ่อมและติดตามสถานะอุปกรณ์ไอที' }), form, demo, guestLinks));
    user.focus();
  }

  function logout(message) {
    state.token = null;
    state.me = null;
    sessionStorage.removeItem('token');
    state.tickets.clear();
    state.cards.clear();
    state.expanded.clear();
    showLogin(typeof message === 'string' ? message : undefined);
  }

  /* ---------- main layout ---------- */
  let $list, $count, $stats, $conn;
  let $ticketsView, $usersView, $navTickets, $navUsers;
  let userList = [];

  async function showMain() {
    stopEvents();
    state.tickets.clear();
    state.cards.clear();
    state.filter = 'all';
    $app.replaceChildren();

    $conn = el('span', { class: 'conn', text: 'กำลังเชื่อมต่อ…' });
    const isManager = state.me.role === 'manager';
    $navTickets = el('button', { class: 'chip active', type: 'button', text: 'ตั๋วแจ้งซ่อม', on: { click: () => switchView('tickets') } });
    $navUsers = el('button', { class: 'chip', type: 'button', text: 'จัดการผู้ใช้', on: { click: () => switchView('users') } });
    const header = el(
      'header',
      { class: 'topbar' },
      el('h1', { text: 'IT Helpdesk' }),
      isManager && el('nav', { class: 'nav', 'aria-label': 'เมนูหลัก' }, $navTickets, $navUsers),
      el('span', { class: 'spacer' }),
      $conn,
      el('span', { class: 'who', text: `${state.me.name} (${ROLE_LABEL[state.me.role]})` }),
      el('button', { class: 'btn small', text: 'เปลี่ยนรหัสผ่าน', on: { click: changeMyPassword } }),
      el('button', { class: 'btn small', text: 'ออกจากระบบ', on: { click: () => logout() } }),
    );

    const wrap = el('main', { class: 'wrap' });
    $ticketsView = el('div', { class: 'view' });
    $usersView = el('div', { class: 'view', hidden: true });
    wrap.append($ticketsView, $usersView);
    if (isManager) {
      $stats = el('section', { class: 'panel' }, el('h2', { text: 'ภาพรวมการแจ้งซ่อม' }), el('div', { class: 'hint', text: 'กำลังโหลด…' }));
      $ticketsView.append($stats);
    }

    const [cats, users] = await Promise.all([
      api('/categories'),
      state.me.role === 'manager' ? api('/users?role=it_support') : Promise.resolve({ data: [] }),
    ]);
    state.categories = new Map(cats.data.map((c) => [c.slug, c.name]));
    state.techs = users.data;

    if (state.me.role === 'employee') $ticketsView.append(buildCreateForm());

    $count = el('span', { class: 'hint' });
    $list = el('div', { class: 'list' });
    const chips = el(
      'div',
      { class: 'toolbar' },
      [['all', 'ทั้งหมด'], ['open', STATUS_LABEL.open], ['in_progress', STATUS_LABEL.in_progress], ['resolved', STATUS_LABEL.resolved]].map(([key, label]) =>
        el('button', {
          class: `chip${key === 'all' ? ' active' : ''}`,
          type: 'button',
          text: label,
          'data-filter': key,
          on: {
            click: (e) => {
              state.filter = key;
              chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === e.currentTarget));
              applyFilter();
            },
          },
        }),
      ),
      $count,
    );
    $ticketsView.append(el('section', { class: 'panel' }, el('h2', { text: state.me.role === 'employee' ? 'รายการแจ้งซ่อมของฉัน' : 'รายการแจ้งซ่อมทั้งหมด' }), chips, $list));
    $app.append(header, wrap);

    await loadTickets();
    refreshStats();
    startEvents();
  }

  async function loadTickets() {
    const out = await api('/tickets?limit=200');
    const ids = new Set(out.data.map((t) => t._id));
    for (const id of [...state.tickets.keys()]) if (!ids.has(id)) removeTicket(id);
    // ใส่จากเก่าไปใหม่ เพื่อให้ใหม่สุดอยู่บนสุด
    for (const t of [...out.data].reverse()) upsertTicket(t, { flash: false });
    applyFilter();
  }

  /* ---------- สร้างตั๋ว ---------- */
  function buildCreateForm() {
    const title = el('input', { type: 'text', maxlength: '120', required: true });
    const category = el('select', {}, [...state.categories].map(([slug, name]) => el('option', { value: slug, text: name })));
    const priority = el('select', {}, ['medium', 'high', 'low'].map((p) => el('option', { value: p, text: PRIORITY_LABEL[p] })));
    const desc = el('textarea', { maxlength: '2000', required: true, placeholder: 'อธิบายอาการ เช่น เกิดขึ้นเมื่อไหร่ ที่ไหน ทำอะไรอยู่' });
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
          const files = [...file.files].slice(0, MAX_IMAGES);
          if (file.files.length > MAX_IMAGES) toast(`แนบได้สูงสุด ${MAX_IMAGES} รูป`, true);
          for (const f of files) {
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
    const submit = el('button', { class: 'btn primary', type: 'submit', text: 'ส่งเรื่องแจ้งซ่อม' });
    const form = el(
      'form',
      {
        class: 'form-grid',
        on: {
          submit: (e) => {
            e.preventDefault();
            run(submit, async () => {
              const out = await api('/tickets', {
                method: 'POST',
                body: { title: title.value, description: desc.value, category: category.value, priority: priority.value, images },
              });
              form.reset();
              images = [];
              previews.replaceChildren();
              upsertTicket(out.ticket, { flash: true });
              toast(`ส่งเรื่องแล้ว ${ticketNo(out.ticket)}`);
            });
          },
        },
      },
      el('label', { class: 'full' }, 'หัวข้อ', title),
      el('label', {}, 'หมวดหมู่', category),
      el('label', {}, 'ความเร่งด่วน', priority),
      el('label', { class: 'full' }, 'รายละเอียดอาการ', desc),
      el('label', { class: 'full' }, `แนบรูปอาการเสีย (ไม่เกิน ${MAX_IMAGES} รูป)`, file, previews),
      el('div', { class: 'full' }, submit),
    );
    return el('section', { class: 'panel' }, el('h2', { text: 'แจ้งซ่อมใหม่' }), form);
  }

  /* ---------- ตั๋ว: สร้าง/อัปเดตเฉพาะส่วน (partial render) ---------- */
  function upsertTicket(t, { flash }) {
    const prev = state.tickets.get(t._id);
    state.tickets.set(t._id, t);
    let card = state.cards.get(t._id);
    if (!card) {
      card = buildCard(t);
      state.cards.set(t._id, card);
      $list.prepend(card);
    } else {
      updateCard(card, t);
    }
    card.hidden = !matchesFilter(t);
    if (flash) {
      card.classList.remove('flash');
      void card.offsetWidth; // รีสตาร์ทแอนิเมชัน
      card.classList.add('flash');
    }
    refreshCount();
    return prev;
  }

  function removeTicket(id) {
    state.tickets.delete(id);
    state.expanded.delete(id);
    const card = state.cards.get(id);
    if (card) card.remove();
    state.cards.delete(id);
    refreshCount();
  }

  const matchesFilter = (t) => state.filter === 'all' || t.status === state.filter;

  function applyFilter() {
    for (const [id, card] of state.cards) card.hidden = !matchesFilter(state.tickets.get(id));
    refreshCount();
  }

  function refreshCount() {
    if (!$count) return;
    const n = [...state.cards.values()].filter((c) => !c.hidden).length;
    $count.textContent = `${n} รายการ`;
    let empty = $list.querySelector('.empty');
    if (n === 0 && !empty) $list.append(el('div', { class: 'empty', text: 'ยังไม่มีรายการ' }));
    if (n > 0 && empty) empty.remove();
  }

  function buildCard(t) {
    const refs = {
      no: el('span', { class: 't-no' }),
      title: el('span', { class: 't-title' }),
      prio: el('span', { class: 'badge' }),
      cat: el('span', { class: 'badge' }),
      guest: el('span', { class: 'badge guest', text: 'ผู้แจ้งภายนอก', hidden: true }),
      meta: el('div', { class: 't-meta' }),
      desc: el('p', { class: 't-desc' }),
      fill: el('div', { class: 'fill' }),
      steps: el('div', { class: 'steps' }, Object.keys(STATUS_LABEL).map((s) => el('span', { 'data-s': s, text: STATUS_LABEL[s] }))),
      actions: el('div', { class: 'actions' }),
      detail: el('div', { class: 'detail', hidden: true }),
    };
    const progress = el('div', { class: 'progress' }, el('div', { class: 'track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, refs.fill), refs.steps);
    refs.progress = progress.firstChild;
    const card = el(
      'article',
      { class: 'ticket', 'data-id': t._id },
      el('div', { class: 't-head' }, refs.no, refs.title, refs.prio, refs.cat, refs.guest),
      refs.meta,
      refs.desc,
      progress,
      refs.actions,
      refs.detail,
    );
    card._refs = refs;
    updateCard(card, t);
    return card;
  }

  function updateCard(card, t) {
    const r = card._refs;
    r.no.textContent = ticketNo(t);
    r.title.textContent = t.title;
    r.prio.textContent = PRIORITY_LABEL[t.priority];
    r.prio.classList.toggle('high', t.priority === 'high');
    r.cat.textContent = state.categories.get(t.category) || t.category;
    const parts = [];
    r.guest.hidden = !t.guest;
    if (state.me.role !== 'employee') {
      // ผู้แจ้งภายนอกไม่มีบัญชี: ช่างต้องเห็นช่องทางติดต่อกลับ (พนักงานทั่วไปไม่เห็นตั๋วกลุ่มนี้เลย)
      parts.push(t.guest ? `ผู้แจ้ง: ${t.createdByName} (ไม่มีบัญชี) · ติดต่อ: ${t.guestContact || '-'}` : `ผู้แจ้ง: ${t.createdByName}`);
    }
    parts.push(`แจ้งเมื่อ ${fmtTime(t.createdAt)}`);
    parts.push(`ผู้รับผิดชอบ: ${t.assignedToName || 'ยังไม่มอบหมาย'}`);
    if (t.assignedToName && t.firstResponseAt) parts.push(`รับเรื่องเมื่อ ${fmtTime(t.firstResponseAt)}`);
    if (t.resolvedAt) parts.push(`เสร็จเมื่อ ${fmtTime(t.resolvedAt)}`);
    r.meta.textContent = parts.join(' · ');
    r.desc.textContent = t.description;

    // Progress bar: เปลี่ยนความกว้างบน element เดิม จึงเห็นแอนิเมชันเลื่อนทันที ไม่ต้อง F5
    r.fill.className = `fill ${t.status}`;
    r.fill.style.width = `${STATUS_PCT[t.status]}%`;
    r.progress.setAttribute('aria-valuenow', String(STATUS_PCT[t.status]));
    r.progress.setAttribute('aria-valuetext', STATUS_LABEL[t.status]);
    r.steps.querySelectorAll('span').forEach((s) => s.classList.toggle('cur', s.dataset.s === t.status));

    // สร้างปุ่มใหม่เฉพาะเมื่อสถานะ/ผู้รับผิดชอบเปลี่ยน (ไม่ล้างข้อความที่กำลังพิมพ์)
    const sig = `${t.status}|${t.assignedTo}`;
    if (card.dataset.sig !== sig) {
      card.dataset.sig = sig;
      renderActions(card, t);
    }
    if (state.expanded.has(t._id)) loadDetail(card, t);
  }

  function renderActions(card, t) {
    const box = card._refs.actions;
    box.replaceChildren();
    const me = state.me;

    if (me.role === 'employee') {
      if (t.status === 'open') {
        const b = el('button', { class: 'btn small danger', text: 'ยกเลิกการแจ้งซ่อม' });
        b.addEventListener('click', () => {
          if (!confirm(`ยกเลิกการแจ้งซ่อม ${ticketNo(t)} ?`)) return;
          run(b, async () => {
            await api(`/tickets/${t._id}`, { method: 'DELETE' });
            removeTicket(t._id);
            toast('ยกเลิกการแจ้งซ่อมแล้ว');
          });
        });
        box.append(b);
      }
    } else if (t.status !== 'resolved') {
      const canChange = me.role === 'it_support' ? !t.assignedTo || t.assignedTo === me.id : Boolean(t.assignedTo);

      if (me.role === 'it_support' && !t.assignedTo) {
        const b = el('button', { class: 'btn small', text: 'รับงานนี้' });
        b.addEventListener('click', () => run(b, async () => {
          const out = await api(`/tickets/${t._id}/assign`, { method: 'PATCH', body: {} });
          upsertTicket(out.ticket, { flash: false });
        }));
        box.append(b);
      }
      if (me.role === 'manager') {
        const sel = el('select', { 'aria-label': 'เลือกช่าง' }, [
          el('option', { value: '', text: '— เลือกช่าง —' }),
          ...state.techs.map((u) => el('option', { value: u.id, text: u.name, selected: u.id === t.assignedTo })),
        ]);
        const b = el('button', { class: 'btn small', text: 'มอบหมาย' });
        b.addEventListener('click', () => {
          if (!sel.value) return toast('กรุณาเลือกช่าง', true);
          run(b, async () => {
            const out = await api(`/tickets/${t._id}/assign`, { method: 'PATCH', body: { assigneeId: sel.value } });
            upsertTicket(out.ticket, { flash: false });
          });
        });
        box.append(sel, b);
      }
      if (canChange) {
        const next = t.status === 'open' ? 'in_progress' : 'resolved';
        const note = el('input', { type: 'text', maxlength: '1000', placeholder: 'บันทึกการซ่อม (ไม่บังคับ)', 'aria-label': 'บันทึกการซ่อม' });
        const b = el('button', { class: 'btn small primary', text: next === 'in_progress' ? 'เริ่มดำเนินการ' : 'แก้ไขเสร็จสิ้น' });
        b.addEventListener('click', () => run(b, async () => {
          const out = await api(`/tickets/${t._id}/status`, { method: 'PUT', body: { status: next, note: note.value } });
          upsertTicket(out.ticket, { flash: false });
        }));
        box.append(note, b);
      }
    }

    // โน้ตทำได้ทุกสถานะ (รวมหลังปิดงาน) ระบบประทับชื่อและเวลาให้เอง
    const canNote = me.role === 'manager' || (me.role === 'it_support' && (!t.assignedTo || t.assignedTo === me.id));
    if (canNote) box.append(el('button', { class: 'btn small', text: '+ เพิ่มโน้ต', on: { click: () => addNote(t) } }));

    const toggle = el('button', { class: 'btn small', text: state.expanded.has(t._id) ? 'ซ่อนรายละเอียด' : 'รูปภาพ/ประวัติ' });
    toggle.addEventListener('click', () => {
      const open = !state.expanded.has(t._id);
      if (open) state.expanded.add(t._id);
      else state.expanded.delete(t._id);
      toggle.textContent = open ? 'ซ่อนรายละเอียด' : 'รูปภาพ/ประวัติ';
      card._refs.detail.hidden = !open;
      if (open) loadDetail(card, state.tickets.get(t._id));
    });
    box.append(toggle);
    card._refs.detail.hidden = !state.expanded.has(t._id);
  }

  function addNote(t) {
    openForm({
      title: `เพิ่มโน้ต ${ticketNo(t)}`,
      intro: 'ระบบจะบันทึกชื่อและเวลาของคุณให้อัตโนมัติ พนักงานผู้แจ้งจะเห็นโน้ตนี้ด้วย',
      fields: [{ key: 'text', label: 'ข้อความ', type: 'textarea', maxlength: 1000, placeholder: 'เช่น รับเรื่องแล้ว กำลังตรวจสอบ / เปลี่ยนสายแล้ว รอทดสอบ' }],
      submitText: 'บันทึกโน้ต',
      onSubmit: async (v) => {
        const out = await api(`/tickets/${t._id}/notes`, { method: 'POST', body: { text: v.text } });
        // เปิดรายละเอียดให้เห็นโน้ตที่เพิ่งเพิ่มทันที
        state.expanded.add(t._id);
        const card = state.cards.get(t._id);
        if (card) delete card.dataset.sig;
        upsertTicket(out.ticket, { flash: false });
        toast('บันทึกโน้ตแล้ว');
      },
    });
  }

  const HISTORY = {
    'ticket.note': () => 'เพิ่มโน้ต',
    'ticket.created': () => 'สร้างตั๋วแจ้งซ่อม',
    'ticket.assigned': (d) => `มอบหมายให้ ${d.assignee}`,
    'ticket.status': (d) => `เปลี่ยนสถานะเป็น “${STATUS_LABEL[d.to]}”${d.note ? ` – ${d.note}` : ''}`,
  };

  async function loadDetail(card, t) {
    try {
      const { ticket, history } = await api(`/tickets/${t._id}`);
      const box = card._refs.detail;
      box.replaceChildren();
      if (ticket.images.length) box.append(el('div', { class: 'thumbs' }, ticket.images.map((src, i) => el('img', { src, alt: `รูปอาการเสีย ${i + 1}` }))));
      if (ticket.notes.length) {
        box.append(el('div', {}, el('b', { text: 'บันทึกจากช่าง' }), el('ul', { class: 'history' }, ticket.notes.map((n) => el('li', { text: `${fmtTime(n.at)} · ${n.byName}: ${n.text}` })))));
      }
      box.append(
        el('div', {}, el('b', { text: 'ประวัติ' }), el('ul', { class: 'history' }, history.map((h) => el('li', { text: `${fmtTime(h.at)} · ${h.actorName} · ${(HISTORY[h.action] || (() => h.action))(h.detail || {})}` })))),
      );
    } catch (e) {
      if (state.me) toast(e.message, true);
    }
  }

  /* ---------- กล่องโต้ตอบ (ฟอร์มในหน้าต่างซ้อน) ---------- */
  function openForm({ title, intro, fields, submitText = 'บันทึก', onSubmit }) {
    const dlg = el('dialog', { class: 'dlg', 'aria-label': title });
    const err = el('div', { class: 'error', role: 'alert' });
    const inputs = {};
    const rows = fields.map((f) => {
      const input =
        f.type === 'select'
          ? el('select', {}, f.options.map(([value, text]) => el('option', { value, text, selected: value === f.value })))
          : f.type === 'textarea'
          ? el('textarea', { name: f.key, required: true, maxlength: f.maxlength, placeholder: f.placeholder, rows: '4' })
          : el('input', {
              type: f.type || 'text',
              value: f.value ?? '',
              autocomplete: f.autocomplete || 'off',
              required: true,
              minlength: f.minlength,
              maxlength: f.maxlength,
              pattern: f.pattern,
              name: f.key,
            });
      inputs[f.key] = input;
      return el('label', {}, f.label, input, f.hint && el('span', { class: 'hint', text: f.hint }));
    });
    const submit = el('button', { class: 'btn primary', type: 'submit', text: submitText });
    const form = el(
      'form',
      {
        on: {
          submit: async (e) => {
            e.preventDefault();
            err.textContent = '';
            submit.disabled = true;
            try {
              await onSubmit(Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value])));
              dlg.close();
            } catch (ex) {
              err.textContent = ex.message;
            } finally {
              submit.disabled = false;
            }
          },
        },
      },
      el('h2', { text: title }),
      intro && el('p', { class: 'hint', text: intro }),
      rows,
      err,
      el('div', { class: 'dlg-actions' }, el('button', { class: 'btn', type: 'button', text: 'ยกเลิก', on: { click: () => dlg.close() } }), submit),
    );
    dlg.append(form);
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
    const first = dlg.querySelector('input, select');
    if (first) first.focus();
  }

  function changeMyPassword() {
    openForm({
      title: 'เปลี่ยนรหัสผ่าน',
      fields: [
        { key: 'currentPassword', label: 'รหัสผ่านปัจจุบัน', type: 'password', autocomplete: 'current-password' },
        { key: 'newPassword', label: 'รหัสผ่านใหม่', type: 'password', autocomplete: 'new-password', minlength: 8, maxlength: 128, hint: 'ยาว 8 ตัวอักษรขึ้นไป' },
        { key: 'confirm', label: 'ยืนยันรหัสผ่านใหม่', type: 'password', autocomplete: 'new-password', minlength: 8, maxlength: 128 },
      ],
      submitText: 'เปลี่ยนรหัสผ่าน',
      onSubmit: async (v) => {
        if (v.newPassword !== v.confirm) throw new Error('รหัสผ่านใหม่และการยืนยันไม่ตรงกัน');
        const out = await api('/auth/password', { method: 'POST', body: { currentPassword: v.currentPassword, newPassword: v.newPassword } });
        state.token = out.token; // token เก่าถูกยกเลิกแล้ว ใช้ token ใหม่ต่อได้เลย
        sessionStorage.setItem('token', out.token);
        toast('เปลี่ยนรหัสผ่านแล้ว');
      },
    });
  }

  /* ---------- จัดการผู้ใช้ (ผู้จัดการ) ---------- */
  function switchView(name) {
    $ticketsView.hidden = name !== 'tickets';
    $usersView.hidden = name !== 'users';
    $navTickets.classList.toggle('active', name === 'tickets');
    $navUsers.classList.toggle('active', name === 'users');
    if (name === 'users') loadUsers();
  }

  async function loadUsers() {
    try {
      userList = (await api('/admin/users')).data;
      renderUsers();
    } catch (e) {
      toast(e.message, true);
    }
  }

  // หลังแก้ไขผู้ใช้: รีเฟรชรายชื่อช่างสำหรับมอบหมาย และชื่อที่แสดงในตั๋ว
  async function afterUserChange() {
    try {
      state.techs = (await api('/users?role=it_support')).data;
      await loadTickets();
      for (const [id, card] of state.cards) {
        delete card.dataset.sig; // บังคับสร้างปุ่ม/รายการช่างใหม่
        updateCard(card, state.tickets.get(id));
      }
    } catch {
      /* ไม่กระทบการทำงานหลัก */
    }
  }

  const replaceUser = (u) => {
    userList = userList.map((x) => (x.id === u.id ? u : x));
    renderUsers();
  };

  async function patchUser(u, body, okMessage) {
    try {
      const out = await api(`/admin/users/${u.id}`, { method: 'PATCH', body });
      replaceUser(out.user);
      toast(okMessage);
      afterUserChange();
    } catch (e) {
      toast(e.message, true);
      renderUsers(); // คืนค่าเดิมในตาราง
    }
  }

  const ROLE_ORDER = ['employee', 'it_support', 'manager'];

  function openAddUser() {
    openForm({
      title: 'เพิ่มพนักงาน',
      fields: [
        { key: 'username', label: 'ชื่อผู้ใช้', minlength: 3, maxlength: 32, pattern: '[a-z0-9][a-z0-9._\\-]{2,31}', hint: 'a-z 0-9 . _ - ยาว 3-32 ตัวอักษร (ตัวพิมพ์เล็ก)' },
        { key: 'name', label: 'ชื่อ-นามสกุล', maxlength: 80 },
        { key: 'role', label: 'บทบาท', type: 'select', value: 'employee', options: ROLE_ORDER.map((r) => [r, ROLE_LABEL[r]]) },
        { key: 'password', label: 'รหัสผ่านเริ่มต้น', type: 'password', autocomplete: 'new-password', minlength: 8, maxlength: 128, hint: 'ยาว 8 ตัวอักษรขึ้นไป แจ้งผู้ใช้ด้วยตนเอง และแนะนำให้เปลี่ยนหลังเข้าใช้ครั้งแรก' },
      ],
      submitText: 'เพิ่มพนักงาน',
      onSubmit: async (v) => {
        const out = await api('/admin/users', { method: 'POST', body: v });
        userList = [...userList, out.user].sort((a, b) => a.name.localeCompare(b.name, 'th'));
        renderUsers();
        afterUserChange();
        toast(`เพิ่มพนักงาน ${out.user.name} แล้ว`);
      },
    });
  }

  function editName(u) {
    openForm({
      title: 'แก้ไขชื่อ',
      fields: [{ key: 'name', label: 'ชื่อ-นามสกุล', value: u.name, maxlength: 80 }],
      onSubmit: async (v) => {
        const out = await api(`/admin/users/${u.id}`, { method: 'PATCH', body: { name: v.name } });
        replaceUser(out.user);
        afterUserChange();
        toast('บันทึกชื่อแล้ว');
      },
    });
  }

  function resetPassword(u) {
    openForm({
      title: `รีเซ็ตรหัสผ่าน: ${u.name}`,
      intro: 'ผู้ใช้จะถูกออกจากระบบทุกอุปกรณ์ และต้องใช้รหัสผ่านใหม่นี้เข้าสู่ระบบ',
      fields: [{ key: 'password', label: 'รหัสผ่านใหม่', type: 'password', autocomplete: 'new-password', minlength: 8, maxlength: 128, hint: 'ยาว 8 ตัวอักษรขึ้นไป' }],
      submitText: 'รีเซ็ตรหัสผ่าน',
      onSubmit: async (v) => {
        await api(`/admin/users/${u.id}/password`, { method: 'POST', body: { password: v.password } });
        toast('รีเซ็ตรหัสผ่านแล้ว');
      },
    });
  }

  function toggleActive(u) {
    if (u.active && !confirm(`ปิดใช้งานบัญชีของ ${u.name} ?\nผู้ใช้จะเข้าสู่ระบบไม่ได้จนกว่าจะเปิดใช้งานอีกครั้ง`)) return;
    patchUser(u, { active: !u.active }, u.active ? 'ปิดใช้งานบัญชีแล้ว' : 'เปิดใช้งานบัญชีแล้ว');
  }

  function renderUsers() {
    const rows = userList.map((u) => {
      const self = u.id === state.me.id;
      const role = el(
        'select',
        { 'aria-label': `บทบาทของ ${u.name}`, disabled: self },
        ROLE_ORDER.map((r) => el('option', { value: r, text: ROLE_LABEL[r], selected: r === u.role })),
      );
      role.addEventListener('change', () => {
        if (!confirm(`เปลี่ยนบทบาทของ ${u.name} เป็น “${ROLE_LABEL[role.value]}” ?\nผู้ใช้จะถูกออกจากระบบและต้องเข้าสู่ระบบใหม่`)) return renderUsers();
        patchUser(u, { role: role.value }, 'เปลี่ยนบทบาทแล้ว');
      });
      const actions = el(
        'div',
        { class: 'row-actions' },
        el('button', { class: 'btn small', text: 'แก้ไขชื่อ', on: { click: () => editName(u) } }),
        !self && el('button', { class: 'btn small', text: 'รีเซ็ตรหัสผ่าน', on: { click: () => resetPassword(u) } }),
        !self && el('button', { class: `btn small${u.active ? ' danger' : ''}`, text: u.active ? 'ปิดใช้งาน' : 'เปิดใช้งาน', on: { click: () => toggleActive(u) } }),
      );
      return el(
        'tr',
        { 'data-username': u.username },
        el('td', {}, u.name, self && el('span', { class: 'hint', text: ' (คุณ)' })),
        el('td', {}, el('code', { text: u.username })),
        el('td', {}, role),
        el('td', {}, el('span', { class: `badge ${u.active ? 'ok' : 'off'}`, text: u.active ? 'ใช้งานอยู่' : 'ปิดใช้งาน' })),
        el('td', {}, actions),
      );
    });
    $usersView.replaceChildren(
      el(
        'section',
        { class: 'panel' },
        el('div', { class: 'panel-head' }, el('h2', { text: `ผู้ใช้งานระบบ (${userList.length})` }), el('button', { class: 'btn primary', text: '+ เพิ่มพนักงาน', on: { click: openAddUser } })),
        el(
          'div',
          { class: 'table-wrap' },
          el(
            'table',
            {},
            el('thead', {}, el('tr', {}, ['ชื่อ', 'ชื่อผู้ใช้', 'บทบาท', 'สถานะ', 'การจัดการ'].map((h) => el('th', { text: h })))),
            el('tbody', {}, rows),
          ),
        ),
      ),
    );
  }

  /* ---------- สถิติ (ผู้จัดการ) ---------- */
  function refreshStats() {
    if (state.me.role !== 'manager') return;
    clearTimeout(state.statsTimer);
    state.statsTimer = setTimeout(async () => {
      try {
        const s = await api('/stats');
        const stat = (value, label) => el('div', { class: 'stat' }, el('b', { text: String(value) }), el('span', { text: label }));
        $stats.replaceChildren(
          el('h2', { text: 'ภาพรวมการแจ้งซ่อม' }),
          el(
            'div',
            { class: 'stats' },
            stat(s.total, 'ตั๋วทั้งหมด'),
            stat(s.byStatus.open, STATUS_LABEL.open),
            stat(s.byStatus.in_progress, STATUS_LABEL.in_progress),
            stat(s.byStatus.resolved, STATUS_LABEL.resolved),
            stat(fmtDur(s.avgFirstResponseMinutes), 'เวลาตอบรับเฉลี่ย (First Response)'),
            stat(fmtDur(s.avgResolutionMinutes), 'เวลาแก้ไขเฉลี่ย'),
          ),
          el(
            'table',
            {},
            el('thead', {}, el('tr', {}, ['ช่าง', 'งานที่ถืออยู่', 'แก้ไขเสร็จ', 'เวลาแก้ไขเฉลี่ย'].map((h) => el('th', { text: h })))),
            el('tbody', {}, s.technicians.map((t) => el('tr', {}, el('td', { text: t.name }), el('td', { text: t.active }), el('td', { text: t.resolved }), el('td', { text: fmtDur(t.avgResolutionMinutes) })))),
          ),
        );
      } catch {
        /* ปล่อยให้รอบถัดไปลองใหม่ */
      }
    }, 300);
  }

  /* ---------- Real-time ผ่าน Server-Sent Events ---------- */
  function setConn(on) {
    if (!$conn) return;
    $conn.className = `conn ${on ? 'on' : 'off'}`;
    $conn.textContent = on ? 'อัปเดตสด' : 'ขาดการเชื่อมต่อ กำลังเชื่อมใหม่…';
  }

  function stopEvents() {
    if (state.events) state.events.abort();
    state.events = null;
  }

  function handleEvent(name, data) {
    if (name === 'hello') return;
    if (name === 'ticket.deleted') {
      removeTicket(data._id);
    } else if (name === 'ticket.created' || name === 'ticket.updated') {
      const prev = state.tickets.get(data.ticket._id);
      upsertTicket(data.ticket, { flash: true });
      if (state.me.role === 'employee' && prev && prev.status !== data.ticket.status) {
        toast(`${ticketNo(data.ticket)} เปลี่ยนสถานะเป็น “${STATUS_LABEL[data.ticket.status]}”`);
      } else if (state.me.role !== 'employee' && name === 'ticket.created') {
        toast(`มีเรื่องแจ้งซ่อมใหม่ ${ticketNo(data.ticket)}`);
      }
    }
    refreshStats();
  }

  async function startEvents() {
    stopEvents();
    const ctrl = new AbortController();
    state.events = ctrl;
    let first = true;
    // ใช้ fetch stream แทน EventSource เพื่อส่ง JWT ทาง Authorization header (ไม่ใส่ token ใน URL)
    while (!ctrl.signal.aborted) {
      try {
        const res = await fetch(`${API}/events`, { headers: { Authorization: `Bearer ${state.token}` }, signal: ctrl.signal });
        if (res.status === 401) return logout('บัญชีหรือสิทธิ์ของคุณมีการเปลี่ยนแปลง กรุณาเข้าสู่ระบบใหม่');
        if (!res.ok || !res.body) throw new Error('stream');
        setConn(true);
        if (!first) { await loadTickets(); refreshStats(); } // ซิงก์ข้อมูลที่พลาดไประหว่างขาดการเชื่อมต่อ
        first = false;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let name = 'message';
            let data = '';
            for (const line of chunk.split('\n')) {
              if (line.startsWith('event:')) name = line.slice(6).trim();
              else if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (data) {
              try { handleEvent(name, JSON.parse(data)); } catch { /* ข้ามเหตุการณ์ที่อ่านไม่ได้ */ }
            }
          }
        }
      } catch {
        if (ctrl.signal.aborted) return;
      }
      setConn(false);
      await new Promise((r) => setTimeout(r, 2500));
    }
  }

  /* ---------- เริ่มต้น ---------- */
  (async () => {
    if (!state.token) return showLogin();
    try {
      state.me = (await api('/auth/me')).user;
      await showMain();
    } catch {
      showLogin();
    }
  })();
})();
