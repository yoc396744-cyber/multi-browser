const STORE_KEY = 'multi-browser-state-v1';
const DEFAULT_URL = 'https://ro-idle.app/';
const POLL_MS = 2000;

const $ = (sel, root = document) => root.querySelector(sel);
const grid = $('#grid');
const globalUrl = $('#globalUrl');
const colsSelect = $('#cols');

const state = loadState();
const views = new Map(); // panel id -> { el, wv }

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.panels)) return s;
  } catch (_) { /* ignore */ }
  return {
    nextId: 5,
    columns: 'auto',
    panels: [1, 2, 3, 4].map((id) => ({ id, name: `帳號 ${id}`, url: DEFAULT_URL, zoom: 1 })),
  };
}

function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) { /* ignore */ }
}

function normalizeUrl(input) {
  const v = input.trim();
  if (!v) return null;
  if (/^localhost(:\d+)?(\/|$)/i.test(v)) return `http://${v}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) || /^about:/i.test(v)) return v;
  if (/^[^\s]+\.[^\s]+$/.test(v)) return `https://${v}`;
  return `https://www.google.com/search?q=${encodeURIComponent(v)}`;
}

function layout() {
  const rowMode = state.columns === 'row';
  grid.classList.toggle('row-mode', rowMode);
  $('#widthLabel').hidden = !rowMode;
  if (rowMode) {
    grid.style.gridTemplateColumns = '';
    grid.style.gridTemplateRows = '';
    grid.style.setProperty('--panel-w', `${state.panelWidth}px`);
    return;
  }
  const n = Math.max(state.panels.length, 1);
  const cols = state.columns === 'auto' ? Math.ceil(Math.sqrt(n)) : Math.min(Number(state.columns), n);
  const rows = Math.ceil(n / cols);
  grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
}

