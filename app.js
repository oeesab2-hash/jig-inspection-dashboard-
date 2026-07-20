/* =====================================================
   JIG Inspection Dashboard — app.js  v2
   3-Level Filter (Dept → Line → JIG) + Admin Panel
   ===================================================== */
(function () {
  'use strict';

  /* ══════════════════════════════════════
     STORAGE KEYS
     — structured so migrating to Supabase/Firebase
       in Step 2 only requires swapping the load/save
       functions, nothing else changes.
  ══════════════════════════════════════ */
  const SK = {
    catalog:  'jig_catalog_v2',   // { depts, lines, jigs }
    history:  'jig_history_v2',   // array of report records
  };

  /* ══════════════════════════════════════
     SUPABASE — cloud sync (ให้ทั้งทีมเห็นข้อมูลเดียวกัน)
     ตาราง app_kv: key (text, PK) | value (jsonb) | updated_at
     เก็บ catalog กับ history เป็น 2 แถวใน key-value store เดียวกัน
  ══════════════════════════════════════ */
  const SUPABASE_URL = 'https://iaioolqowkcnhsqrulho.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhaW9vbHFvd2tjbmhzcXJ1bGhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0OTIwNTcsImV4cCI6MjEwMDA2ODA1N30.Ek5jnCYaQLvhYsbm2r8tqRJr8KCclIBgid_ZMm2E8-w';
  const sb = (window.supabase && window.supabase.createClient)
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

  let _syncing = false; // กัน realtime event ที่มาจาก push ของตัวเองไม่ให้ re-render วนซ้ำ
  const _pushTimers = {};

  // ส่งข้อมูลขึ้น Supabase แบบ debounce (รวมการกดรัวๆ ให้เหลือ request เดียว) — ไม่บล็อก UI
  function pushToSupabase(key, value) {
    if (!sb) return;
    clearTimeout(_pushTimers[key]);
    _pushTimers[key] = setTimeout(async () => {
      if (_syncing) return;
      try {
        const { error } = await sb.from('app_kv').upsert({ key, value, updated_at: new Date().toISOString() });
        if (error) throw error;
      } catch (e) {
        console.error('Supabase push error:', key, e);
      }
    }, 500);
  }

  // ดึงข้อมูลล่าสุดจาก Supabase มาทับ localStorage ก่อน render ครั้งแรก (โหลดตอนเปิดแอป)
  async function pullFromSupabase() {
    if (!sb) return;
    try {
      const { data, error } = await sb.from('app_kv').select('key, value').in('key', ['catalog', 'history']);
      if (error) throw error;
      (data || []).forEach(row => {
        if (row.key === 'catalog' && row.value) localStorage.setItem(SK.catalog, JSON.stringify(row.value));
        if (row.key === 'history' && row.value) localStorage.setItem(SK.history, JSON.stringify(row.value));
      });
    } catch (e) {
      console.warn('Supabase pull error (ใช้ข้อมูลใน local แทน):', e);
    }
  }

  // ฟังการเปลี่ยนแปลง realtime จากเพื่อนร่วมทีมคนอื่น แล้วรีเฟรชหน้าจอให้อัตโนมัติ
  function subscribeRealtime() {
    if (!sb) return;
    sb.channel('app_kv_changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'app_kv' }, payload => {
        const row = payload.new;
        if (!row || !row.key) return;
        _syncing = true;
        try {
          if (row.key === 'catalog' && row.value) {
            localStorage.setItem(SK.catalog, JSON.stringify(row.value));
            loadCatalog();
            renderFilter();
            if (typeof renderAdminLists === 'function') renderAdminLists();
            toast('📥 Catalog อัปเดตจากทีม', 'ok');
          }
          if (row.key === 'history' && row.value) {
            localStorage.setItem(SK.history, JSON.stringify(row.value));
            if (typeof populateHistoryPanel === 'function') populateHistoryPanel();
            if (typeof refreshDashboard === 'function') refreshDashboard();
            toast('📥 มีข้อมูลตรวจสอบใหม่จากทีม', 'ok');
          }
        } finally {
          setTimeout(() => { _syncing = false; }, 100);
        }
      })
      .subscribe();
  }

  /* ══════════════════════════════════════
     DEFAULT CHECKLIST ITEMS
     (per-JIG items come from catalog in future;
      for now all JIGs share the same 10-point list)
  ══════════════════════════════════════ */
  const DEFAULT_ITEMS = [
    { id: 1, label: 'L-Pin ตรวจสอบสภาพ',        sub: 'ไม่สึกหรอ, ยึดแน่น',        method: 'ตรวจสอบด้วยสายตา / จับโยก', x: 140, y: 110 },
    { id: 2, label: 'R-Pin ตรวจสอบสภาพ',        sub: 'ไม่สึกหรอ, ยึดแน่น',        method: 'ตรวจสอบด้วยสายตา / จับโยก', x: 460, y: 110 },
    { id: 3, label: 'Clamp 01 แคลมป์หน้า',     sub: 'ทำงานปกติ, ไม่หลวม',        method: 'ทดสอบการจับยึด', x: 300, y: 120 },
    { id: 4, label: 'Clamp 02 แคลมป์หลัง',     sub: 'ทำงานปกติ, ไม่หลวม',        method: 'ทดสอบการจับยึด', x: 300, y: 220 },
    { id: 5, label: 'Support Block A',            sub: 'ตำแหน่งตรง ไม่มีรอยร้าว', method: 'ตรวจสอบด้วยสายตา', x: 200, y: 75 },
    { id: 6, label: 'Support Block B',            sub: 'ตำแหน่งตรง ไม่มีรอยร้าว', method: 'ตรวจสอบด้วยสายตา', x: 400, y: 265 },
    { id: 7, label: 'ระบบลม Pneumatic',          sub: 'ไม่รั่ว แรงดันปกติ',        method: 'ฟังเสียง / ดูเกจ', x: 520, y: 170 },
    { id: 8, label: 'Proximity Sensor',           sub: 'ตรวจจับชิ้นงานได้',         method: 'ทดสอบ Sensor', x: 300, y: 170 },
    { id: 9, label: 'Ground Cable สายดิน',       sub: 'สภาพดี ต่อแน่น',            method: 'ตรวจสอบด้วยสายตา', x: 80, y: 170 },
    { id: 10, label: 'โครงสร้าง Frame & Base',  sub: 'ไม่บิด ไม่ร้าว ระนาบปกติ', method: 'ตรวจสอบด้วยสายตา', x: 300, y: 50 },
  ];

  /* ══════════════════════════════════════
     SEED DATA — โครงสร้างจริงจากโรงงาน
     แผนก BODY  : 5 Lines, 43 JIG
     แผนก Exhaust: 5 Lines, 140 JIG
     รวม 183 JIG (ชื่อ placeholder — rename ได้ใน Admin)
  ══════════════════════════════════════ */

  // Helper: สร้าง JIG array จำนวน n ตัว ตาม lineId และ prefix
  function makeJigs(lineId, prefix, count) {
    return Array.from({ length: count }, (_, i) => {
      const num = String(i + 1).padStart(2, '0');
      const id  = `${prefix}-${num}`;
      return { id, lineId, name: `JIG ${prefix.replace('-','')}-${num}`, docNo: id };
    });
  }

  const DEMO_CATALOG = (function () {
    const depts = [
      { id: 'BODY',    name: 'แผนก BODY' },
      { id: 'EXHAUST', name: 'แผนก Exhaust' },
    ];
    const lines = [
      // BODY (43 JIG รวม)
      { id: 'SILL',     deptId: 'BODY',    name: 'LINE : SILL' },         // 4
      { id: 'BEAM',     deptId: 'BODY',    name: 'LINE : BEAM' },         // 8
      { id: 'FRAM',     deptId: 'BODY',    name: 'LINE : FRAM ASM' },     // 11
      { id: 'SIDEUPR',  deptId: 'BODY',    name: 'LINE : SIDE UPR' },     // 4
      { id: 'SIDESTEP', deptId: 'BODY',    name: 'LINE : SIDE STEP' },    // 16
      // Exhaust (140 JIG รวม)
      { id: 'EXH-RG01', deptId: 'EXHAUST', name: 'LINE : Exhaust RG01' },         // 30
      { id: 'EXH-BEND', deptId: 'EXHAUST', name: 'LINE : BENDING EXHAUST' },      // 20
      { id: 'EXH-SIL',  deptId: 'EXHAUST', name: 'LINE : SILENCER Exhaust' },     // 50
      { id: 'EXH-RJ01', deptId: 'EXHAUST', name: 'LINE : Exhaust Pipe RJ01' },    // 20
      { id: 'EXH-VD00', deptId: 'EXHAUST', name: 'LINE : VD00' },                 // 20
    ];
    const jigs = [
      // BODY
      ...makeJigs('SILL',     'SILL',     4),
      ...makeJigs('BEAM',     'BEAM',     8),
      ...makeJigs('FRAM',     'FRAM',    11),
      ...makeJigs('SIDEUPR',  'SUPR',     4),
      ...makeJigs('SIDESTEP', 'SSTEP',   16),
      // Exhaust
      ...makeJigs('EXH-RG01', 'RG01',   30),
      ...makeJigs('EXH-BEND', 'BEND',   20),
      ...makeJigs('EXH-SIL',  'SIL',    50),
      ...makeJigs('EXH-RJ01', 'RJ01',   20),
      ...makeJigs('EXH-VD00', 'VD00',   20),
    ];
    return { depts, lines, jigs };
  })();

  /* ══════════════════════════════════════
     STATE
  ══════════════════════════════════════ */
  let catalog = { depts: [], lines: [], jigs: [], templates: [] };
  let selection = { deptId: null, lineId: null, jigId: null };
  let jigSearchTerm = ''; // filters the Level-3 JIG chip list
  let checkState = [];  // current inspection items
  let cpEditJigId = null; // JIG ที่กำลังแก้ไขจุดตรวจ/รูปพื้นหลังใน Admin Panel

  /* ══════════════════════════════════════
     STORAGE (localStorage — Step 1)
     Replace these 4 functions with API calls in Step 2
  ══════════════════════════════════════ */
  function loadCatalog() {
    try {
      const raw = localStorage.getItem(SK.catalog);
      if (raw) catalog = JSON.parse(raw);
    } catch (e) { catalog = { depts: [], lines: [], jigs: [], templates: [] }; }
    if (!Array.isArray(catalog.templates)) catalog.templates = []; // migration: เทมเพลตหัวข้อตรวจสอบ (ใหม่)
  }
  function saveCatalog() {
    try {
      localStorage.setItem(SK.catalog, JSON.stringify(catalog));
    } catch (e) {
      console.error('saveCatalog error:', e);
      toast('พื้นที่จัดเก็บเต็ม — รูปภาพอาจไม่ถูกบันทึก ลองลบรูปพื้นหลังบาง JIG ออก', 'ng');
    }
    pushToSupabase('catalog', catalog);
  }

  /* ══════════════════════════════════════
     IMAGE HELPERS — ย่อขนาดรูปก่อนเก็บเป็น base64
     เพื่อไม่ให้ localStorage เต็มเร็วเกินไป
  ══════════════════════════════════════ */
  function resizeImageToDataURL(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            const scale = maxDim / Math.max(width, height);
            width = Math.round(width * scale);
            height = Math.round(height * scale);
          }
          const canvas = document.createElement('canvas');
          canvas.width = width; canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = () => reject(new Error('ไม่สามารถอ่านไฟล์รูปภาพได้'));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('อ่านไฟล์ไม่สำเร็จ'));
      reader.readAsDataURL(file);
    });
  }
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(SK.history)) || []; } catch { return []; }
  }
  function saveHistory(arr) {
    try {
      localStorage.setItem(SK.history, JSON.stringify(arr));
      pushToSupabase('history', arr);
      return true;
    } catch (e) {
      console.error('saveHistory error:', e);
      toast('พื้นที่จัดเก็บเต็ม — บันทึกประวัติไม่สำเร็จ ลองลบประวัติเก่าหรือรูปหลักฐานบางส่วนออก', 'ng');
      return false;
    }
  }

  /* ══════════════════════════════════════
     DOM HELPERS
  ══════════════════════════════════════ */
  const $  = id => document.getElementById(id);
  const qs = (sel, parent) => (parent || document).querySelector(sel);

  // Escape any value before it's interpolated into an innerHTML template.
  // Anything that came from a user-editable field (dept/line/JIG names,
  // checkpoint labels, notes, inspector names, etc.) MUST go through this
  // before being placed in a template string — otherwise someone typing
  // e.g. `<img src=x onerror=...>` as a name would get it executed as
  // real HTML (stored XSS).
  function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // Generate a collision-safe unique ID for records (history entries, etc).
  // Date.now() alone can collide if two records are created within the
  // same millisecond (e.g. the mock-data generator, or fast repeat taps).
  // crypto.randomUUID() needs a secure context (https/localhost); we fall
  // back to timestamp+random for plain http on a local factory network.
  function genId() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) { /* fall through to fallback */ }
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /* ══════════════════════════════════════
     INIT
  ══════════════════════════════════════ */
  async function init() {
    await pullFromSupabase(); // ดึงข้อมูลล่าสุดจากทีมมาก่อน แล้วค่อย render
    loadCatalog();
    $('inp-date').value = new Date().toISOString().slice(0, 10);

    renderFilter();
    bindJigSearch();
    bindThemeToggle();
    bindAdminPanel();
    bindActionButtons();
    bindLightbox();
    bindHistoryPanel();
    bindPanelOverlay();
    subscribeRealtime();
  }

  /* ══════════════════════════════════════
     3-LEVEL FILTER
  ══════════════════════════════════════ */
  function renderFilter() {
    renderDeptChips();
    renderLineChips();
    renderJigChips();
    updateBreadcrumb();
  }

  function renderDeptChips() {
    const container = $('chips-dept');
    if (!catalog.depts.length) {
      container.innerHTML = '<span class="chip-empty">ยังไม่มีแผนก — ไปที่ Admin Panel เพื่อเพิ่ม หรือกด "โหลดข้อมูลทดสอบ"</span>';
      return;
    }
    container.innerHTML = catalog.depts.map(d => {
      const lineCount = catalog.lines.filter(l => l.deptId === d.id).length;
      const jigCount  = catalog.jigs.filter(j => {
        const line = catalog.lines.find(l => l.id === j.lineId);
        return line && line.deptId === d.id;
      }).length;
      const sel = selection.deptId === d.id ? 'selected' : '';
      return `<button class="chip ${sel}" data-dept="${escHtml(d.id)}">
        ${escHtml(d.name)}
        <span class="chip-code">${escHtml(d.id)}</span>
        <span class="chip-count">${jigCount} JIG</span>
      </button>`;
    }).join('');
    container.querySelectorAll('.chip').forEach(btn => {
      btn.addEventListener('click', () => selectDept(btn.dataset.dept));
    });
  }

  function renderLineChips() {
    const levelEl = $('level-line');
    const container = $('chips-line');
    if (!selection.deptId) { levelEl.classList.add('hidden'); return; }
    levelEl.classList.remove('hidden');
    const lines = catalog.lines.filter(l => l.deptId === selection.deptId);
    if (!lines.length) {
      container.innerHTML = '<span class="chip-empty">ยังไม่มี Line ในแผนกนี้</span>';
      return;
    }
    container.innerHTML = lines.map(l => {
      const jigCount = catalog.jigs.filter(j => j.lineId === l.id).length;
      const sel = selection.lineId === l.id ? 'selected' : '';
      return `<button class="chip ${sel}" data-line="${escHtml(l.id)}">
        ${escHtml(l.name)}
        <span class="chip-code">${escHtml(l.id)}</span>
        <span class="chip-count">${jigCount} JIG</span>
      </button>`;
    }).join('');
    container.querySelectorAll('.chip').forEach(btn => {
      btn.addEventListener('click', () => selectLine(btn.dataset.line));
    });
  }

  function renderJigChips() {
    const levelEl = $('level-jig');
    const container = $('chips-jig');
    const banner = $('selected-banner');
    if (!selection.lineId) { levelEl.classList.add('hidden'); banner.classList.add('hidden'); return; }
    levelEl.classList.remove('hidden');
    const allJigs = catalog.jigs.filter(j => j.lineId === selection.lineId);
    if (!allJigs.length) {
      container.innerHTML = '<span class="chip-empty">ยังไม่มี JIG ใน Line นี้</span>';
      banner.classList.add('hidden');
      return;
    }

    const term = jigSearchTerm.trim().toLowerCase();
    const jigs = term
      ? allJigs.filter(j =>
          j.name.toLowerCase().includes(term) ||
          j.id.toLowerCase().includes(term) ||
          (j.docNo || '').toLowerCase().includes(term))
      : allJigs;

    if (!jigs.length) {
      container.innerHTML = `<span class="chip-empty">ไม่พบ JIG ที่ตรงกับ "${escHtml(jigSearchTerm)}"</span>`;
      banner.classList.add('hidden');
      return;
    }

    container.innerHTML = jigs.map(j => {
      const sel = selection.jigId === j.id ? 'selected' : '';
      return `<button class="chip ${sel}" data-jig="${escHtml(j.id)}">
        🔧 ${escHtml(j.name)}
        <span class="chip-code">${escHtml(j.id)}</span>
      </button>`;
    }).join('');
    container.querySelectorAll('.chip').forEach(btn => {
      btn.addEventListener('click', () => selectJig(btn.dataset.jig));
    });

    // Update banner
    if (selection.jigId) {
      const jig  = catalog.jigs.find(j => j.id === selection.jigId);
      const line = catalog.lines.find(l => l.id === selection.lineId);
      const dept = catalog.depts.find(d => d.id === selection.deptId);
      if (jig) {
        $('sb-jig-name').textContent = `${jig.name}`;
        $('sb-jig-meta').textContent = `${jig.docNo || jig.id}  ·  ${dept ? dept.name : ''}  >  ${line ? line.name : ''}`;
        banner.classList.remove('hidden');
        $('svg-jig-label').textContent = `${jig.name} — ${jig.docNo || jig.id}`;
        $('header-sub').textContent = `${jig.docNo || jig.id}  ·  ${dept ? dept.name : ''}  /  ${line ? line.name : ''}`;
      }
    } else {
      banner.classList.add('hidden');
    }
  }

  function bindJigSearch() {
    const input = $('jig-search');
    const clearBtn = $('jig-search-clear');
    input.addEventListener('input', () => {
      jigSearchTerm = input.value;
      clearBtn.classList.toggle('hidden', !jigSearchTerm);
      renderJigChips();
    });
    clearBtn.addEventListener('click', () => {
      input.value = '';
      resetJigSearch();
      renderJigChips();
      input.focus();
    });
  }

  function resetJigSearch() {
    jigSearchTerm = '';
    const input = $('jig-search');
    const clearBtn = $('jig-search-clear');
    if (input) input.value = '';
    if (clearBtn) clearBtn.classList.add('hidden');
  }

  /* ── Selection handlers ── */
  function selectDept(id) {
    if (selection.deptId === id) {
      selection = { deptId: null, lineId: null, jigId: null };
    } else {
      selection = { deptId: id, lineId: null, jigId: null };
    }
    resetJigSearch();
    hideInspectionCards();
    renderFilter();
  }

  function selectLine(id) {
    if (selection.lineId === id) {
      selection.lineId = null; selection.jigId = null;
    } else {
      selection.lineId = id; selection.jigId = null;
    }
    resetJigSearch();
    hideInspectionCards();
    renderFilter();
  }

  function selectJig(id) {
    if (selection.jigId === id) return;
    selection.jigId = id;
    renderFilter();
    showInspectionCards();
  }

  function updateBreadcrumb() {
    const bc = $('breadcrumb');
    let parts = [{ label: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg> เริ่มต้น', level: 0 }];
    if (selection.deptId) {
      const d = catalog.depts.find(x => x.id === selection.deptId);
      if (d) parts.push({ label: escHtml(d.name), level: 1 });
    }
    if (selection.lineId) {
      const l = catalog.lines.find(x => x.id === selection.lineId);
      if (l) parts.push({ label: escHtml(l.name), level: 2 });
    }
    if (selection.jigId) {
      const j = catalog.jigs.find(x => x.id === selection.jigId);
      if (j) parts.push({ label: escHtml(j.name), level: 3 });
    }
    bc.innerHTML = parts.map((p, i) => {
      const active = i === parts.length - 1 ? 'active' : '';
      const sep = i < parts.length - 1 ? '<span class="bc-sep">›</span>' : '';
      return `<span class="bc-item ${active}" data-level="${p.level}">${p.label}</span>${sep}`;
    }).join('');

    bc.querySelectorAll('.bc-item').forEach(el => {
      el.addEventListener('click', () => {
        const lv = parseInt(el.dataset.level);
        if (lv === 0) { selection = { deptId: null, lineId: null, jigId: null }; }
        else if (lv === 1) { selection.lineId = null; selection.jigId = null; }
        else if (lv === 2) { selection.jigId = null; }
        hideInspectionCards();
        renderFilter();
      });
    });
  }

  /* ── Show / hide inspection section ── */
  function showInspectionCards() {
    ['meta-card','map-card','checklist-card','notes-card','sig-card','action-row']
      .forEach(id => $(id).classList.remove('hidden'));
    initCheckState();
    renderChecklist();
    updateStats();
    $(  'meta-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function hideInspectionCards() {
    ['meta-card','map-card','checklist-card','notes-card','sig-card','action-row']
      .forEach(id => $(id).classList.add('hidden'));
  }

  /* ── Reset check state ── */
  function getActiveCheckpoints() {
    const jig = catalog.jigs.find(j => j.id === selection.jigId);
    return (jig && jig.checkpoints && jig.checkpoints.length) ? jig.checkpoints : DEFAULT_ITEMS;
  }

  function initCheckState() {
    const pts = getActiveCheckpoints();
    checkState = pts.map(i => ({
      id: i.id, label: i.label, sub: i.sub, method: i.method,
      status: '', note: '', photos: [],
      type: i.type || null, min: i.min, max: i.max, unit: i.unit, value: null,
    }));
    renderSvgMap();
  }

  /* ── วาดแผนผัง: รูปพื้นหลัง (ถ้ามี) + จุดตรวจสอบตาม JIG ที่เลือก ── */
  function renderSvgMap() {
    const jig = catalog.jigs.find(j => j.id === selection.jigId);
    const bgImg = $('svg-bg-image');
    const defaultDrawing = $('svg-default-drawing');
    if (jig && jig.bgImage) {
      bgImg.setAttribute('href', jig.bgImage);
      bgImg.style.display = '';
      defaultDrawing.style.display = 'none';
    } else {
      bgImg.style.display = 'none';
      defaultDrawing.style.display = '';
    }
    const pts = getActiveCheckpoints();
    $('svg-points-group').innerHTML = pts.map((p, i) => `
      <g class="svg-pt" data-point="${p.id}" transform="translate(${p.x},${p.y})">
        <circle class="pt-pulse" r="14"/><circle class="pt-core" r="8"/><text y="4" class="pt-label">${i + 1}</text>
      </g>`).join('');
  }

  /* ══════════════════════════════════════
     CHECKLIST
  ══════════════════════════════════════ */
  function renderChecklist() {
    const wrap = $('checklist-wrapper');
    wrap.innerHTML = '';
    checkState.forEach((item, idx) => {
      const isNumeric = item.type === 'numeric';
      const div = document.createElement('div');
      div.className = 'check-item';
      div.dataset.idx = idx;
      div.innerHTML = `
        <div class="check-row">
          <span class="check-num">${idx + 1}</span>
          <div class="check-label">
            ${escHtml(item.label)}
            <small>${escHtml(item.sub)} — ${escHtml(item.method)}</small>
            ${isNumeric ? `
              <div class="check-numeric-row">
                <input type="number" step="any" inputmode="decimal" class="check-numeric-input" id="numval-${idx}" placeholder="กรอกค่า">
                <span class="check-numeric-unit">${escHtml(item.unit || '')}</span>
                <span class="check-numeric-range">(เกณฑ์ ${item.min}-${item.max}${item.unit ? ' ' + escHtml(item.unit) : ''})</span>
              </div>` : ''}
          </div>
          <div class="radio-group">
            <button class="rbtn ok" data-v="ok" title="ปกติ">✔</button>
            <button class="rbtn ng" data-v="ng" title="ไม่ปกติ">✖</button>
            <button class="rbtn fixed" data-v="fixed" title="แก้ไขแล้ว">🔧</button>
          </div>
        </div>
        <div class="ng-zone" id="ng-zone-${idx}">
          <div class="ng-zone-title">⚠ รายละเอียดความผิดปกติ</div>
          <textarea class="ng-note-input" id="ng-note-${idx}" placeholder="ระบุรายละเอียด..."></textarea>
          <div class="photo-row" id="photo-row-${idx}">
            <label class="btn-camera">
              <input type="file" accept="image/*" capture="environment" class="file-input" data-idx="${idx}">
              📷 ถ่ายรูป / เลือกรูป
            </label>
          </div>
        </div>`;
      wrap.appendChild(div);

      function setStatus(v) {
        checkState[idx].status = v;
        div.querySelectorAll('.rbtn').forEach(b => b.classList.toggle('active', b.dataset.v === v));
        const zone = $(`ng-zone-${idx}`);
        zone.classList.toggle('show', v === 'ng' || v === 'fixed');
        updateSvgPoint(item.id, v);
        updateStats();
      }

      div.querySelectorAll('.rbtn').forEach(btn => {
        btn.addEventListener('click', () => setStatus(btn.dataset.v));
      });

      // หัวข้อกรอกค่าตัวเลข: กรอกค่าแล้วระบบตัดสิน ผ่าน/ไม่ผ่าน อัตโนมัติจากช่วงเกณฑ์ที่ตั้งไว้
      // (ยังสามารถกดปุ่ม 🔧 "แก้ไขแล้ว" ทับได้ภายหลัง ถ้าแก้ไขปัญหาแล้วแต่ค่าที่วัดยังไม่อยู่ในช่วง)
      if (isNumeric) {
        $(`numval-${idx}`).addEventListener('input', e => {
          const raw = e.target.value;
          if (raw === '') {
            checkState[idx].value = null;
            checkState[idx].status = '';
            div.querySelectorAll('.rbtn').forEach(b => b.classList.remove('active'));
            $(`ng-zone-${idx}`).classList.remove('show');
            updateSvgPoint(item.id, '');
            updateStats();
            return;
          }
          const val = parseFloat(raw);
          if (isNaN(val)) return;
          checkState[idx].value = val;
          const inRange = (item.min == null || val >= item.min) && (item.max == null || val <= item.max);
          setStatus(inRange ? 'ok' : 'ng');
        });
      }

      $(`ng-note-${idx}`).addEventListener('input', e => { checkState[idx].note = e.target.value; });
      div.querySelector('.file-input').addEventListener('change', e => handlePhoto(e, idx));
    });
  }

  function updateSvgPoint(pointId, status) {
    const g = document.querySelector(`.svg-pt[data-point="${pointId}"]`);
    if (!g) return;
    g.classList.remove('status-ok','status-ng','status-fixed');
    if (status) g.classList.add(`status-${status}`);
  }

  function updateStats() {
    let ok = 0, ng = 0, pending = 0;
    checkState.forEach(i => {
      if (i.status === 'ok' || i.status === 'fixed') ok++;
      else if (i.status === 'ng') ng++;
      else pending++;
    });
    $('stat-ok').textContent = ok;
    $('stat-ng').textContent = ng;
    $('stat-pending').textContent = pending;
  }

  /* ── SVG click → scroll to checklist item ── */
  function bindSvgPoints() {
    document.querySelectorAll('.svg-pt').forEach(g => {
      g.addEventListener('click', () => {
        const pt = parseInt(g.dataset.point);
        const idx = checkState.findIndex(i => i.id === pt);
        if (idx < 0) return;
        document.querySelectorAll('.check-item').forEach(el => el.classList.remove('highlight'));
        const el = $('checklist-wrapper').querySelector(`.check-item[data-idx="${idx}"]`);
        if (el) { el.classList.add('highlight'); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        document.querySelectorAll('.svg-pt').forEach(p => p.classList.remove('active'));
        g.classList.add('active');
      });
    });
  }

  /* ══════════════════════════════════════
     PHOTOS
  ══════════════════════════════════════ */
  async function handlePhoto(e, idx) {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast('กรุณาเลือกไฟล์รูปภาพ', 'ng'); e.target.value = ''; return; }
    try {
      // ย่อขนาดรูปก่อนเก็บ (เหมือนรูปพื้นหลัง JIG) — ป้องกัน localStorage เต็มเร็ว
      // เพราะรูปหลักฐาน NG อาจมีได้หลายรูปต่อ 1 การตรวจ และตรวจหลายรายการ/วัน
      const dataUrl = await resizeImageToDataURL(file, 1000, 0.75);
      checkState[idx].photos.push(dataUrl);
      renderPhotos(idx);
    } catch (err) {
      console.error(err);
      toast('อัปโหลดรูปไม่สำเร็จ', 'ng');
    }
    e.target.value = '';
  }

  function renderPhotos(idx) {
    const row = $(`photo-row-${idx}`);
    row.querySelectorAll('.photo-thumb-wrap').forEach(el => el.remove());
    checkState[idx].photos.forEach((src, pi) => {
      const wrap = document.createElement('div');
      wrap.className = 'photo-thumb-wrap';
      wrap.innerHTML = `<img src="${escHtml(src)}" class="photo-thumb"><button class="photo-del" data-pi="${pi}">✕</button>`;
      row.insertBefore(wrap, row.querySelector('.btn-camera'));
      wrap.querySelector('.photo-thumb').addEventListener('click', () => openLightbox(src));
      wrap.querySelector('.photo-del').addEventListener('click', () => {
        checkState[idx].photos.splice(pi, 1); renderPhotos(idx);
      });
    });
  }

  /* ══════════════════════════════════════
     SUBMIT
  ══════════════════════════════════════ */
  function submitReport() {
    if (!selection.jigId) { toast('กรุณาเลือก JIG ก่อนบันทึก', 'ng'); return; }
    if (!$('inp-inspector').value.trim()) { toast('กรุณาระบุชื่อผู้ตรวจสอบ', 'ng'); $('inp-inspector').focus(); return; }
    if (!$('inp-date').value) { toast('กรุณาเลือกวันที่', 'ng'); return; }
    if (!$('inp-shift').value) { toast('กรุณาเลือกกะ', 'ng'); return; }
    const unchecked = checkState.filter(i => !i.status);
    if (unchecked.length) { toast(`ยังมี ${unchecked.length} รายการที่ยังไม่ตรวจ`, 'ng'); return; }

    const jig  = catalog.jigs.find(j => j.id === selection.jigId);
    const line = catalog.lines.find(l => l.id === selection.lineId);
    const dept = catalog.depts.find(d => d.id === selection.deptId);

    const record = {
      id:         genId(),
      timestamp:  new Date().toISOString(),
      deptId:     selection.deptId,
      deptName:   dept ? dept.name : '',
      lineId:     selection.lineId,
      lineName:   line ? line.name : '',
      jigId:      selection.jigId,
      jigName:    jig  ? jig.name  : '',
      jigDocNo:   jig  ? (jig.docNo || jig.id) : '',
      date:       $('inp-date').value,
      shift:      $('inp-shift').value,
      month:      $('inp-month').value,
      inspector:  $('inp-inspector').value.trim(),
      notes:      $('report-notes').value,
      items:      checkState.map(i => ({ id: i.id, label: i.label, status: i.status, note: i.note, photos: i.photos, value: i.value ?? null, unit: i.unit || '' })),
      sigInspector:  $('sig-inspector').value.trim(),
      sigSupervisor: $('sig-supervisor').value.trim(),
    };

    let hist = loadHistory();
    hist.unshift(record);
    if (hist.length > 100) hist = hist.slice(0, 100);
    if (saveHistory(hist)) {
      toast('✅ บันทึกผลการตรวจสอบสำเร็จ!', 'ok');
    }
  }

  /* ══════════════════════════════════════
     BACKUP — EXPORT / IMPORT
     ส่งออก/นำเข้าข้อมูลทั้งหมด (catalog + history) เป็นไฟล์ .json
     ใช้สำรองข้อมูลระหว่างที่ยังเก็บบน localStorage อยู่ (ยังไม่ได้ขึ้น Supabase)
  ══════════════════════════════════════ */
  function exportAllData() {
    try {
      const payload = {
        app: 'jig-inspection-dashboard',
        version: 2,
        exportedAt: new Date().toISOString(),
        catalog: catalog,
        history: loadHistory(),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `jig-backup-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('✅ Export ข้อมูลสำเร็จ', 'ok');
    } catch (err) {
      console.error('exportAllData error:', err);
      toast('Export ไม่สำเร็จ', 'ng');
    }
  }

  function importAllData(file) {
    if (!file.name.toLowerCase().endsWith('.json') && file.type !== 'application/json') {
      toast('กรุณาเลือกไฟล์ .json ที่ export จากระบบนี้เท่านั้น', 'ng');
      return;
    }
    const reader = new FileReader();
    reader.onload = ev => {
      let data;
      try {
        data = JSON.parse(ev.target.result);
      } catch (err) {
        toast('ไฟล์ไม่ใช่ JSON ที่ถูกต้อง', 'ng');
        return;
      }
      const cat = data && data.catalog;
      const hist = data && data.history;
      const validCatalog = cat && Array.isArray(cat.depts) && Array.isArray(cat.lines) && Array.isArray(cat.jigs);
      if (!validCatalog || !Array.isArray(hist)) {
        toast('รูปแบบไฟล์ไม่ถูกต้อง — ต้อง export มาจากระบบนี้เท่านั้น', 'ng');
        return;
      }
      if (!confirm(`นำเข้าข้อมูลนี้จะ "แทนที่" ข้อมูลปัจจุบันทั้งหมด (${cat.jigs.length} JIG, ${hist.length} ประวัติ)\nแนะนำให้ Export ข้อมูลปัจจุบันเก็บไว้ก่อน ต้องการดำเนินการต่อหรือไม่?`)) {
        return;
      }
      catalog = cat;
      if (!Array.isArray(catalog.templates)) catalog.templates = []; // เผื่อไฟล์สำรองเก่าที่ยังไม่มีเทมเพลต
      saveCatalog();
      const histOk = saveHistory(hist);
      selection = { deptId: null, lineId: null, jigId: null };
      hideInspectionCards();
      renderAdminLists();
      renderFilter();
      refreshDashboard();
      if (histOk) toast('✅ Import ข้อมูลสำเร็จ', 'ok');
    };
    reader.onerror = () => toast('อ่านไฟล์ไม่สำเร็จ', 'ng');
    reader.readAsText(file);
  }

  /* ══════════════════════════════════════
     ADMIN PANEL & LOGIN
  ══════════════════════════════════════ */
  let admLoggedIn = false;

  function bindAdminPanel() {
    $('adm-jig-search').addEventListener('input', filterJigList);

    $('btn-admin-toggle').addEventListener('click', () => {
      if (admLoggedIn) openPanel('admin-panel');
      else {
        $('admin-login-modal').classList.remove('hidden');
        $('inp-admin-pass').value = '';
        $('inp-admin-pass').focus();
        // ซ่อน hint "รหัสผ่านเริ่มต้น" ทันทีที่มีการตั้งรหัสผ่านใหม่แล้ว — กันข้อมูลเก่าค้างจอ
        $('hint-default-pass').classList.toggle('hidden', !!localStorage.getItem('jig_admin_pass'));
      }
    });
    
    // Login flow
    $('btn-close-login').addEventListener('click', () => $('admin-login-modal').classList.add('hidden'));
    $('admin-login-modal').addEventListener('click', e => { if (e.target === $('admin-login-modal')) $('admin-login-modal').classList.add('hidden'); });
    $('btn-login-submit').addEventListener('click', () => {
      const pass = $('inp-admin-pass').value;
      const expected = localStorage.getItem('jig_admin_pass') || 'admin1234';
      if (pass === expected) {
        admLoggedIn = true;
        $('admin-login-modal').classList.add('hidden');
        openPanel('admin-panel');
        toast('เข้าสู่ระบบสำเร็จ', 'ok');
      } else {
        toast('รหัสผ่านไม่ถูกต้อง', 'ng');
      }
    });

    $('btn-close-admin').addEventListener('click', () => closePanel('admin-panel'));

    /* Change Pass */
    $('btn-adm-pass').addEventListener('click', () => {
      const newPass = $('adm-new-pass').value.trim();
      if (!newPass || newPass.length < 4) { toast('รหัสผ่านใหม่ต้องยาว 4 ตัวขึ้นไป', 'ng'); return; }
      localStorage.setItem('jig_admin_pass', newPass);
      $('adm-new-pass').value = '';
      $('hint-default-pass').classList.add('hidden');
      toast('เปลี่ยนรหัสผ่าน Admin แล้ว', 'ok');
    });

    /* Add Dept */
    $('btn-adm-dept').addEventListener('click', () => {
      const id   = $('adm-dept-id').value.trim().toUpperCase();
      const name = $('adm-dept-name').value.trim();
      if (!id || !name) { toast('กรุณากรอกรหัสและชื่อแผนก', 'ng'); return; }
      if (catalog.depts.find(d => d.id === id)) { toast(`รหัส ${id} มีแล้ว`, 'ng'); return; }
      catalog.depts.push({ id, name });
      saveCatalog();
      $('adm-dept-id').value = ''; $('adm-dept-name').value = '';
      renderAdminLists(); renderFilter();
      toast(`เพิ่มแผนก "${name}" สำเร็จ`, 'ok');
    });

    /* Add Line */
    $('btn-adm-line').addEventListener('click', () => {
      const deptId = $('adm-line-dept').value;
      const id     = $('adm-line-id').value.trim();
      const name   = $('adm-line-name').value.trim();
      if (!deptId) { toast('กรุณาเลือกแผนก', 'ng'); return; }
      if (!id || !name) { toast('กรุณากรอกรหัสและชื่อ Line', 'ng'); return; }
      if (catalog.lines.find(l => l.id === id)) { toast(`รหัส ${id} มีแล้ว`, 'ng'); return; }
      catalog.lines.push({ id, deptId, name });
      saveCatalog();
      $('adm-line-id').value = ''; $('adm-line-name').value = '';
      renderAdminLists(); renderFilter();
      toast(`เพิ่ม Line "${name}" สำเร็จ`, 'ok');
    });

    /* Add JIG */
    $('btn-adm-jig').addEventListener('click', () => {
      const deptId = $('adm-jig-dept').value;
      const lineId = $('adm-jig-line').value;
      const id     = $('adm-jig-id').value.trim().toUpperCase();
      const name   = $('adm-jig-name').value.trim();
      if (!lineId) { toast('กรุณาเลือก Line', 'ng'); return; }
      if (!id || !name) { toast('กรุณากรอกรหัสและชื่อ JIG', 'ng'); return; }
      if (catalog.jigs.find(j => j.id === id)) { toast(`รหัส ${id} มีแล้ว`, 'ng'); return; }
      catalog.jigs.push({ id, lineId, name, docNo: id, checkpoints: [] });
      saveCatalog();
      $('adm-jig-id').value = ''; $('adm-jig-name').value = '';
      renderAdminLists(); renderFilter();
      toast(`เพิ่ม JIG "${name}" สำเร็จ`, 'ok');
    });

    /* JIG line filter on dept change */
    $('adm-jig-dept').addEventListener('change', () => {
      const deptId = $('adm-jig-dept').value;
      const lines  = catalog.lines.filter(l => l.deptId === deptId);
      $('adm-jig-line').innerHTML = '<option value="">Line</option>' +
        lines.map(l => `<option value="${escHtml(l.id)}">${escHtml(l.name)}</option>`).join('');
    });

    /* Checkpoint Management */
    $('adm-cp-jig').addEventListener('change', () => {
      const jid = $('adm-cp-jig').value;
      cpEditJigId = jid || null;
      if (!jid) { $('adm-cp-editor').classList.add('hidden'); return; }
      const jig = catalog.jigs.find(j => j.id === jid);
      if (!jig.checkpoints) jig.checkpoints = [];
      $('adm-cp-editor').classList.remove('hidden');
      renderCpBgControls(jid);
      renderAdmCpMap(jid);
      renderCpList(jid);
      renderTplSelect();
      renderTplPreview();
      renderTplList();
    });
    $('btn-adm-cp').addEventListener('click', () => {
      const jid = $('adm-cp-jig').value;
      if (!jid) return;
      const jig = catalog.jigs.find(j => j.id === jid);
      if (!jig.checkpoints) jig.checkpoints = [];
      const label = $('adm-cp-label').value.trim();
      const sub = $('adm-cp-sub').value.trim();
      const method = $('adm-cp-method').value.trim();
      if (!label) { toast('กรุณาใส่ชื่อจุดตรวจ', 'ng'); return; }
      const newId = jig.checkpoints.length ? Math.max(...jig.checkpoints.map(p=>p.id)) + 1 : 1;
      // วางจุดใหม่ไว้กลางแผนผังแบบสุ่มเล็กน้อยกันซ้อนทับ แล้วให้ผู้ใช้ลากจัดตำแหน่งเอง
      const x = 300 + Math.round(Math.random() * 60 - 30);
      const y = 170 + Math.round(Math.random() * 60 - 30);
      jig.checkpoints.push({ id: newId, label, sub, method, x, y });
      saveCatalog();
      $('adm-cp-label').value = ''; $('adm-cp-sub').value = ''; $('adm-cp-method').value = '';
      renderAdmCpMap(jid);
      renderCpList(jid);
      toast('เพิ่มจุดตรวจแล้ว — ลากจุดบนแผนผังเพื่อจัดตำแหน่ง', 'ok');
    });

    /* ── เทมเพลตหัวข้อตรวจสอบ — ใช้ซ้ำข้ามหลาย JIG โดยไม่ต้องพิมพ์ใหม่ทุกครั้ง ── */
    $('adm-tpl-select').addEventListener('change', () => renderTplPreview());

    $('btn-tpl-select-all').addEventListener('click', () => {
      document.querySelectorAll('#adm-tpl-items input[type=checkbox]').forEach(cb => cb.checked = true);
      updateTplPreviewCount();
    });
    $('btn-tpl-select-none').addEventListener('click', () => {
      document.querySelectorAll('#adm-tpl-items input[type=checkbox]').forEach(cb => cb.checked = false);
      updateTplPreviewCount();
    });

    $('btn-tpl-apply').addEventListener('click', () => {
      const jid = cpEditJigId;
      if (!jid) return;
      const tplId = $('adm-tpl-select').value;
      if (!tplId) { toast('กรุณาเลือกเทมเพลตก่อน', 'ng'); return; }
      const tpl = catalog.templates.find(t => t.id === tplId);
      if (!tpl) return;
      const checkedBoxes = Array.from(document.querySelectorAll('#adm-tpl-items input[type=checkbox]:checked'));
      if (!checkedBoxes.length) { toast('กรุณาเลือกอย่างน้อย 1 หัวข้อที่จะนำเข้า', 'ng'); return; }
      const selectedItems = checkedBoxes.map(cb => tpl.items[parseInt(cb.dataset.i, 10)]);

      const jig = catalog.jigs.find(j => j.id === jid);
      if (!jig.checkpoints) jig.checkpoints = [];
      let nextId = jig.checkpoints.length ? Math.max(...jig.checkpoints.map(p => p.id)) + 1 : 1;
      selectedItems.forEach((item, i) => {
        // กระจายตำแหน่งเริ่มต้นเป็นตารางกลางแผนผัง กันจุดซ้อนทับกันหมด — ลากจัดตำแหน่งจริงภายหลัง
        const col = i % 4, row = Math.floor(i / 4);
        const x = 180 + col * 90 + Math.round(Math.random() * 10 - 5);
        const y = 100 + row * 60 + Math.round(Math.random() * 10 - 5);
        jig.checkpoints.push({ id: nextId++, label: item.label, sub: item.sub, method: item.method, x, y });
      });
      saveCatalog();
      renderAdmCpMap(jid);
      renderCpList(jid);
      toast(`นำเข้า ${selectedItems.length} หัวข้อจากเทมเพลต "${tpl.name}" แล้ว — ลากจุดจัดตำแหน่ง`, 'ok');
      $('adm-tpl-select').value = '';
      renderTplPreview();
    });

    $('btn-tpl-save').addEventListener('click', () => {
      const jid = cpEditJigId;
      if (!jid) return;
      const jig = catalog.jigs.find(j => j.id === jid);
      const pts = jig.checkpoints || [];
      if (!pts.length) { toast('JIG นี้ยังไม่มีหัวข้อตรวจสอบให้บันทึกเป็นเทมเพลต', 'ng'); return; }
      const name = prompt('ตั้งชื่อเทมเพลต (เช่น "เช็คลิสต์มาตรฐาน BODY")', jig.name ? `เทมเพลตจาก ${jig.name}` : '');
      if (!name || !name.trim()) return;
      const items = pts.map(p => ({ label: p.label, sub: p.sub || '', method: p.method || '' }));
      catalog.templates.push({ id: 'tpl_' + Date.now(), name: name.trim(), items });
      saveCatalog();
      renderTplSelect();
      renderTplList();
      toast(`บันทึกเทมเพลต "${name.trim()}" แล้ว (${items.length} หัวข้อ)`, 'ok');
    });

    /* Background image upload / remove */
    $('adm-cp-bg-input').addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      if (!cpEditJigId) { toast('กรุณาเลือก JIG ก่อน', 'ng'); return; }
      if (!file.type.startsWith('image/')) { toast('กรุณาเลือกไฟล์รูปภาพ', 'ng'); e.target.value=''; return; }
      try {
        const dataUrl = await resizeImageToDataURL(file, 1000, 0.82);
        const jig = catalog.jigs.find(j => j.id === cpEditJigId);
        jig.bgImage = dataUrl;
        saveCatalog();
        renderCpBgControls(cpEditJigId);
        renderAdmCpMap(cpEditJigId);
        renderSvgMap(); // อัปเดตแผนผังในหน้าตรวจสอบด้วย ถ้ากำลังเปิด JIG นี้อยู่
        toast('อัปโหลดรูปพื้นหลังแล้ว', 'ok');
      } catch (err) {
        console.error(err);
        toast('อัปโหลดรูปไม่สำเร็จ', 'ng');
      }
      e.target.value = '';
    });
    $('btn-cp-bg-remove').addEventListener('click', () => {
      if (!cpEditJigId) return;
      const jig = catalog.jigs.find(j => j.id === cpEditJigId);
      delete jig.bgImage;
      saveCatalog();
      renderCpBgControls(cpEditJigId);
      renderAdmCpMap(cpEditJigId);
      renderSvgMap();
      toast('ลบรูปพื้นหลังแล้ว — กลับไปใช้แผนผังเริ่มต้น', 'ok');
    });

    /* Export / Import backup */
    $('btn-export-data').addEventListener('click', exportAllData);
    $('inp-import-data').addEventListener('change', e => {
      const file = e.target.files[0];
      if (file) importAllData(file);
      e.target.value = '';
    });

    /* Save All — ยืนยันการบันทึกอีกครั้ง (ข้อมูลถูก auto-save ทุกครั้งที่กด "เพิ่ม" อยู่แล้ว
       ปุ่มนี้เพิ่มมาเพื่อความมั่นใจของผู้ใช้ และตรวจสอบ round-trip ผ่าน localStorage จริง) */
    $('btn-save-all').addEventListener('click', () => {
      const btn = $('btn-save-all');
      const original = btn.textContent;
      saveCatalog();
      try {
        const raw = localStorage.getItem(SK.catalog);
        const roundTrip = raw && JSON.parse(raw);
        const ok = !!roundTrip && roundTrip.jigs.length === catalog.jigs.length
          && roundTrip.lines.length === catalog.lines.length
          && roundTrip.depts.length === catalog.depts.length;
        if (ok) {
          toast(`✅ บันทึกข้อมูลทั้งหมดแล้ว (${catalog.depts.length} แผนก, ${catalog.lines.length} Line, ${catalog.jigs.length} JIG)`, 'ok');
          btn.textContent = '✅ บันทึกแล้ว';
        } else {
          toast('บันทึกไม่สำเร็จ — พื้นที่จัดเก็บอาจเต็ม กรุณาลองใหม่', 'ng');
          btn.textContent = '⚠️ บันทึกไม่สำเร็จ';
        }
      } catch (err) {
        console.error('btn-save-all error:', err);
        toast('บันทึกไม่สำเร็จ', 'ng');
        btn.textContent = '⚠️ บันทึกไม่สำเร็จ';
      }
      setTimeout(() => { btn.textContent = original; }, 2000);
    });

    /* Seed demo */
    $('btn-seed-demo').addEventListener('click', () => {
      const keepTemplates = catalog.templates || [];
      catalog = JSON.parse(JSON.stringify(DEMO_CATALOG));
      catalog.templates = keepTemplates; // เทมเพลตหัวข้อตรวจสอบไม่ผูกกับชุดข้อมูลสาธิต เก็บไว้ข้ามการโหลดใหม่
      saveCatalog(); renderAdminLists(); renderFilter();
      toast('โหลดข้อมูล JIG ทั้งหมดสำเร็จ', 'ok');
    });
    
    $('btn-seed-history').addEventListener('click', () => {
      if (!catalog.jigs.length) { toast('ต้องมี JIG ในระบบก่อนสร้างประวัติ', 'ng'); return; }
      generateMockHistory();
      toast('สร้าง Mock History 100 รายการสำเร็จ!', 'ok');
      refreshDashboard();
    });

    /* Clear all */
    $('btn-clear-all').addEventListener('click', () => {
      if (!confirm('ลบข้อมูลทั้งหมด (catalog + history)?')) return;
      catalog = { depts: [], lines: [], jigs: [], templates: [] };
      saveCatalog(); saveHistory([]);
      selection = { deptId: null, lineId: null, jigId: null };
      hideInspectionCards(); renderAdminLists(); renderFilter();
      refreshDashboard();
      toast('ล้างข้อมูลทั้งหมดแล้ว', 'ng');
    });

    renderAdminLists();
  }

  function renderTplSelect() {
    const sel = $('adm-tpl-select');
    const cur = sel.value;
    sel.innerHTML = '<option value="">เลือกเทมเพลตที่จะนำเข้า...</option>' +
      catalog.templates.map(t => `<option value="${escHtml(t.id)}">${escHtml(t.name)} (${t.items.length} หัวข้อ)</option>`).join('');
    if (catalog.templates.some(t => t.id === cur)) sel.value = cur;
  }

  /* ── แสดงรายการหัวข้อในเทมเพลตที่เลือก พร้อม checkbox ให้เลือกเฉพาะหัวข้อที่ต้องการนำเข้า
     (บางหัวข้อในเทมเพลตอาจไม่ตรงกับ JIG นี้ ไม่จำเป็นต้องนำเข้าทั้งหมด) ── */
  function renderTplPreview() {
    const tplId = $('adm-tpl-select').value;
    const box = $('adm-tpl-preview');
    if (!tplId) { box.classList.add('hidden'); return; }
    const tpl = catalog.templates.find(t => t.id === tplId);
    if (!tpl) { box.classList.add('hidden'); return; }

    box.classList.remove('hidden');
    $('adm-tpl-items').innerHTML = tpl.items.map((item, i) => `
      <label class="tpl-check-row">
        <input type="checkbox" data-i="${i}" checked>
        <span>
          <div>${escHtml(item.label)}</div>
          ${(item.sub || item.method) ? `<div class="tpl-check-sub">${escHtml(item.sub || '')}${item.sub && item.method ? ' — ' : ''}${escHtml(item.method || '')}</div>` : ''}
        </span>
      </label>`).join('');

    document.querySelectorAll('#adm-tpl-items input[type=checkbox]').forEach(cb => {
      cb.addEventListener('change', updateTplPreviewCount);
    });
    updateTplPreviewCount();
  }

  function updateTplPreviewCount() {
    const total = document.querySelectorAll('#adm-tpl-items input[type=checkbox]').length;
    const checked = document.querySelectorAll('#adm-tpl-items input[type=checkbox]:checked').length;
    $('tpl-preview-count').textContent = `เลือก ${checked}/${total} หัวข้อ`;
  }

  function renderTplList() {
    const list = $('adm-tpl-list');
    if (!catalog.templates.length) {
      list.innerHTML = '<div style="font-size:11px;color:var(--text-muted)">ยังไม่มีเทมเพลต — เพิ่มหัวข้อให้ JIG นี้ก่อน แล้วกด "บันทึกหัวข้อของ JIG นี้เป็นเทมเพลตใหม่"</div>';
      return;
    }
    list.innerHTML = catalog.templates.map(t => `
      <div class="adm-item" style="padding:6px;">
        <div class="adm-item-info">
          <span class="tpl-item-name">${escHtml(t.name)}</span><span class="tpl-item-count">${t.items.length} หัวข้อ</span>
        </div>
        <button class="adm-item-del btn-del-tpl" data-tid="${escHtml(t.id)}">🗑</button>
      </div>`).join('');

    document.querySelectorAll('.btn-del-tpl').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = catalog.templates.find(x => x.id === btn.dataset.tid);
        if (!t) return;
        if (!confirm(`ลบเทมเพลต "${t.name}" หรือไม่? (ไม่กระทบหัวข้อที่นำเข้าไปยัง JIG ต่างๆ แล้ว)`)) return;
        catalog.templates = catalog.templates.filter(x => x.id !== t.id);
        saveCatalog();
        renderTplSelect();
        renderTplPreview();
        renderTplList();
        toast('ลบเทมเพลตแล้ว', 'ok');
      });
    });
  }

  function renderCpList(jid) {
    const jig = catalog.jigs.find(j => j.id === jid);
    const pts = jig.checkpoints || [];
    $('adm-cp-list').innerHTML = pts.length ? pts.map((p, i) => `
      <div class="adm-item" style="padding:6px; margin-bottom:4px">
        <div class="adm-item-info">
          <div style="font-size:12px"><strong>${i + 1}.</strong> ${escHtml(p.label)} <span style="font-size:10px; color:var(--text-muted)">(X:${p.x}, Y:${p.y})</span>
            ${p.type === 'numeric' ? `<span class="cp-numeric-badge">🔢 ${p.min}-${p.max}${p.unit ? ' ' + escHtml(p.unit) : ''}</span>` : ''}
          </div>
        </div>
        <div style="display:flex; gap:2px; align-items:center;">
          <div style="display:flex; flex-direction:column;">
            <button class="adm-item-order btn-cp-up" data-jid="${escHtml(jid)}" data-idx="${i}" title="เลื่อนขึ้น" ${i === 0 ? 'disabled' : ''}>▲</button>
            <button class="adm-item-order btn-cp-down" data-jid="${escHtml(jid)}" data-idx="${i}" title="เลื่อนลง" ${i === pts.length - 1 ? 'disabled' : ''}>▼</button>
          </div>
          <button class="adm-item-cfg btn-edit-cp" data-jid="${escHtml(jid)}" data-idx="${i}" title="แก้ไขหัวข้อ">✏️</button>
          <button class="adm-item-cfg btn-cfg-numeric" data-jid="${escHtml(jid)}" data-idx="${i}" title="${p.type === 'numeric' ? 'เปลี่ยนกลับเป็น Pass/Fail' : 'ตั้งเป็นหัวข้อกรอกค่าตัวเลข'}">🔢</button>
          <button class="adm-item-del btn-del-cp" data-jid="${escHtml(jid)}" data-idx="${i}">🗑</button>
        </div>
      </div>`).join('') : '<div style="font-size:11px;color:var(--text-muted)">ยังไม่มีจุดตรวจ ใช้ค่าเริ่มต้น (10 จุด)</div>';

    document.querySelectorAll('.btn-del-cp').forEach(btn => {
      btn.addEventListener('click', () => {
        const j = catalog.jigs.find(x => x.id === btn.dataset.jid);
        j.checkpoints.splice(btn.dataset.idx, 1);
        saveCatalog();
        renderCpList(btn.dataset.jid);
        renderAdmCpMap(btn.dataset.jid);
        toast('ลบจุดตรวจแล้ว', 'ok');
      });
    });

    document.querySelectorAll('.btn-cfg-numeric').forEach(btn => {
      btn.addEventListener('click', () => configureNumericCheckpoint(btn.dataset.jid, parseInt(btn.dataset.idx, 10)));
    });

    document.querySelectorAll('.btn-edit-cp').forEach(btn => {
      btn.addEventListener('click', () => editCheckpoint(btn.dataset.jid, parseInt(btn.dataset.idx, 10)));
    });

    document.querySelectorAll('.btn-cp-up').forEach(btn => {
      btn.addEventListener('click', () => moveCheckpoint(btn.dataset.jid, parseInt(btn.dataset.idx, 10), -1));
    });
    document.querySelectorAll('.btn-cp-down').forEach(btn => {
      btn.addEventListener('click', () => moveCheckpoint(btn.dataset.jid, parseInt(btn.dataset.idx, 10), 1));
    });
  }

  /* ── แก้ไขชื่อ/เกณฑ์/วิธีตรวจของจุดตรวจที่มีอยู่แล้ว (ไม่ต้องลบแล้วเพิ่มใหม่ ตำแหน่ง X,Y ยังอยู่เหมือนเดิม) ── */
  function editCheckpoint(jid, idx) {
    const jig = catalog.jigs.find(j => j.id === jid);
    const p = jig.checkpoints[idx];
    if (!p) return;

    const label = prompt('ชื่อจุด', p.label);
    if (label === null) return;
    if (!label.trim()) { toast('ชื่อจุดห้ามว่าง', 'ng'); return; }
    const sub = prompt('เกณฑ์', p.sub || '');
    if (sub === null) return;
    const method = prompt('วิธีตรวจ', p.method || '');
    if (method === null) return;

    p.label = label.trim(); p.sub = sub.trim(); p.method = method.trim();
    saveCatalog();
    renderCpList(jid);
    renderAdmCpMap(jid);
    if (selection.jigId === jid) renderSvgMap(); // sync กับหน้าตรวจสอบถ้าเปิด JIG เดียวกันอยู่
    toast(`แก้ไข "${p.label}" แล้ว`, 'ok');
  }

  /* ── เลื่อนลำดับจุดตรวจขึ้น/ลง — สลับตำแหน่งใน array (id เดิมของแต่ละจุดไม่เปลี่ยน
     ใช้แค่ผูกตำแหน่งบนแผนผังเท่านั้น เลขที่แสดง 1,2,3... จะเรียงตามลำดับใหม่อัตโนมัติ) ── */
  function moveCheckpoint(jid, idx, dir) {
    const jig = catalog.jigs.find(j => j.id === jid);
    const pts = jig.checkpoints;
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= pts.length) return;
    [pts[idx], pts[newIdx]] = [pts[newIdx], pts[idx]];
    saveCatalog();
    renderCpList(jid);
    renderAdmCpMap(jid);
    if (selection.jigId === jid) renderSvgMap();
  }

  /* ── ตั้งค่าหัวข้อตรวจให้เป็นแบบ "กรอกค่าตัวเลข" พร้อมช่วงที่ยอมรับได้ (min-max)
     แทนการกดปุ่ม ✔/✖/🔧 ปกติ — ใช้กับหัวข้อวัดค่า เช่น แรงดันลม, แรงบิด, ระยะห่าง ── */
  function configureNumericCheckpoint(jid, idx) {
    const jig = catalog.jigs.find(j => j.id === jid);
    const p = jig.checkpoints[idx];
    if (!p) return;

    if (p.type === 'numeric') {
      if (!confirm(`เปลี่ยน "${p.label}" กลับเป็นแบบ ปกติ/ไม่ปกติ (Pass/Fail) แทนการกรอกตัวเลขหรือไม่?`)) return;
      delete p.type; delete p.min; delete p.max; delete p.unit;
      saveCatalog();
      renderCpList(jid);
      toast(`เปลี่ยน "${p.label}" กลับเป็นแบบ Pass/Fail แล้ว`, 'ok');
      return;
    }

    const minStr = prompt(`ค่าต่ำสุดที่ยอมรับได้สำหรับ "${p.label}" (เช่น 0.4)`, p.min ?? '');
    if (minStr === null) return;
    const maxStr = prompt(`ค่าสูงสุดที่ยอมรับได้ (เช่น 0.6)`, p.max ?? '');
    if (maxStr === null) return;
    const unit = prompt(`หน่วย (เช่น Mpa, mm, kg — เว้นว่างได้)`, p.unit ?? '');
    if (unit === null) return;

    const min = parseFloat(minStr), max = parseFloat(maxStr);
    if (isNaN(min) || isNaN(max)) { toast('กรุณาใส่ค่าต่ำสุด/สูงสุดเป็นตัวเลข', 'ng'); return; }
    if (min > max) { toast('ค่าต่ำสุดต้องไม่มากกว่าค่าสูงสุด', 'ng'); return; }

    p.type = 'numeric'; p.min = min; p.max = max; p.unit = unit.trim();
    saveCatalog();
    renderCpList(jid);
    toast(`ตั้งค่า "${p.label}" เป็นหัวข้อกรอกตัวเลข (${min}-${max}${unit.trim() ? ' ' + unit.trim() : ''}) แล้ว`, 'ok');
  }

  /* ── สถานะรูปพื้นหลังใน Admin ── */
  function renderCpBgControls(jid) {
    const jig = catalog.jigs.find(j => j.id === jid);
    if (!jig) return;
    const hasImg = !!jig.bgImage;
    $('btn-cp-bg-remove').classList.toggle('hidden', !hasImg);
    $('cp-bg-status').textContent = hasImg
      ? '✅ มีรูปพื้นหลังกำหนดเองแล้ว — ใช้แสดงในหน้าตรวจสอบของ JIG นี้'
      : 'ℹ️ ยังไม่มีรูปพื้นหลัง — ใช้แผนผังเริ่มต้น';
  }

  /* ── วาดแผนผังลากจุดใน Admin Panel ── */
  function renderAdmCpMap(jid) {
    const jig = catalog.jigs.find(j => j.id === jid);
    if (!jig) return;
    const bgImg = $('adm-cp-bg-image');
    if (jig.bgImage) { bgImg.setAttribute('href', jig.bgImage); bgImg.style.display = ''; }
    else { bgImg.style.display = 'none'; }

    const pts = jig.checkpoints || [];
    const group = $('adm-cp-points-group');
    group.innerHTML = pts.map((p, i) => `
      <g class="svg-pt cp-drag-pt" data-id="${p.id}" transform="translate(${p.x},${p.y})">
        <circle class="pt-pulse" r="14"/><circle class="pt-core" r="8"/><text y="4" class="pt-label">${i + 1}</text>
      </g>`).join('');
    bindCpDrag(jid);
  }

  /* ── ลากจุดเพื่อจัดตำแหน่ง (Pointer Events) ── */
  function bindCpDrag(jid) {
    const svg = $('adm-cp-map');
    svg.querySelectorAll('.cp-drag-pt').forEach(g => {
      g.addEventListener('pointerdown', e => {
        e.preventDefault();
        g.setPointerCapture(e.pointerId);
        g.classList.add('dragging');
        let lastX = null, lastY = null;

        const toSvgPoint = ev => {
          const pt = svg.createSVGPoint();
          pt.x = ev.clientX; pt.y = ev.clientY;
          const loc = pt.matrixTransform(svg.getScreenCTM().inverse());
          return {
            x: Math.max(10, Math.min(590, Math.round(loc.x))),
            y: Math.max(10, Math.min(330, Math.round(loc.y)))
          };
        };
        const onMove = ev => {
          const { x, y } = toSvgPoint(ev);
          g.setAttribute('transform', `translate(${x},${y})`);
          lastX = x; lastY = y;
        };
        const onUp = () => {
          svg.removeEventListener('pointermove', onMove);
          svg.removeEventListener('pointerup', onUp);
          g.classList.remove('dragging');
          if (lastX !== null) {
            const jig = catalog.jigs.find(j => j.id === jid);
            const cp = jig && jig.checkpoints.find(p => p.id === parseInt(g.dataset.id));
            if (cp) {
              cp.x = lastX; cp.y = lastY;
              saveCatalog();
              renderCpList(jid);
              if (selection.jigId === jid) renderSvgMap(); // sync กับหน้าตรวจสอบถ้าเปิด JIG เดียวกันอยู่
            }
          }
        };
        svg.addEventListener('pointermove', onMove);
        svg.addEventListener('pointerup', onUp);
      });
    });
  }

  /* ── กรองรายการ JIG ตามคำค้นหา (ชื่อ/รหัส/Line) — ซ่อนแถวที่ไม่ตรง และซ่อนหัวข้อกลุ่มถ้าไม่เหลือ JIG ที่ตรงในกลุ่มนั้น ── */
  function filterJigList() {
    const searchInput = $('adm-jig-search');
    if (!searchInput) return;
    const q = searchInput.value.trim().toLowerCase();
    const rows = document.querySelectorAll('#adm-jig-list .adm-item[data-search]');
    rows.forEach(row => {
      row.classList.toggle('hidden', !!q && !row.dataset.search.includes(q));
    });
    document.querySelectorAll('#adm-jig-list .adm-group-header').forEach(header => {
      const groupKey = header.dataset.group;
      const hasVisible = Array.from(document.querySelectorAll(`#adm-jig-list .adm-item[data-group="${CSS.escape(groupKey)}"]`))
        .some(row => !row.classList.contains('hidden'));
      header.classList.toggle('hidden', !hasVisible);
    });
    const countEl = $('adm-jig-count');
    if (countEl) {
      const visible = Array.from(rows).filter(r => !r.classList.contains('hidden')).length;
      countEl.textContent = q ? `${visible}/${rows.length} JIG` : `${rows.length} JIG`;
    }
  }

  function renderAdminLists() {
    /* Dept list */
    $('adm-dept-list').innerHTML = catalog.depts.length
      ? catalog.depts.map(d => `
          <div class="adm-item">
            <div class="adm-item-info">
              <div>${escHtml(d.name)}</div>
              <div class="adm-item-code">${escHtml(d.id)}</div>
            </div>
            <button class="adm-item-del" data-dtype="dept" data-id="${escHtml(d.id)}">🗑</button>
          </div>`).join('')
      : '<div class="adm-item" style="color:var(--text-muted);font-style:italic">ยังไม่มีแผนก</div>';

    /* Line list */
    $('adm-line-list').innerHTML = catalog.lines.length
      ? catalog.lines.map(l => {
          const dept = catalog.depts.find(d => d.id === l.deptId);
          return `<div class="adm-item">
            <div class="adm-item-info">
              <div>${escHtml(l.name)}</div>
              <div class="adm-item-code">${escHtml(l.id)} · ${escHtml(dept ? dept.name : l.deptId)}</div>
            </div>
            <button class="adm-item-del" data-dtype="line" data-id="${escHtml(l.id)}">🗑</button>
          </div>`;}).join('')
      : '<div class="adm-item" style="color:var(--text-muted);font-style:italic">ยังไม่มี Line</div>';

    /* JIG list — จัดกลุ่มตาม Line และรองรับค้นหา (จำเป็นเมื่อมี JIG หลายร้อยตัว) */
    if (!catalog.jigs.length) {
      $('adm-jig-list').innerHTML = '<div class="adm-item" style="color:var(--text-muted);font-style:italic">ยังไม่มี JIG</div>';
    } else {
      const jigsSorted = [...catalog.jigs].sort((a, b) => {
        const la = catalog.lines.find(l => l.id === a.lineId);
        const lb = catalog.lines.find(l => l.id === b.lineId);
        return (la ? la.name : 'ไม่ระบุ Line').localeCompare(lb ? lb.name : 'ไม่ระบุ Line', 'th');
      });
      let html = '', lastLineId = '\u0000';
      jigsSorted.forEach(j => {
        const line = catalog.lines.find(l => l.id === j.lineId);
        const groupKey = j.lineId || '__none__';
        if (groupKey !== lastLineId) {
          html += `<div class="adm-group-header" data-group="${escHtml(groupKey)}">📍 ${escHtml(line ? line.name : 'ไม่ระบุ Line')}</div>`;
          lastLineId = groupKey;
        }
        const searchText = `${j.name} ${j.id} ${line ? line.name : ''}`.toLowerCase();
        html += `<div class="adm-item" data-group="${escHtml(groupKey)}" data-search="${escHtml(searchText)}">
          <div class="adm-item-info">
            <div>🔧 ${escHtml(j.name)}</div>
            <div class="adm-item-code">${escHtml(j.id)} · ${escHtml(line ? line.name : j.lineId)}</div>
          </div>
          <button class="adm-item-del" data-dtype="jig" data-id="${escHtml(j.id)}">🗑</button>
        </div>`;
      });
      $('adm-jig-list').innerHTML = html;
    }
    filterJigList(); // เผื่อผู้ใช้พิมพ์ค้นหาค้างอยู่ตอนที่ list ถูก re-render (เช่น หลังลบ)

    /* Delete buttons */
    document.querySelectorAll('.adm-item-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const { dtype, id } = btn.dataset;
        if (dtype === 'dept') {
          catalog.lines = catalog.lines.filter(l => l.deptId !== id);
          catalog.jigs  = catalog.jigs.filter(j => {
            const l = catalog.lines.find(x => x.id === j.lineId); return l;
          });
          catalog.depts = catalog.depts.filter(d => d.id !== id);
        } else if (dtype === 'line') {
          catalog.jigs  = catalog.jigs.filter(j => j.lineId !== id);
          catalog.lines = catalog.lines.filter(l => l.id !== id);
        } else if (dtype === 'jig') {
          catalog.jigs = catalog.jigs.filter(j => j.id !== id);
        }
        saveCatalog(); renderAdminLists(); renderFilter();
        toast('ลบสำเร็จ', 'ok');
      });
    });

    /* Refresh selects in admin */
    $('adm-line-dept').innerHTML = '<option value="">เลือกแผนก</option>' +
      catalog.depts.map(d => `<option value="${escHtml(d.id)}">${escHtml(d.name)}</option>`).join('');
    $('adm-jig-dept').innerHTML = '<option value="">แผนก</option>' +
      catalog.depts.map(d => `<option value="${escHtml(d.id)}">${escHtml(d.name)}</option>`).join('');
    $('adm-jig-line').innerHTML = '<option value="">Line</option>';
    
    // Checkpoints editor dropdown
    $('adm-cp-jig').innerHTML = '<option value="">เลือก JIG เพื่อแก้ไขจุดตรวจ...</option>' + 
      catalog.jigs.map(j => `<option value="${escHtml(j.id)}">${escHtml(j.id)} - ${escHtml(j.name)}</option>`).join('');
  }

  /* ══════════════════════════════════════
     HISTORY PANEL
  ══════════════════════════════════════ */
  function bindHistoryPanel() {
    $('tab-history').addEventListener('click', () => { openPanel('history-panel'); populateHistoryPanel(); });
    $('btn-close-hist').addEventListener('click', () => closePanel('history-panel'));
    $('btn-hf-apply').addEventListener('click', populateHistoryPanel);
    $('btn-hf-clear').addEventListener('click', () => {
      $('hf-start').value = ''; $('hf-end').value = '';
      $('hf-dept').value = ''; $('hf-shift').value = '';
      populateHistoryPanel();
    });
    $('btn-hf-pdf').addEventListener('click', () => {
      const hist = loadHistory();
      if (!hist.length) { toast('ไม่มีประวัติให้ส่งออก', 'ng'); return; }
      generatePdf(hist[0]);
    });
  }

  function populateHistoryPanel() {
    // Populate dept filter
    const deptSel = $('hf-dept');
    deptSel.innerHTML = '<option value="">ทั้งหมด</option>' +
      catalog.depts.map(d => `<option value="${escHtml(d.id)}">${escHtml(d.name)}</option>`).join('');

    let hist = loadHistory();
    const start = $('hf-start').value;
    const end   = $('hf-end').value;
    const dept  = $('hf-dept').value;
    const shift = $('hf-shift').value;
    if (start) hist = hist.filter(h => h.date >= start);
    if (end)   hist = hist.filter(h => h.date <= end);
    if (dept)  hist = hist.filter(h => h.deptId === dept);
    if (shift) hist = hist.filter(h => h.shift === shift);

    const totalOk = hist.filter(h => h.items.every(i => i.status === 'ok' || i.status === 'fixed')).length;
    $('hist-summary').innerHTML = `
      <div class="hist-stat all"><span class="n">${hist.length}</span><span class="l">ทั้งหมด</span></div>
      <div class="hist-stat ok"><span class="n">${totalOk}</span><span class="l">ผ่าน</span></div>
      <div class="hist-stat ng"><span class="n">${hist.length - totalOk}</span><span class="l">มี NG</span></div>`;

    const list = $('hist-list');
    if (!hist.length) { list.innerHTML = '<div class="no-records">ไม่พบประวัติ</div>'; return; }
    list.innerHTML = hist.map(h => {
      const ngItems = h.items.filter(i => i.status === 'ng');
      const okCount = h.items.filter(i => i.status === 'ok' || i.status === 'fixed').length;
      const photos  = h.items.flatMap(i => i.photos || []);
      return `<div class="history-item">
        <div class="hi-path">${escHtml(h.deptName || '')}  ›  ${escHtml(h.lineName || '')}  ›  ${escHtml(h.jigName || '')}</div>
        <div class="hi-head">
          <div class="hi-meta"><strong>${escHtml(h.date)}</strong> · ${escHtml(h.shift)} · ผู้ตรวจ: ${escHtml(h.inspector)}</div>
          <div class="hi-badges">
            <span class="badge ok">OK ${okCount}</span>
            ${ngItems.length ? `<span class="badge ng">NG ${ngItems.length}</span>` : ''}
          </div>
        </div>
        ${ngItems.length ? `<div class="hi-details">NG: ${ngItems.map(i=>`ข้อ ${i.id}`).join(', ')}</div>` : ''}
        ${photos.length  ? `<div class="hi-photos">${photos.slice(0,4).map(p=>`<img src="${escHtml(p)}" class="hi-photo" data-src="${escHtml(p)}">`).join('')}</div>` : ''}
        ${(h.sigInspector||h.sigSupervisor) ? `<div class="hi-sigs" style="font-size:11px; color:var(--text-main); margin-top:6px; display:flex; gap:16px;">
          ${h.sigInspector?`<div><strong>ผู้ตรวจ:</strong> ${escHtml(h.sigInspector)}</div>`:''}
          ${h.sigSupervisor?`<div><strong>หัวหน้า:</strong> ${escHtml(h.sigSupervisor)}</div>`:''}
        </div>` : ''}
        <div class="hi-actions">
          <button class="hi-btn" data-pdf="${escHtml(h.id)}">📄 PDF</button>
          <button class="hi-btn del" data-del="${escHtml(h.id)}">🗑 ลบ</button>
        </div>
      </div>`;
    }).join('');

    // Bind dynamic buttons
    list.querySelectorAll('[data-pdf]').forEach(b => b.addEventListener('click', () => {
      const rec = loadHistory().find(h => String(h.id) === b.dataset.pdf);
      if (rec) generatePdf(rec);
    }));
    list.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
      if (!confirm('ลบรายการนี้?')) return;
      saveHistory(loadHistory().filter(h => String(h.id) !== b.dataset.del));
      populateHistoryPanel(); toast('ลบแล้ว', 'ok');
    }));
    list.querySelectorAll('.hi-photo').forEach(img => {
      img.addEventListener('click', () => openLightbox(img.dataset.src));
    });
  }

  /* ══════════════════════════════════════
     PDF GENERATION (jsPDF + html2canvas)
     — jsPDF's built-in fonts (Helvetica) have no Thai
       glyphs, which is why Thai text used to render as
       garbled boxes. To fix this we build the report as
       real HTML (using the page's own Thai web fonts —
       Noto Sans Thai / Sarabun), rasterize it with
       html2canvas, then place that image into the PDF.
       This guarantees correct Thai rendering regardless
       of what fonts jsPDF ships with.
  ══════════════════════════════════════ */
  function statusLabel(status) {
    return status === 'ok' ? 'ผ่าน (OK)'
         : status === 'ng' ? 'ไม่ผ่าน (NG)'
         : status === 'fixed' ? 'แก้ไขแล้ว'
         : 'รอตรวจ';
  }
  function statusRowClass(status) {
    return status === 'ok' ? 'pdf-row-ok'
         : status === 'ng' ? 'pdf-row-ng'
         : status === 'fixed' ? 'pdf-row-fixed'
         : 'pdf-row-pending';
  }

  function buildPdfReportHtml(record) {
    const rows = record.items.map((item, i) => `
      <tr class="${statusRowClass(item.status)}">
        <td>${i + 1}</td>
        <td>${escHtml(item.label)}</td>
        <td>${item.value != null ? escHtml(String(item.value)) + (item.unit ? ' ' + escHtml(item.unit) : '') : ''}</td>
        <td>${statusLabel(item.status)}</td>
        <td>${item.note ? escHtml(item.note) : ''}</td>
      </tr>`).join('');

    return `
      <div class="pdf-title">JIG Inspection Report</div>
      <div class="pdf-subtitle">${escHtml(record.jigName)} | ${escHtml(record.jigDocNo)}</div>
      <div class="pdf-subtitle">${escHtml(record.deptName)} &gt; ${escHtml(record.lineName)}</div>
      <div class="pdf-meta-row">
        <span>ผู้ตรวจสอบ: ${escHtml(record.inspector)}</span>
        <span>วันที่: ${escHtml(record.date)}  กะ: ${escHtml(record.shift)}</span>
      </div>
      <table class="pdf-table">
        <thead>
          <tr><th style="width:6%">No</th><th style="width:38%">จุดตรวจสอบ</th><th style="width:14%">ค่าที่วัดได้</th><th style="width:18%">สถานะ</th><th style="width:24%">หมายเหตุ</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${record.notes ? `<div class="pdf-notes"><strong>หมายเหตุ:</strong> ${escHtml(record.notes)}</div>` : ''}
      <div class="pdf-sig-row">
        <div>
          <div>${record.sigInspector ? `( ${escHtml(record.sigInspector)} )` : '(\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0)'}</div>
          <div class="pdf-sig-line">ผู้ตรวจสอบ</div>
        </div>
        <div>
          <div>${record.sigSupervisor ? `( ${escHtml(record.sigSupervisor)} )` : '(\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0)'}</div>
          <div class="pdf-sig-line">หัวหน้างาน</div>
        </div>
      </div>`;
  }

  async function generatePdf(record) {
    if (!window.jspdf) { toast('jsPDF โหลดไม่สำเร็จ', 'ng'); return; }
    if (!window.html2canvas) { toast('html2canvas โหลดไม่สำเร็จ', 'ng'); return; }
    const { jsPDF } = window.jspdf;

    // Build the report off-screen as real HTML so the browser's
    // Thai web fonts are used for shaping/rendering.
    const container = document.createElement('div');
    container.className = 'pdf-export-root';
    container.innerHTML = buildPdfReportHtml(record);
    document.body.appendChild(container);

    // Make sure Thai web fonts are actually loaded before rasterizing,
    // otherwise html2canvas may capture a fallback font mid-swap.
    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
    } catch (e) { /* ignore */ }

    try {
      const canvas = await html2canvas(container, {
        scale: 2,
        backgroundColor: '#ffffff',
        useCORS: true
      });

      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const imgData = canvas.toDataURL('image/jpeg', 0.95);
      const imgW = pageW;
      const imgH = (canvas.height * imgW) / canvas.width;

      let heightLeft = imgH;
      let position = 0;
      doc.addImage(imgData, 'JPEG', 0, position, imgW, imgH);
      heightLeft -= pageH;

      while (heightLeft > 0) {
        position -= pageH;
        doc.addPage();
        doc.addImage(imgData, 'JPEG', 0, position, imgW, imgH);
        heightLeft -= pageH;
      }

      doc.save(`JIG_${record.jigId}_${record.date}_${record.shift}.pdf`);
      toast('📄 ส่งออก PDF สำเร็จ!', 'ok');
    } catch (err) {
      console.error('generatePdf error:', err);
      toast('สร้าง PDF ไม่สำเร็จ', 'ng');
    } finally {
      document.body.removeChild(container);
    }
  }

  /* ══════════════════════════════════════
     MOCK DATA GENERATOR
  ══════════════════════════════════════ */
  function generateMockHistory() {
    let hist = [];
    const now = new Date();
    const jigs = catalog.jigs;
    const inspectors = ['สมชาย', 'วิรัตน์', 'ณัฐพล', 'สุรชัย'];
    const shifts = ['เช้า (08:00-17:00)', 'ดึก (20:00-05:00)'];
    
    for (let i = 0; i < 100; i++) {
      const j = jigs[Math.floor(Math.random() * jigs.length)];
      if (!j) continue;
      const d = new Date(now.getTime() - Math.random() * 30 * 24 * 60 * 60 * 1000);
      const isNg = Math.random() < 0.15; // 15% NG rate
      
      const pts = j.checkpoints && j.checkpoints.length ? j.checkpoints : DEFAULT_ITEMS;
      const items = pts.map(pt => {
        let st = 'ok';
        if (isNg && Math.random() < 0.1) st = 'ng';
        return { id: pt.id, label: pt.label, status: st, note: st==='ng' ? 'พบความผิดปกติ' : '', photos: [] };
      });
      
      const l = catalog.lines.find(x => x.id === j.lineId);
      const dp = l ? catalog.depts.find(x => x.id === l.deptId) : null;
      
      hist.push({
        id: genId(),
        timestamp: d.toISOString(),
        deptId: dp ? dp.id : '',
        deptName: dp ? dp.name : '',
        lineId: l ? l.id : '',
        lineName: l ? l.name : '',
        jigId: j.id,
        jigName: j.name,
        jigDocNo: j.docNo || j.id,
        date: d.toISOString().slice(0, 10),
        shift: shifts[Math.floor(Math.random() * shifts.length)],
        month: d.toISOString().slice(0, 7),
        inspector: inspectors[Math.floor(Math.random() * inspectors.length)],
        notes: isNg ? 'พบ NG แจ้งซ่อมบำรุงแล้ว' : 'ปกติทุกจุด',
        items: items,
        sigInspector: 'ลายเซ็นจำลอง',
        sigSupervisor: ''
      });
    }
    
    // Sort by date desc
    hist.sort((a,b) => b.timestamp.localeCompare(a.timestamp));
    saveHistory(hist);
  }

  /* ══════════════════════════════════════
     PANEL HELPERS
  ══════════════════════════════════════ */
  function openPanel(id) {
    document.querySelectorAll('.side-panel').forEach(p => p.classList.remove('open'));
    $(id).classList.add('open');
    $('panel-overlay').classList.add('show');
  }
  function closePanel(id) {
    $(id).classList.remove('open');
    $('panel-overlay').classList.remove('show');
  }
  function bindPanelOverlay() {
    $('panel-overlay').addEventListener('click', () => {
      document.querySelectorAll('.side-panel').forEach(p => p.classList.remove('open'));
      $('panel-overlay').classList.remove('show');
    });
  }

  /* ══════════════════════════════════════
     ACTION BUTTONS
  ══════════════════════════════════════ */
  function bindActionButtons() {
    $('btn-submit').addEventListener('click', submitReport);
    $('btn-reset').addEventListener('click', () => {
      if (!confirm('ล้างผลการตรวจและเริ่มใหม่?')) return;
      initCheckState();
      renderChecklist();
      updateStats();
      $('inp-inspector').value = '';
      $('inp-date').value = new Date().toISOString().slice(0, 10);
      $('inp-shift').value = '';
      $('inp-month').value = '';
      $('report-notes').value = '';
      $('sig-inspector').value = '';
      $('sig-supervisor').value = '';
      toast('เริ่มต้นใหม่เรียบร้อย', 'ok');
    });
    // SVG points (bound after inspection cards shown)
    document.addEventListener('click', e => {
      const g = e.target.closest('.svg-pt');
      if (!g) return;
      const pt  = parseInt(g.dataset.point);
      const idx = checkState.findIndex(i => i.id === pt);
      if (idx < 0) return;
      document.querySelectorAll('.check-item').forEach(el => el.classList.remove('highlight'));
      const el = $('checklist-wrapper') && $('checklist-wrapper').querySelector(`.check-item[data-idx="${idx}"]`);
      if (el) { el.classList.add('highlight'); el.scrollIntoView({ behavior:'smooth', block:'center' }); }
      document.querySelectorAll('.svg-pt').forEach(p => p.classList.remove('active'));
      g.classList.add('active');
    });
  }

  /* ══════════════════════════════════════
     THEME TOGGLE
     ค่าเริ่มต้นคือธีมสว่าง — จำธีมที่ผู้ใช้เลือกไว้ล่าสุดไว้ใน localStorage
  ══════════════════════════════════════ */
  const THEME_KEY = 'jig_theme';

  function syncThemeIcons() {
    const current = document.documentElement.getAttribute('data-theme');
    qs('.icon-moon').style.display = current === 'dark'  ? '' : 'none';
    qs('.icon-sun').style.display  = current === 'light' ? '' : 'none';
  }

  function bindThemeToggle() {
    syncThemeIcons(); // ให้ไอคอนตรงกับธีมจริงตอนโหลดหน้า (เผื่อเคยตั้งเป็น dark ไว้)
    $('theme-toggle').addEventListener('click', () => {
      const html = document.documentElement;
      const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      html.setAttribute('data-theme', next);
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
      syncThemeIcons();
    });
  }

  /* ══════════════════════════════════════
     LIGHTBOX
  ══════════════════════════════════════ */
  function bindLightbox() {
    const lb = $('lightbox');
    lb.querySelector('.lightbox-close').addEventListener('click', closeLightbox);
    lb.addEventListener('click', e => { if (e.target === lb) closeLightbox(); });
  }
  function openLightbox(src) { $('lightbox-img').src = src; $('lightbox').classList.add('open'); }
  function closeLightbox() { $('lightbox').classList.remove('open'); $('lightbox-img').src = ''; }

  /* ══════════════════════════════════════
     TOAST
  ══════════════════════════════════════ */
  function toast(msg, type) {
    const el = $('toast');
    el.textContent = msg;
    el.className = `toast show ${type || 'ok'}`;
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 3200);
  }

  /* ══════════════════════════════════════
     LIVE CLOCK (Dashboard)
  ══════════════════════════════════════ */
  function startDashClock() {
    const dateEl = $('dash-clock-date');
    const timeEl = $('dash-clock-time');
    if (!dateEl || !timeEl) return;
    function tick() {
      const now = new Date();
      dateEl.textContent = now.toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      timeEl.textContent = `${hh}:${mm}:${ss}`;
    }
    tick();
    setInterval(tick, 1000);
  }

  /* ══════════════════════════════════════
     ADMIN PANEL — DRAG TO RESIZE
     ลากขอบซ้ายของ Admin Panel เพื่อขยาย/หดขนาดหน้าต่าง
     จำขนาดที่ตั้งไว้ล่าสุดไว้ใน localStorage (เฉพาะจอที่กว้างพอ)
  ══════════════════════════════════════ */
  const PANEL_WIDTH_KEY = 'jig_admin_panel_width';
  const PANEL_MIN_W = 320;

  function initPanelResize() {
    const panel  = $('admin-panel');
    const handle = $('admin-resize-handle');
    if (!panel || !handle) return;

    const maxWidth = () => Math.min(900, window.innerWidth - 40);

    // คืนค่าความกว้างที่เคยตั้งไว้ (เฉพาะจอ desktop/tablet ที่กว้างพอ — บนมือถือให้เต็มจอเสมอ)
    if (window.innerWidth > 640) {
      const saved = parseInt(localStorage.getItem(PANEL_WIDTH_KEY), 10);
      if (saved && saved >= PANEL_MIN_W) {
        panel.style.width = Math.min(saved, maxWidth()) + 'px';
      }
    }

    let dragging = false, startX = 0, startWidth = 0;

    function beginDrag(clientX) {
      dragging = true;
      startX = clientX;
      startWidth = panel.getBoundingClientRect().width;
      handle.classList.add('dragging');
      panel.classList.add('resizing');
      document.body.style.userSelect = 'none';
    }
    function moveDrag(clientX) {
      if (!dragging) return;
      // panel ยึดขอบขวาจอ — ลากขอบซ้ายไปทางซ้าย (clientX ลดลง) = ขยายกว้างขึ้น
      const delta = startX - clientX;
      const newWidth = Math.max(PANEL_MIN_W, Math.min(maxWidth(), startWidth + delta));
      panel.style.width = newWidth + 'px';
    }
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      panel.classList.remove('resizing');
      document.body.style.userSelect = '';
      localStorage.setItem(PANEL_WIDTH_KEY, Math.round(panel.getBoundingClientRect().width));
    }

    handle.addEventListener('mousedown', e => { beginDrag(e.clientX); e.preventDefault(); });
    document.addEventListener('mousemove', e => moveDrag(e.clientX));
    document.addEventListener('mouseup', endDrag);

    handle.addEventListener('touchstart', e => beginDrag(e.touches[0].clientX), { passive: true });
    document.addEventListener('touchmove', e => { if (dragging) moveDrag(e.touches[0].clientX); }, { passive: true });
    document.addEventListener('touchend', endDrag);

    // ดับเบิลคลิกที่ขอบ = รีเซ็ตกลับขนาดเริ่มต้น
    handle.addEventListener('dblclick', () => {
      panel.style.width = '';
      localStorage.removeItem(PANEL_WIDTH_KEY);
    });
  }

  /* ══════════════════════════════════════
     CHANGE JIG BUTTON + INIT
  ══════════════════════════════════════ */
  document.addEventListener('DOMContentLoaded', () => {
    $('btn-change-jig').addEventListener('click', () => {
      selection.jigId = null;
      hideInspectionCards();
      renderFilter();
      $('filter-card').scrollIntoView({ behavior:'smooth', block:'start' });
    });

    bindTabNav();
    bindDashboard();
    bindAiPanel();
    startDashClock();
    initPanelResize();
    init();
  });

  /* ══════════════════════════════════════
     TAB NAVIGATION
  ══════════════════════════════════════ */
  function bindTabNav() {
    document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        document.querySelectorAll('.tab-btn[data-tab]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        $('view-inspect').classList.toggle('hidden', tab !== 'inspect');
        $('view-dashboard').classList.toggle('hidden', tab !== 'dashboard');
        if (tab === 'dashboard') refreshDashboard();
      });
    });
  }

  /* ══════════════════════════════════════
     DASHBOARD
  ══════════════════════════════════════ */
  let charts = {};
  let dashMonthFilter = 'all'; // 'all' หรือ 'YYYY-MM'

  // ตัวแปรสี CSS ในระบบนี้เป็นรูปแบบ hsl(H, S%, L%) — การต่อ '22'/'aa'/'cc' ท้ายสตริง
  // (แบบ hex alpha) ทำให้ได้ค่าสีที่ผิดรูปแบบ เช่น "hsl(145, 65%, 45%)22" ซึ่ง Canvas/Chart.js
  // parse ไม่ออกและ fallback เป็นสีดำ — ฟังก์ชันนี้แปลงเป็น hsla(...) ที่ถูกต้องแทน
  function withAlpha(cssColor, alpha) {
    const c = (cssColor || '').trim();
    const hslMatch = c.match(/^hsl\(([^)]+)\)$/i);
    if (hslMatch) return `hsla(${hslMatch[1]}, ${alpha})`;
    const hslaMatch = c.match(/^hsla\(([^,]+,[^,]+,[^,]+),\s*[\d.]+\)$/i);
    if (hslaMatch) return `hsla(${hslaMatch[1]}, ${alpha})`;
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) {
      const hex = Math.round(alpha * 255).toString(16).padStart(2, '0');
      return c + hex;
    }
    return c; // ไม่รู้จักรูปแบบ — คืนค่าเดิม
  }

  function bindDashboard() {
    $('dash-month-filter').addEventListener('change', e => {
      dashMonthFilter = e.target.value;
      refreshDashboard();
    });
  }

  function refreshDashboard() {
    const allHist = loadHistory();
    populateDashMonthOptions(allHist);
    const hist = dashMonthFilter === 'all'
      ? allHist
      : allHist.filter(h => (h.date || '').slice(0, 7) === dashMonthFilter);
    renderKpis(hist);
    renderTrendChart(hist, dashMonthFilter);
    renderByLineChart(hist);
    renderDeptDonut(hist);
    renderNgRanking(hist);
  }

  const TH_MONTHS_FULL = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];

  function formatMonthLabel(ym) {
    const [y, m] = ym.split('-').map(Number);
    return `${TH_MONTHS_FULL[m - 1]} ${y + 543}`; // แสดงเป็น พ.ศ.
  }

  /* สร้าง options ของ dropdown จากเดือนที่มีข้อมูลจริงในประวัติ (เรียงล่าสุดก่อน)
     คงค่าที่เลือกไว้เดิมถ้ายังมีอยู่ ไม่งั้น fallback กลับไปที่ "ทั้งหมด" */
  function populateDashMonthOptions(hist) {
    const months = Array.from(new Set(hist.map(h => (h.date || '').slice(0, 7)).filter(Boolean)))
      .sort().reverse();
    const sel = $('dash-month-filter');
    sel.innerHTML = '<option value="all">ทั้งหมด (All)</option>' +
      months.map(m => `<option value="${m}">${formatMonthLabel(m)}</option>`).join('');
    if (dashMonthFilter !== 'all' && months.includes(dashMonthFilter)) {
      sel.value = dashMonthFilter;
    } else {
      sel.value = 'all';
      dashMonthFilter = 'all';
    }
  }

  /* ── KPI Cards ── */
  function renderKpis(hist) {
    const total   = hist.length;
    const allNgs  = hist.flatMap(h => h.items.filter(i => i.status === 'ng'));
    const passCount = hist.filter(h => h.items.every(i => i.status === 'ok' || i.status === 'fixed')).length;
    const passRate  = total ? Math.round(passCount / total * 100) : 0;
    const jigsSeen  = new Set(hist.map(h => h.jigId)).size;

    $('kpi-n-total').textContent = total;
    $('kpi-n-pass').textContent  = passRate + '%';
    $('kpi-n-ng').textContent    = allNgs.length;
    $('kpi-n-jig').textContent   = jigsSeen;
  }

  /* ── Trend Chart (30 วันล่าสุด, หรือทุกวันในเดือนที่เลือก) ── */
  function renderTrendChart(hist, monthFilter) {
    const labels = [], passData = [], ngData = [];

    if (monthFilter && monthFilter !== 'all') {
      const [y, m] = monthFilter.split('-').map(Number);
      const daysInMonth = new Date(y, m, 0).getDate();
      for (let d = 1; d <= daysInMonth; d++) {
        const key = `${monthFilter}-${String(d).padStart(2, '0')}`;
        labels.push(String(d));
        const dayRecs = hist.filter(h => h.date === key);
        passData.push(dayRecs.filter(h => h.items.every(i => i.status === 'ok' || i.status === 'fixed')).length);
        ngData.push(dayRecs.filter(h => h.items.some(i => i.status === 'ng')).length);
      }
      $('trend-title-text').textContent = `แนวโน้มการตรวจสอบ (${formatMonthLabel(monthFilter)})`;
    } else {
      const days = 30;
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        labels.push(key.slice(5)); // MM-DD
        const dayRecs = hist.filter(h => h.date === key);
        passData.push(dayRecs.filter(h => h.items.every(i => i.status === 'ok' || i.status === 'fixed')).length);
        ngData.push(dayRecs.filter(h => h.items.some(i => i.status === 'ng')).length);
      }
      $('trend-title-text').textContent = 'แนวโน้มการตรวจสอบ (30 วัน)';
    }
    const style = getComputedStyle(document.documentElement);
    const ok  = style.getPropertyValue('--ok').trim();
    const ng  = style.getPropertyValue('--ng').trim();
    const muted = style.getPropertyValue('--text-muted').trim();

    if (charts.trend) charts.trend.destroy();
    charts.trend = new Chart($('chart-trend'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'ผ่าน', data: passData, borderColor: ok, backgroundColor: withAlpha(ok, 0.13), fill: true, tension: 0.4, pointRadius: 3 },
          { label: 'NG',   data: ngData,   borderColor: ng, backgroundColor: withAlpha(ng, 0.13), fill: true, tension: 0.4, pointRadius: 3 },
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: muted, font: { size: 10 } }, grid: { color: 'rgba(128,128,128,0.08)' } },
          y: { ticks: { color: muted, font: { size: 10 }, stepSize: 1 }, grid: { color: 'rgba(128,128,128,0.08)' }, beginAtZero: true }
        }
      }
    });
  }

  /* ── NG by Line Bar Chart ── */
  function renderByLineChart(hist) {
    const style = getComputedStyle(document.documentElement);
    const ng  = style.getPropertyValue('--ng').trim();
    const muted = style.getPropertyValue('--text-muted').trim();

    // Count NG per line
    const counts = {};
    hist.forEach(h => {
      const ngCount = h.items.filter(i => i.status === 'ng').length;
      if (!ngCount) return;
      const key = h.lineName || h.lineId || 'Unknown';
      counts[key] = (counts[key] || 0) + ngCount;
    });
    const sorted = Object.entries(counts).sort((a,b) => b[1]-a[1]).slice(0, 8);

    if (charts.byline) charts.byline.destroy();
    charts.byline = new Chart($('chart-byline'), {
      type: 'bar',
      data: {
        labels: sorted.map(([k]) => k.replace('LINE : ','')),
        datasets: [{ label: 'NG', data: sorted.map(([,v]) => v), backgroundColor: withAlpha(ng, 0.67), borderColor: ng, borderWidth: 1, borderRadius: 5 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: muted, font: { size: 10 } }, grid: { display: false } },
          y: { ticks: { color: muted, font: { size: 10 }, stepSize: 1 }, grid: { color: 'rgba(128,128,128,0.08)' }, beginAtZero: true }
        }
      }
    });
  }

  /* ── Dept Donut ── */
  function renderDeptDonut(hist) {
    const style = getComputedStyle(document.documentElement);
    const colors = [
      style.getPropertyValue('--accent').trim(),
      style.getPropertyValue('--ok').trim(),
      style.getPropertyValue('--ng').trim(),
      style.getPropertyValue('--fixed').trim(),
    ];

    const deptMap = {};
    hist.forEach(h => {
      const key = h.deptName || h.deptId || 'ไม่ระบุ';
      if (!deptMap[key]) deptMap[key] = { pass: 0, total: 0 };
      deptMap[key].total++;
      if (h.items.every(i => i.status === 'ok' || i.status === 'fixed')) deptMap[key].pass++;
    });

    const labels = Object.keys(deptMap);
    const data   = labels.map(k => deptMap[k].total);
    const bgs    = labels.map((_, i) => withAlpha(colors[i % colors.length], 0.8));

    if (charts.dept) charts.dept.destroy();
    if (!labels.length) { $('donut-legend').innerHTML = '<div style="font-size:12px;color:var(--text-muted);text-align:center">ยังไม่มีข้อมูล</div>'; return; }

    charts.dept = new Chart($('chart-dept'), {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: bgs, borderWidth: 2, borderColor: style.getPropertyValue('--bg-card').trim() }] },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '62%',
        plugins: { legend: { display: false }, tooltip: {
          callbacks: { label: ctx => {
            const k = ctx.label; const d = deptMap[k];
            const rate = d ? Math.round(d.pass/d.total*100) : 0;
            return ` ${ctx.parsed} ครั้ง (ผ่าน ${rate}%)`;
          }}
        }}
      }
    });

    $('donut-legend').innerHTML = labels.map((l, i) => `
      <div class="donut-legend-item">
        <div class="donut-legend-dot" style="background:${colors[i % colors.length]}"></div>
        <span>${escHtml(l)}</span>
        <span style="font-family:var(--font-en);color:var(--text-main);font-weight:600">${Math.round(deptMap[l].pass/deptMap[l].total*100)}%</span>
      </div>`).join('');
  }

  /* ── NG Ranking ── */
  function renderNgRanking(hist) {
    const counts = {};
    hist.forEach(h => {
      h.items.forEach(it => {
        if (it.status === 'ng') counts[it.id] = (counts[it.id] || { label: it.label, n: 0 }), counts[it.id].n++;
      });
    });
    // fix: simpler approach
    const tally = {};
    hist.forEach(h => h.items.forEach(it => {
      if (it.status !== 'ng') return;
      if (!tally[it.id]) tally[it.id] = { label: it.label, n: 0 };
      tally[it.id].n++;
    }));
    const sorted = Object.entries(tally).sort((a,b) => b[1].n - a[1].n).slice(0, 7);
    const max = sorted.length ? sorted[0][1].n : 1;

    const el = $('ng-ranking');
    if (!sorted.length) { el.innerHTML = '<div class="ng-rank-empty">✅ ยังไม่มีรายการ NG ในประวัติ</div>'; return; }
    el.innerHTML = sorted.map(([id, d], rank) => `
      <div class="ng-rank-item">
        <div class="ng-rank-num">${rank + 1}</div>
        <div class="ng-rank-bar-wrap">
          <div class="ng-rank-label">ข้อ ${id} — ${escHtml(d.label)}</div>
          <div class="ng-rank-bar-bg">
            <div class="ng-rank-bar-fill" style="width:${Math.round(d.n/max*100)}%"></div>
          </div>
        </div>
        <div class="ng-rank-count">${d.n} ครั้ง</div>
      </div>`).join('');
  }

  /* ══════════════════════════════════════
     AI ANALYSIS ENGINE
  ══════════════════════════════════════ */
  const AI_KEY_STORAGE = 'jig_gemini_key';

  function bindAiPanel() {
    $('btn-ai-analyze').addEventListener('click', runAiAnalysis);
    $('btn-ai-key').addEventListener('click', () => {
      const modal = $('ai-key-modal');
      modal.classList.remove('hidden');
      $('inp-api-key').value = localStorage.getItem(AI_KEY_STORAGE) || '';
    });
    $('btn-modal-close').addEventListener('click', () => $('ai-key-modal').classList.add('hidden'));
    $('ai-key-modal').addEventListener('click', e => { if (e.target === $('ai-key-modal')) $('ai-key-modal').classList.add('hidden'); });
    $('btn-save-key').addEventListener('click', () => {
      const key = $('inp-api-key').value.trim();
      if (key) { localStorage.setItem(AI_KEY_STORAGE, key); toast('บันทึก API Key แล้ว', 'ok'); }
      else { localStorage.removeItem(AI_KEY_STORAGE); toast('ลบ API Key แล้ว', 'ok'); }
      $('ai-key-modal').classList.add('hidden');
    });
  }

  /* ── Sanitize AI report HTML before rendering ──
     The Gemini response is free text from an external API. Even though
     we escape all user-entered fields going INTO the prompt, the model
     itself could still be tricked (indirect prompt injection) into
     returning raw <script>/onerror-style HTML, which would otherwise
     run when we do innerHTML = report. We allow only the small set of
     tags/attributes the prompt actually asks for. */
  function sanitizeReportHtml(html) {
    if (window.DOMPurify) {
      return DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ['h3', 'p', 'ul', 'li', 'strong', 'small', 'br', 'hr', 'span'],
        ALLOWED_ATTR: ['class']
      });
    }
    // DOMPurify failed to load — fail safe by escaping everything
    // rather than risking unsanitized HTML.
    console.warn('DOMPurify not available; rendering AI report as plain text.');
    return escHtml(html);
  }

  async function runAiAnalysis() {
    const hist = loadHistory();
    if (!hist.length) { toast('ยังไม่มีข้อมูลการตรวจ', 'ng'); return; }

    const btn = $('btn-ai-analyze');
    btn.classList.add('loading');
    btn.textContent = '⏳ กำลังวิเคราะห์...';
    $('ai-result').innerHTML = '<div class="ai-loading"><div class="ai-spinner"></div> กำลังประมวลผล...</div>';

    const apiKey = localStorage.getItem(AI_KEY_STORAGE);

    try {
      let report;
      if (apiKey) {
        report = await analyzeWithGemini(hist, apiKey);
      } else {
        await new Promise(r => setTimeout(r, 600)); // simulate
        report = analyzeWithSmartEngine(hist);
      }
      $('ai-result').innerHTML = `<div class="ai-report">${sanitizeReportHtml(report)}</div>`;
    } catch (err) {
      console.error('AI error:', err);
      // Fallback to smart engine
      const report = analyzeWithSmartEngine(hist);
      $('ai-result').innerHTML = `<div class="ai-report">${sanitizeReportHtml(report)}</div>`;
    }

    btn.classList.remove('loading');
    btn.innerHTML = '<span class="ai-btn-icon">✨</span> วิเคราะห์ด้วย AI';
  }

  /* ── Gemini API ── */
  async function analyzeWithGemini(hist, apiKey) {
    const summary = buildDataSummary(hist);
    const prompt = `คุณเป็น AI วิเคราะห์คุณภาพโรงงานผลิตชิ้นส่วนยานยนต์
วิเคราะห์ข้อมูลการตรวจสอบ JIG ต่อไปนี้ และให้รายงานเป็นภาษาไทย (HTML fragment):

${JSON.stringify(summary, null, 2)}

ให้รายงานครอบคลุม:
1. สรุปภาพรวม (ใช้ emoji นำหน้า)
2. จุดเสี่ยงสูงที่ต้องแก้ไขเร่งด่วน
3. แนวโน้ม (ดีขึ้น/แย่ลง/คงที่)
4. คำแนะนำเชิงป้องกัน (PM)
5. สรุป action items

ตอบเป็น HTML โดยใช้ tag: <h3>, <p>, <ul>, <li> และ class="tag-risk tag-high/tag-med/tag-low" เท่านั้น`;

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });

    if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || analyzeWithSmartEngine(hist);
  }

  /* ── Smart Rule-Based Engine (ไม่ต้อง internet) ── */
  function buildDataSummary(hist) {
    const total = hist.length;
    const passCount = hist.filter(h => h.items.every(i => i.status === 'ok' || i.status === 'fixed')).length;
    const passRate  = total ? Math.round(passCount / total * 100) : 0;

    // NG per checkpoint
    const tally = {};
    hist.forEach(h => h.items.forEach(it => {
      if (it.status !== 'ng') return;
      if (!tally[it.id]) tally[it.id] = { label: it.label, n: 0 };
      tally[it.id].n++;
    }));

    // NG per line
    const byLine = {};
    hist.forEach(h => {
      const ngCount = h.items.filter(i => i.status === 'ng').length;
      if (!ngCount) return;
      const key = h.lineName || h.lineId || 'Unknown';
      byLine[key] = (byLine[key] || 0) + ngCount;
    });

    // Trend: compare first half vs second half of history
    const mid = Math.floor(hist.length / 2);
    const old = hist.slice(mid);
    const rec = hist.slice(0, mid);
    const oldRate = old.length ? old.filter(h => h.items.every(i=>i.status==='ok'||i.status==='fixed')).length/old.length : 0;
    const recRate = rec.length ? rec.filter(h => h.items.every(i=>i.status==='ok'||i.status==='fixed')).length/rec.length : 0;

    // Shift analysis
    const byShift = {};
    hist.forEach(h => {
      const s = h.shift || 'ไม่ระบุ';
      if (!byShift[s]) byShift[s] = { total:0, ng:0 };
      byShift[s].total++;
      if (h.items.some(i => i.status === 'ng')) byShift[s].ng++;
    });

    return { total, passRate, passCount, tally, byLine, oldRate: Math.round(oldRate*100), recRate: Math.round(recRate*100), byShift };
  }

  function analyzeWithSmartEngine(hist) {
    const s = buildDataSummary(hist);
    const topNg = Object.entries(s.tally).sort((a,b)=>b[1].n-a[1].n).slice(0,3);
    const topLine = Object.entries(s.byLine).sort((a,b)=>b[1]-a[1]).slice(0,2);
    const trend = s.recRate > s.oldRate + 5 ? 'ดีขึ้น' : s.recRate < s.oldRate - 5 ? 'แย่ลง' : 'คงที่';
    const trendIcon = trend === 'ดีขึ้น' ? '📈' : trend === 'แย่ลง' ? '📉' : '➡️';
    const trendTag  = trend === 'ดีขึ้น' ? 'tag-low' : trend === 'แย่ลง' ? 'tag-high' : 'tag-med';

    // Worst shift
    const shiftEntries = Object.entries(s.byShift).map(([k,v])=>({ k, rate: v.total ? Math.round(v.ng/v.total*100) : 0 }));
    const worstShift = shiftEntries.sort((a,b)=>b.rate-a.rate)[0];

    const riskLevel = (n, total) => {
      const r = total ? n/total : 0;
      if (r > 0.3) return 'tag-high';
      if (r > 0.1) return 'tag-med';
      return 'tag-low';
    };

    const now = new Date().toLocaleDateString('th-TH', { year:'numeric', month:'long', day:'numeric' });

    return `
      <h3>📊 สรุปภาพรวม</h3>
      <p>วิเคราะห์ข้อมูล <strong>${s.total} รายการตรวจสอบ</strong> ณ วันที่ ${now}<br>
      อัตราผ่าน <strong>${s.passRate}%</strong> (ผ่าน ${s.passCount}/${s.total} ครั้ง)
      &nbsp;—&nbsp; แนวโน้ม: ${trendIcon} <span class="tag-risk ${trendTag}">${trend}</span></p>

      <hr class="report-sep">
      <h3>🔴 จุดเสี่ยงที่ต้องแก้ไขเร่งด่วน</h3>
      ${topNg.length ? `<ul>
        ${topNg.map(([id, d]) => `<li>
          <strong>ข้อ ${id} — ${escHtml(d.label)}</strong>
          <span class="tag-risk ${riskLevel(d.n, s.total)}">NG ${d.n} ครั้ง</span>
          <br><small>พบ NG คิดเป็น ${s.total ? Math.round(d.n/s.total*100) : 0}% ของการตรวจทั้งหมด — ควรตรวจสอบ PM schedule</small>
        </li>`).join('')}
      </ul>` : '<p>✅ ไม่พบรายการ NG ที่น่าเป็นห่วง</p>'}

      <hr class="report-sep">
      <h3>🏭 Line ที่มีปัญหาสูงสุด</h3>
      ${topLine.length ? `<ul>
        ${topLine.map(([line, count]) => `<li><strong>${escHtml(line)}</strong> — พบ NG รวม <span class="tag-risk tag-high">${count} รายการ</span>
          <br><small>แนะนำให้ทีม QC เข้าตรวจสอบ Jig อย่างละเอียด</small>
        </li>`).join('')}
      </ul>` : '<p>✅ ทุก Line มีอัตรา NG ต่ำ</p>'}

      <hr class="report-sep">
      <h3>${trendIcon} แนวโน้ม</h3>
      <p>เปรียบเทียบผลการตรวจช่วงต้น vs ล่าสุด:<br>
      ช่วงต้น ${s.oldRate}% → ล่าสุด ${s.recRate}%
      &nbsp;—&nbsp; <span class="tag-risk ${trendTag}">${trend}</span>
      ${trend === 'แย่ลง' ? '<br><strong>⚠ ควรเรียกประชุมทีมเพื่อหาสาเหตุโดยด่วน</strong>' : ''}
      </p>

      ${worstShift ? `<hr class="report-sep">
      <h3>🕐 การวิเคราะห์ตามกะ</h3>
      <p>กะที่มี NG สูงสุด: <strong>${escHtml(worstShift.k)}</strong>
      <span class="tag-risk ${worstShift.rate > 30 ? 'tag-high' : 'tag-med'}">${worstShift.rate}% NG rate</span>
      ${worstShift.rate > 30 ? '<br><small>⚠ ควรตรวจสอบขั้นตอน handover และสภาพอุปกรณ์ก่อน shift นี้</small>' : ''}
      </p>` : ''}

      <hr class="report-sep">
      <h3>✅ คำแนะนำ Action Items</h3>
      <ul>
        ${topNg.length ? `<li>🔧 วางแผน PM เพิ่มความถี่สำหรับ: <strong>${topNg.map(([id,d])=>`ข้อ ${id}`).join(', ')}</strong></li>` : ''}
        ${topLine.length ? `<li>📋 ทำ Audit พิเศษสำหรับ Line: <strong>${escHtml(topLine[0][0])}</strong></li>` : ''}
        ${trend === 'แย่ลง' ? `<li>🚨 ประชุม QC ทีมเพื่อหาสาเหตุแนวโน้มที่แย่ลง</li>` : ''}
        ${s.passRate < 80 ? `<li>📊 อัตราผ่านต่ำกว่า 80% — ทบทวน SOP และ Training</li>` : ''}
        <li>📅 บันทึกผลการตรวจให้ครบทุก Shift ทุกวัน</li>
      </ul>
      <p style="font-size:11px;color:var(--text-muted);margin-top:12px">
        🤖 วิเคราะห์โดย Smart Analysis Engine (ไม่ต้องใช้ internet) &nbsp;|&nbsp;
        เพิ่ม Gemini API Key เพื่อรายงานขั้นสูง
      </p>`;
  }

})();