function createPanel(p) {
  const el = document.createElement('section');
  el.className = 'panel';
  el.dataset.id = p.id;
  el.innerHTML = `
    <div class="bar">
      <span class="grip" title="拖曳以調整順序">⠿</span>
      <input class="name" spellcheck="false" title="帳號名稱（可自行修改）">
      <button data-act="back" title="上一頁">◀</button>
      <button data-act="forward" title="下一頁">▶</button>
      <button data-act="reload" title="重新整理">⟳</button>
      <select class="mode" title="顯示模式" hidden>
        <option value="full">完整</option>
        <option value="compact">精簡</option>
        <option value="stats">僅統計</option>
      </select>
      <button data-act="refine" title="自動精煉" hidden>精煉</button>
      <input class="addr" spellcheck="false">
      <button data-act="zoomout" title="縮小">−</button>
      <span class="zoom"></span>
      <button data-act="zoomin" title="放大">+</button>
      <button data-act="solo" title="單獨顯示這個視窗">⛶</button>
      <button data-act="devtools" title="開發者工具">⚙</button>
      <button data-act="cookie" title="匯入在一般瀏覽器登入後的 cookie（Google 登入的帳號用）">匯入登入</button>
      <button data-act="clear" title="清除此視窗的 cookie / 登入資料">登出</button>
      <button data-act="remove" class="danger" title="移除此視窗（同時清除登入資料）">✕</button>
    </div>`;

  const nameInput = $('.name', el);
  const addr = $('.addr', el);
  const zoomLabel = $('.zoom', el);
  const reloadBtn = $('[data-act="reload"]', el);
  nameInput.value = p.name;
  addr.value = p.url;
  zoomLabel.textContent = `${Math.round(p.zoom * 100)}%`;

  const wv = document.createElement('webview');
  wv.setAttribute('partition', `persist:acc-${p.id}`); // 每個視窗獨立的 cookie / storage，重開仍保留登入
  wv.setAttribute('allowpopups', '');
  wv.setAttribute('src', p.url);
  el.appendChild(wv);

  const setZoom = (z) => {
    p.zoom = Math.min(3, Math.max(0.25, Math.round(z * 100) / 100));
    zoomLabel.textContent = `${Math.round(p.zoom * 100)}%`;
    try { wv.setZoomFactor(p.zoom); } catch (_) { /* webview not ready */ }
    saveState();
  };

  const onNavigate = (url) => {
    if (document.activeElement !== addr) addr.value = url;
    p.url = url;
    saveState();
  };

  wv.addEventListener('dom-ready', () => wv.setZoomFactor(p.zoom));
  wv.addEventListener('did-navigate', (e) => onNavigate(e.url));
  wv.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) onNavigate(e.url); });
  wv.addEventListener('page-title-updated', (e) => { addr.title = e.title; });
  wv.addEventListener('did-start-loading', () => reloadBtn.classList.add('loading'));
  wv.addEventListener('did-stop-loading', () => reloadBtn.classList.remove('loading'));

  nameInput.addEventListener('change', () => { p.name = nameInput.value.trim() || `帳號 ${p.id}`; saveState(); refreshSoloSelect(); });
  addr.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const url = normalizeUrl(addr.value);
    if (url) wv.loadURL(url);
    addr.blur();
  });
  addr.addEventListener('focus', () => addr.select());
  $('.grip', el).addEventListener('pointerdown', (e) => startDrag(e, p.id, el));
  // 單排模式：在標題列上滾滾輪 = 左右捲動
  $('.bar', el).addEventListener('wheel', (e) => {
    if (state.columns !== 'row' || !e.deltaY) return;
    e.preventDefault();
    grid.scrollLeft += e.deltaY;
  }, { passive: false });
  const modeSelect = $('.mode', el);
  modeSelect.addEventListener('change', async () => {
    updateModeSelect(p.id, await roCall(wv, `ROCompact.setMode(${JSON.stringify(modeSelect.value)})`));
  });

  el.querySelector('.bar').addEventListener('click', async (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (!act) return;
    switch (act) {
      case 'back': if (wv.canGoBack()) wv.goBack(); break;
      case 'forward': if (wv.canGoForward()) wv.goForward(); break;
      case 'reload': wv.reload(); break;
      case 'zoomin': setZoom(p.zoom + 0.1); break;
      case 'zoomout': setZoom(p.zoom - 0.1); break;
      case 'devtools': wv.isDevToolsOpened() ? wv.closeDevTools() : wv.openDevTools(); break;
      case 'solo': setSolo(state.solo === p.id ? null : p.id); break;
      case 'refine': openRefine(p, wv); break;
      case 'cookie': {
        const input = await askCookie(p);
        if (!input) return;
        const n = await window.mb.importCookies(`persist:acc-${p.id}`, input.url, input.text);
        if (!n) { alert('沒有讀到任何 cookie，請確認貼上的是「cookie」那一行的值，網址要是 https 開頭。'); return; }
        wv.loadURL(input.url);
        break;
      }
      case 'clear':
        if (!confirm(`確定清除「${p.name}」的所有 cookie 與登入資料？`)) return;
        await window.mb.clearPartition(`persist:acc-${p.id}`);
        wv.reload();
        break;
      case 'remove':
        if (!confirm(`確定移除「${p.name}」？此視窗的登入資料也會一併清除。`)) return;
        await window.mb.clearPartition(`persist:acc-${p.id}`);
        removePanel(p.id);
        break;
    }
  });

  grid.appendChild(el);
  views.set(p.id, { el, wv });
}

// ---------- 排序 ----------
// 只改 CSS order，不搬動 DOM（搬動 webview 會讓網頁重新載入）
function applyOrder() {
  state.panels.forEach((p, i) => {
    const v = views.get(p.id);
    if (v) v.el.style.order = i;
  });
}

function movePanel(id, targetId, after) {
  const from = state.panels.findIndex((x) => x.id === id);
  if (from < 0) return;
  const [item] = state.panels.splice(from, 1);
  let to = state.panels.findIndex((x) => x.id === targetId);
  if (to < 0) { state.panels.splice(from, 0, item); return; }
  if (after) to++;
  state.panels.splice(to, 0, item);
  applyOrder();
  saveState();
  renderOverview();
  refreshSoloSelect();
}

// ---------- 單獨顯示 ----------
// 選中的那格撐滿遊戲區，其他移到畫面外照常運作（不搬 DOM，不會重新載入）
const soloSelect = $('#soloSelect');

function refreshSoloSelect() {
  const opts = [new Option('全部', '')];
  for (const p of state.panels) opts.push(new Option(p.name, String(p.id)));
  soloSelect.replaceChildren(...opts);
  soloSelect.value = state.solo == null ? '' : String(state.solo);
}

function setSolo(id) {
  state.solo = id != null && views.has(id) ? id : null;
  document.body.classList.toggle('solo', state.solo != null);
  for (const [pid, v] of views) {
    const on = pid === state.solo;
    v.el.classList.toggle('solo-target', on);
    const btn = v.el.querySelector('[data-act="solo"]');
    btn.textContent = on ? '▦' : '⛶';
    btn.title = on ? '回到全部顯示' : '單獨顯示這個視窗';
  }
  soloSelect.value = state.solo == null ? '' : String(state.solo);
  if (state.solo != null && state.overviewOnly) setOverviewOnly(false);
  saveState();
}

soloSelect.addEventListener('change', () => setSolo(soloSelect.value ? Number(soloSelect.value) : null));

// 抓住標題列的 ⠿ 拖曳；用 pointer capture，滑鼠經過其他遊戲畫面時事件也不會被吃掉
function startDrag(e, id, el) {
  if (e.button !== 0) return;
  e.preventDefault();
  const handle = e.currentTarget;
  handle.setPointerCapture(e.pointerId);
  document.body.classList.add('dragging');
  el.classList.add('drag-src');
  let target = null;
  let after = false;
  let px = e.clientX;
  let py = e.clientY;

  const clearMark = () => target?.classList.remove('drop-before', 'drop-after');
  // 找出離滑鼠最近的視窗（滑鼠在空隙、邊距或超出遊戲區時也找得到）
  const updateTarget = () => {
    const g = grid.getBoundingClientRect();
    const x = Math.min(Math.max(px, g.left), g.right);
    const y = Math.min(Math.max(py, g.top), g.bottom);
    let best = null;
    let bestDist = Infinity;
    for (const { el: other } of views.values()) {
      const r = other.getBoundingClientRect();
      if (r.right < g.left || r.left > g.right) continue; // 捲到畫面外的不算
      const dx = Math.max(r.left - x, 0, x - r.right);
      const dy = Math.max(r.top - y, 0, y - r.bottom);
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) { bestDist = dist; best = other; }
    }
    clearMark();
    target = best && best !== el ? best : null;
    if (!target) return;
    const r = target.getBoundingClientRect();
    after = x > r.left + r.width / 2;
    target.classList.add(after ? 'drop-after' : 'drop-before');
  };
  // 單排模式：滑鼠靠近左右邊緣時持續自動捲動（滑鼠不動也會捲）
  let raf = 0;
  const autoScroll = () => {
    if (state.columns === 'row') {
      const g = grid.getBoundingClientRect();
      const dx = px < g.left + 60 ? -20 : px > g.right - 60 ? 20 : 0;
      if (dx) {
        const prev = grid.scrollLeft;
        grid.scrollLeft += dx;
        if (grid.scrollLeft !== prev) updateTarget();
      }
    }
    raf = requestAnimationFrame(autoScroll);
  };
  raf = requestAnimationFrame(autoScroll);

  const onMove = (ev) => {
    px = ev.clientX;
    py = ev.clientY;
    updateTarget();
  };
  const onEnd = (ev) => {
    cancelAnimationFrame(raf);
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onEnd);
    handle.removeEventListener('pointercancel', onEnd);
    clearMark();
    document.body.classList.remove('dragging');
    el.classList.remove('drag-src');
    if (target && ev.type === 'pointerup') movePanel(id, Number(target.dataset.id), after);
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onEnd);
  handle.addEventListener('pointercancel', onEnd);
}

// 匯入登入對話框：回傳 { url, text }，取消時回傳 null
const cookieDialog = $('#cookieDialog');
function askCookie(p) {
  let url = DEFAULT_URL;
  try {
    const u = new URL(p.url);
    if (u.protocol === 'https:' && !/(^|\.)google\.com$/i.test(u.hostname)) url = `${u.origin}/`;
  } catch (_) { /* 用預設網址 */ }
  $('#cookieTarget').textContent = p.name;
  $('#cookieUrl').value = url;
  $('#cookieText').value = '';
  cookieDialog.returnValue = '';
  cookieDialog.showModal();
  $('#cookieText').focus();
  return new Promise((resolve) => {
    cookieDialog.addEventListener('close', () => {
      const text = $('#cookieText').value.trim();
      resolve(cookieDialog.returnValue === 'ok' && text ? { url: $('#cookieUrl').value.trim(), text } : null);
    }, { once: true });
  });
}

function addPanel() {
  const id = state.nextId++;
  const url = normalizeUrl(globalUrl.value) || DEFAULT_URL;
  const p = { id, name: `帳號 ${id}`, url, zoom: 1 };
  state.panels.push(p);
  createPanel(p);
  applyOrder();
  layout();
  if (state.columns === 'row') grid.scrollLeft = grid.scrollWidth;
  saveState();
  renderOverview();
  fitWindowToOverview();
  refreshSoloSelect();
  if (state.solo != null) setSolo(id);
}

function removePanel(id) {
  views.get(id)?.el.remove();
  views.delete(id);
  roInfo.delete(id);
  state.panels = state.panels.filter((p) => p.id !== id);
  layout();
  saveState();
  renderOverview();
  fitWindowToOverview();
  refreshSoloSelect();
  if (state.solo === id) setSolo(null);
}

function goAll() {
  const url = normalizeUrl(globalUrl.value);
  if (!url) return;
  for (const { wv } of views.values()) wv.loadURL(url);
}

$('#goAll').addEventListener('click', goAll);
globalUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') goAll(); });
$('#add').addEventListener('click', addPanel);
$('#reloadAll').addEventListener('click', () => { for (const { wv } of views.values()) wv.reload(); });
colsSelect.value = state.columns;
colsSelect.addEventListener('change', () => { state.columns = colsSelect.value; layout(); saveState(); });
const widthInput = $('#panelWidth');
state.panelWidth = Number(state.panelWidth) || 560;
widthInput.value = state.panelWidth;
widthInput.addEventListener('change', () => {
  state.panelWidth = Math.min(3000, Math.max(300, Number(widthInput.value) || 560));
  widthInput.value = state.panelWidth;
  layout();
  saveState();
});

// ---------- RO放置仙境：精簡切換 + 狀態總覽 ----------
const roInfo = new Map(); // panel id -> { mode, data } | null（頁面沒有 ROCompact 時為 null）

// 在遊戲頁執行 ROCompact 指令，回傳執行後的模式（沒有腳本時回傳 null）
async function roCall(wv, expr) {
  try { return await wv.executeJavaScript(`window.ROCompact ? (${expr}, ROCompact.mode) : null`); } catch (_) { return null; }
}

const MODE_LABEL = { full: '完整', compact: '精簡', stats: '僅統計' };

function updateModeSelect(id, mode) {
  const sel = views.get(id)?.el.querySelector('.mode');
  if (!sel) return;
  sel.hidden = !mode;
  if (mode && document.activeElement !== sel) sel.value = mode;
}

async function setAllMode(mode) {
  await Promise.all([...views].map(async ([id, { wv }]) => {
    const m = await roCall(wv, `ROCompact.setMode(${JSON.stringify(mode)})`);
    if (m) updateModeSelect(id, m);
  }));
}

const PROBE = `window.ROCompact ? {
  mode: ROCompact.mode,
  data: ROCompact.getData(),
  refine: window.__autoRefine ? (({ running, tries, ok, broken, done, spent, log }) =>
    ({ running, tries, ok, broken, done, spent, last: log[log.length - 1] || '' }))(window.__autoRefine) : null,
} : null`;

async function poll() {
  await Promise.all([...views].map(async ([id, { wv }]) => {
    let r = null;
    try { r = await wv.executeJavaScript(PROBE); } catch (_) { /* 頁面尚未載入 */ }
    roInfo.set(id, r);
    updateModeSelect(id, r?.mode);
    updateRefineButton(id, r);
  }));
  renderOverview();
  renderRefineStatus();
}

// ---------- 自動精煉（手動啟動） ----------
const REFINE_DEFAULTS = { target: 10, match: '短劍', buyQty: 50, minZeny: 0 };
const refineDialog = $('#refineDialog');
let refineDialogId = null; // 對話框目前對應的視窗

function updateRefineButton(id, r) {
  const btn = views.get(id)?.el.querySelector('[data-act="refine"]');
  if (!btn) return;
  btn.hidden = !r;
  const running = !!r?.refine?.running;
  btn.textContent = running ? '精煉中…' : '精煉';
  btn.classList.toggle('loading', running);
}

function refineText(f) {
  if (!f) return '';
  return `${f.running ? '執行中' : '已停止'}｜嘗試 ${f.tries}｜成功 ${f.ok}｜損壞 ${f.broken}｜完成 ${f.done}｜花費約 ${fmt(f.spent)} Zeny`;
}

function renderRefineStatus() {
  if (!refineDialog.open || refineDialogId == null) return;
  const f = roInfo.get(refineDialogId)?.refine;
  $('#refineStatus').textContent = f ? `${refineText(f)}\n${f.last}` : '尚未執行';
  $('#refineStart').disabled = !!f?.running;
  $('#refineStop').disabled = !f?.running;
}

function openRefine(p, wv) {
  const cfg = { ...REFINE_DEFAULTS, ...p.refineCfg };
  const form = $('form', refineDialog);
  for (const [k, v] of Object.entries(cfg)) if (form.elements[k]) form.elements[k].value = v;
  $('#refineTarget').textContent = p.name;
  refineDialogId = p.id;
  refineDialog.returnValue = '';
  renderRefineStatus();
  refineDialog.showModal();
  refineDialog.addEventListener('close', async () => {
    refineDialogId = null;
    const action = refineDialog.returnValue;
    if (action === 'stop') {
      await wv.executeJavaScript('window.__autoRefine && (window.__autoRefine.running = false)').catch(() => {});
      return;
    }
    if (action !== 'start') return;
    const next = {};
    for (const k of Object.keys(REFINE_DEFAULTS)) {
      const v = form.elements[k].value.trim();
      next[k] = typeof REFINE_DEFAULTS[k] === 'number' ? Number(v) || 0 : v;
    }
    if (!next.match || next.target < 1) { alert('請填寫裝備名稱與目標精煉值'); return; }
    p.refineCfg = next;
    saveState();
    const code = await window.mb.readScript('ro-auto-refine.js');
    if (!code) { alert('讀不到 scripts/ro-auto-refine.js'); return; }
    await roCall(wv, 'ROCompact.setMode("full")'); // 精煉要操作完整介面（背包、商店）
    await wv.executeJavaScript(`window.__autoRefineCfg = ${JSON.stringify(next)};\n${code}`).catch((e) => alert(`啟動失敗：${e.message}`));
  }, { once: true });
}

const fmt = (n) => (n == null ? '' : Number(n).toLocaleString());
const pairText = (x) => (x ? `${fmt(x.cur)} / ${fmt(x.max)}` : '');
const ratio = (x) => (x && x.max ? x.cur / x.max : null);

// [標題, (panel, data) => 內容 | { text, cls }, 是否數字, 合計函式]
const COLUMNS = [
  ['視窗', (p) => p.name],
  ['角色', (p, d) => d?.basic?.name],
  ['職業', (p, d) => d?.basic?.job],
  ['Base Lv', (p, d) => d?.basic && `${d.basic.baseLv ?? ''} (${d.basic.baseExpPct ?? 0}%)`, true],
  ['Job Lv', (p, d) => d?.basic && `${d.basic.jobLv ?? ''} (${d.basic.jobExpPct ?? 0}%)`, true],
  ['HP', (p, d) => {
    const r = ratio(d?.basic?.hp);
    return { text: pairText(d?.basic?.hp), cls: r != null && r < 0.3 ? 'bad' : '' };
  }, true],
  ['SP', (p, d) => pairText(d?.basic?.sp), true],
  ['負重', (p, d) => {
    const w = d?.basic?.weight;
    const pct = w?.pct;
    return { text: w ? `${pairText(w)} (${pct}%)` : '', cls: pct >= 90 ? 'bad' : pct >= 50 ? 'warn' : '' };
  }, true],
  ['Zeny', (p, d) => fmt(d?.basic?.zeny), true, (ds) => ds.reduce((s, d) => s + (d?.basic?.zeny || 0), 0)],
  ['屬性點', (p, d) => {
    const n = d?.basic?.statPoints;
    return { text: n ? String(n) : '', cls: n ? 'warn' : '' };
  }, true],
  ['地圖', (p, d) => d?.status?.map],
  ['行動', (p, d) => d?.status?.action],
  ['目標', (p, d) => d?.status?.target],
  ['掛機時間', (p, d) => d?.stats?.idleTime, true],
  ['擊殺', (p, d) => fmt(d?.stats?.kills), true, (ds) => ds.reduce((s, d) => s + (d?.stats?.kills || 0), 0)],
  ['Base EXP/時', (p, d) => fmt(d?.stats?.baseExpPerHour), true, (ds) => ds.reduce((s, d) => s + (d?.stats?.baseExpPerHour || 0), 0)],
  ['Job EXP/時', (p, d) => fmt(d?.stats?.jobExpPerHour), true, (ds) => ds.reduce((s, d) => s + (d?.stats?.jobExpPerHour || 0), 0)],
  ['死亡', (p, d) => {
    const n = d?.stats?.deaths;
    return { text: fmt(n), cls: n > 0 ? 'bad' : '' };
  }, true, (ds) => ds.reduce((s, d) => s + (d?.stats?.deaths || 0), 0)],
  ['精煉', (p, d, r) => {
    const f = r?.refine;
    if (!f) return '';
    return { text: `${f.running ? '執行中' : '已停止'} 成${f.ok} 壞${f.broken} 完成${f.done}`, cls: f.running ? 'warn' : 'muted' };
  }],
  ['狀態', (p, d, r) => {
    if (!r) return { text: '非遊戲頁 / 載入中', cls: 'muted' };
    if (!d.onMainPage) return { text: '不在主控台', cls: 'warn' };
    return { text: MODE_LABEL[r.mode] || r.mode, cls: 'muted' };
  }],
];

const overview = $('#overview');

function cell(tag, content, isNum) {
  const td = document.createElement(tag);
  const c = content && typeof content === 'object' ? content : { text: content };
  td.textContent = c.text ?? '';
  if (c.cls) td.className = c.cls;
  if (isNum) td.classList.add('num');
  return td;
}

function renderOverview() {
  if (overview.hidden) return;
  const headRow = $('thead tr', overview);
  if (!headRow.children.length) COLUMNS.forEach(([label, , isNum]) => headRow.appendChild(cell('th', label, isNum)));

  const rows = state.panels.map((p) => {
    const r = roInfo.get(p.id);
    const d = r?.data;
    const tr = document.createElement('tr');
    COLUMNS.forEach(([, get, isNum]) => tr.appendChild(cell('td', get(p, d, r), isNum)));
    tr.title = '點一下跳到這個視窗';
    tr.addEventListener('click', () => flashPanel(p.id));
    return tr;
  });
  $('tbody', overview).replaceChildren(...rows);

  const all = state.panels.map((p) => roInfo.get(p.id)?.data).filter((d) => d?.basic);
  const foot = COLUMNS.map(([, , isNum, sum], i) => cell('td', i === 0 ? `合計（${all.length}）` : sum && all.length ? fmt(sum(all)) : '', isNum));
  $('tfoot tr', overview).replaceChildren(...foot);
}

function flashPanel(id) {
  const v = views.get(id);
  if (!v) return;
  if (state.overviewOnly) setOverviewOnly(false);
  if (state.solo != null && state.solo !== id) setSolo(id);
  v.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  v.el.classList.add('flash');
  setTimeout(() => v.el.classList.remove('flash'), 1200);
  v.wv.focus();
}

function setOverviewVisible(show) {
  overview.hidden = !show;
  state.showOverview = show;
  if (!show && state.overviewOnly) setOverviewOnly(false);
  saveState();
  renderOverview();
}

// 只看總覽：遊戲畫面縮到最小，只留上方數據
function setOverviewOnly(on) {
  state.overviewOnly = on;
  document.body.classList.toggle('overview-only', on);
  $('#overviewOnly').textContent = on ? '▦ 顯示遊戲畫面' : '▤ 只看總覽';
  if (on && overview.hidden) setOverviewVisible(true);
  saveState();
  if (on) {
    renderOverview();
    fitWindowToOverview();
  } else {
    window.mb.restoreHeight();
  }
}

// 視窗高度貼齊「工具列 + 總覽表」（只在只看總覽時）
function fitWindowToOverview() {
  if (!state.overviewOnly) return;
  requestAnimationFrame(() => {
    const scrollbar = overview.offsetHeight - overview.clientHeight; // 表格太寬時的水平捲軸
    const pad = parseFloat(getComputedStyle(overview).paddingTop) + parseFloat(getComputedStyle(overview).paddingBottom);
    window.mb.fitHeight($('#toolbar').offsetHeight + $('table', overview).offsetHeight + pad + scrollbar);
  });
}

$('#toggleOverview').addEventListener('click', () => setOverviewVisible(overview.hidden));
$('#overviewOnly').addEventListener('click', () => setOverviewOnly(!state.overviewOnly));
$('#compactAll').addEventListener('click', () => setAllMode('compact'));
$('#fullAll').addEventListener('click', () => setAllMode('full'));

state.panels.forEach(createPanel);
applyOrder();
layout();
refreshSoloSelect();
setSolo(state.solo);
overview.hidden = !state.showOverview;
setOverviewOnly(!!state.overviewOnly);
setInterval(poll, POLL_MS);
