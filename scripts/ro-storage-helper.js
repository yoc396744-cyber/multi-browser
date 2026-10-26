// ==UserScript==
// @name         RO放置仙境 倉庫小幫手（鑑定透視 + 一鍵領滿 + 存入 + 領出自動賣 + 自動鑑定）
// @namespace    yo.ro-idle
// @version      1.3
// @description  倉庫未鑑定裝備顯示真名；搜尋 / 全選；勾選品項一次領到負重/格數上限，可選領出後自動賣掉；勾選背包品項存入倉庫；自動買放大鏡把背包未鑑定全部鑑定
// @match        https://ro-idle.app/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';
  if (window.__roStorageHelper) return;
  window.__roStorageHelper = true;

  const BAG_SLOTS = 100;               // 背包上限 100 格
  const MAGNIFIER = 611;               // 放大鏡
  const LS_KEY = 'roStorageHelper.v1';
  const DB = {};                       // itemId -> { name, w, slots, cat, unidName }

  const load = () => { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; } };
  const save = (o) => { try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch {} };
  const cfg = Object.assign({ picked: {}, pct: 100, auto: true, filter: '', reserve: 1, useSkill: false, collapsed: false, autoSell: false, sellSkipCards: true, tab: 'w', pickedDep: {} }, load());
  const ZENY_CAP = 21e8;               // 遊戲 Zeny 上限
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ---------- 記錄目前角色 ID（攔遊戲自己的請求） ----------
  let charId = null;
  const origFetch = window.fetch;
  window.fetch = function (u) {
    try { const s = typeof u === 'string' ? u : u && u.url; const m = s && s.match(/\/api\/characters\/(\d+)\//); if (m) charId = m[1]; } catch {}
    return origFetch.apply(this, arguments);
  };

  // ---------- 道具資料（從遊戲主程式解析） ----------
  async function loadDB() {
    let src;
    for (let i = 0; i < 40 && !src; i++) {
      src = [...document.scripts].map(s => s.src).find(s => /\/assets\/index-.*\.js/.test(s));
      if (!src) await sleep(250);
    }
    if (!src) throw new Error('找不到遊戲主程式');
    const js = await origFetch(src).then(r => r.text());
    const re = /\{id:(\d+),key:`[^`]*`,name:`([^`]*)`/g;
    let m;
    while ((m = re.exec(js))) {
      if (DB[m[1]]) continue;
      const seg = js.slice(m.index, m.index + 1500);
      const end = seg.indexOf('{id:', 5);
      const body = end > 0 ? seg.slice(0, end) : seg;
      const num = (k) => { const x = body.match(new RegExp(k + ':(\\d+)')); return x ? +x[1] : 0; };
      const str = (k) => { const x = body.match(new RegExp(k + ':`([^`]*)`')); return x ? x[1] : ''; };
      DB[m[1]] = { name: m[2], w: num('weight'), sell: num('sell'), slots: num('cardSlots'), cat: str('category'), unidName: str('unidentifiedName') };
    }
  }

  // ---------- 從 React 讀狀態 ----------
  function findSnapshot() {
    const rootEl = document.getElementById('root') || document.body.firstElementChild;
    if (!rootEl) return null;
    const ck = Object.keys(rootEl).find(k => k.startsWith('__reactContainer'));
    if (!ck) return null;
    const stack = [rootEl[ck]];
    let n = 0;
    while (stack.length && n++ < 30000) {
      const f = stack.pop();
      if (f.tag === 0) {
        for (let h = f.memoizedState; h; h = h.next) {
          const v = h.memoizedState;
          if (v && typeof v === 'object' && v.derived && v.inventory && v.character) return v;
        }
      }
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    return null;
  }

  function findStorage() {
    const inp = document.querySelector('input[type=checkbox][aria-label^="取出 "]')
             || [...document.querySelectorAll('fieldset')].find(f => /倉庫（/.test(f.textContent));
    if (!inp) return null;
    const fk = Object.keys(inp).find(k => k.startsWith('__reactFiber'));
    let f = fk && inp[fk];
    while (f) {
      if (f.tag === 0 || f.tag === 11 || f.tag === 15) {
        const hooks = [];
        for (let h = f.memoizedState; h; h = h.next) hooks.push(h);
        const si = hooks.findIndex(h => h.memoizedState && typeof h.memoizedState === 'object' && 'capacity' in h.memoizedState && 'items' in h.memoizedState);
        if (si >= 0) {
          const snap = hooks.map(h => h.memoizedState).find(v => v && typeof v === 'object' && v.derived && v.inventory);
          const wd = hooks.find((h, i) => i > si && h.queue && h.queue.dispatch &&
            h.memoizedState && typeof h.memoizedState === 'object' && !Array.isArray(h.memoizedState) &&
            h.next && typeof h.next.memoizedState === 'boolean' &&
            h.next.next && typeof h.next.next.memoizedState === 'string');
          return { storage: hooks[si].memoizedState, snap, setWithdraw: wd && wd.queue.dispatch };
        }
      }
      f = f.return;
    }
    return null;
  }

  // 角色 ID：優先用攔到的請求；否則用遊戲存的 lastSeen 紀錄比對 Zeny/等級
  function guessCharId(snap) {
    if (charId) return charId;
    try { const s = findStore(); const id = s && s.getState().characterId; if (id != null) return String(id); } catch {}
    let best = null;
    for (let i = 0; i < localStorage.length; i++) {
      const m = localStorage.key(i).match(/^ro-idle:lastSeen:(\d+)$/);
      if (!m) continue;
      try {
        const v = JSON.parse(localStorage.getItem(localStorage.key(i)));
        const match = snap && v.zeny === snap.character.zeny && v.baseLv === snap.character.baseLv;
        const score = (match ? 1e15 : 0) + (v.wallMs || 0);
        if (!best || score > best.score) best = { id: m[1], score };
      } catch {}
    }
    return best && best.id;
  }

  // 遊戲的 zustand store：useStore 的 useCallback 依賴是 [store, selector]，從 React hooks 找出來
  let gameStore = null;
  function findStore() {
    if (gameStore) return gameStore;
    const rootEl = document.getElementById('root') || document.body.firstElementChild;
    const ck = rootEl && Object.keys(rootEl).find(k => k.startsWith('__reactContainer'));
    if (!ck) return null;
    const stack = [rootEl[ck]];
    let n = 0;
    while (stack.length && n++ < 30000) {
      const f = stack.pop();
      if (f.tag === 0) {
        for (let h = f.memoizedState; h; h = h.next) {
          const v = h.memoizedState;
          const s = Array.isArray(v) && v.length === 2 && Array.isArray(v[1]) ? v[1][0] : null;
          if (s && typeof s.setState === 'function' && typeof s.getState === 'function') {
            const st = s.getState();
            if (st && typeof st === 'object' && 'snapshot' in st && 'commandRevision' in st) return (gameStore = s);
          }
        }
      }
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    return null;
  }

  // 跟遊戲自己送指令後一樣，把回應的角色資料寫回畫面（不然要等伺服器下次推送，負重等會晚一點才更新）
  function applyView(j) {
    const store = findStore();
    if (!store || !j) return;
    const cur = store.getState();
    const view = j.view;
    if (view && view.snapshot && !(view.commandRevision < cur.commandRevision)) {
      let snap = view.snapshot;
      const prevCfg = cur.snapshot && cur.snapshot.config;
      if (snap.config && prevCfg) {
        for (const k of ['autoBuy', 'autoSell', 'buffPotion']) {
          if (snap.config[k] == null && prevCfg[k] != null) snap = { ...snap, config: { ...snap.config, [k]: prevCfg[k] } };
        }
      }
      store.setState({
        snapshot: snap,
        commandRevision: view.commandRevision,
        backlogMs: view.backlogMs,
        backlogStartMs: Math.max(cur.backlogStartMs || 0, view.backlogMs || 0),
        clockFrozen: view.clockFrozen,
        rulesetPending: !!view.rulesetPending,
      });
    }
    if (j.storage) store.setState({ storage: j.storage });
  }

  // 指令 ID：與遊戲相同，沒有 crypto.randomUUID（非 https 環境）時自己產生 UUID v4
  function newCommandId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  async function sendCmd(command) {
    const cid = guessCharId(findSnapshot());
    if (!cid) throw new Error('抓不到角色 ID，隨便操作一下遊戲再試');
    for (let tries = 0; ; tries++) {
      const r = await origFetch(`/api/characters/${cid}/commands`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-ro-client': '1' },
        body: JSON.stringify({ commandId: newCommandId(), command }),
      });
      let j = {}; try { j = await r.json(); } catch {}
      if (r.ok) {
        if (j.view && j.view.characterId) charId = String(j.view.characterId);
        try { applyView(j); } catch (e) { console.warn('[倉庫小幫手] 更新畫面失敗', e); }
        return j;
      }
      try { applyView(j); } catch (e) { /* 失敗回應也可能帶最新狀態 */ }
      const code = j.error && j.error.code;
      if ((r.status === 429 || ['RATE_LIMITED', 'SERVER_BUSY', 'BUSY_CATCHING_UP'].includes(code) || r.status >= 502) && tries < 6) {
        await sleep(800 * (tries + 1)); continue;
      }
      throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    }
  }

  // ---------- 共用 ----------
  const kindKey = (it) => (it.unidentified ? 'U' : 'I') + it.itemId + (it.refine ? '+' + it.refine : '');
  const realName = (id) => { const d = DB[id]; return d ? d.name + (d.slots ? ` [${d.slots}]` : '') : '#' + id; };
  const kindLabel = (it) => {
    const d = DB[it.itemId] || {};
    if (it.unidentified) return `${d.unidName || '?'}（未鑑定）→ ${realName(it.itemId)}`;
    return (it.refine ? `+${it.refine} ` : '') + realName(it.itemId);
  };
  const isEquip = (id) => (DB[id] || {}).cat === 'equipment';

  // ---------- 1. 倉庫未鑑定透視 ----------
  function annotate(st) {
    const bySid = new Map(st.storage.items.map(x => [String(x.sid), x]));
    document.querySelectorAll('input[type=checkbox][aria-label^="取出 "]').forEach(inp => {
      const li = inp.closest('li');
      if (!li) return;
      const fk = Object.keys(li).find(k => k.startsWith('__reactFiber'));
      const it = fk && bySid.get(String(li[fk].key));
      let tag = li.querySelector('.rsh-real');
      if (!it || !it.unidentified) { if (tag) tag.remove(); return; }
      const txt = ' → ' + realName(it.itemId);
      if (tag && tag.textContent === txt) return;
      if (!tag) {
        tag = document.createElement('span');
        tag.className = 'rsh-real';
        tag.style.cssText = 'color:#c0392b;font-weight:bold;margin-left:4px';
        li.appendChild(tag);
      }
      tag.textContent = txt;
    });
  }

  // ---------- 面板 ----------
  let panel;
  const $ = (sel) => panel.querySelector(sel);
  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'rsh-panel';
    panel.style.cssText = 'position:fixed;right:12px;top:60px;width:min(340px,calc(100vw - 24px));max-height:75vh;display:flex;flex-direction:column;' +
      'background:#f7f9ff;border:2px solid #5b7bd5;border-radius:6px;font-size:12px;z-index:99999;box-shadow:0 2px 10px rgba(0,0,0,.3)';
    panel.innerHTML = `
      <div id="rsh-head" style="background:#5b7bd5;color:#fff;padding:4px 8px;font-weight:bold;cursor:move;display:flex">
        <span style="flex:1">倉庫小幫手</span><span id="rsh-toggle" style="cursor:pointer">－</span></div>
      <div id="rsh-body" style="display:flex;flex-direction:column;min-height:0;flex:1">
        <div style="padding:6px 8px;border-bottom:1px solid #ccd">
          <div style="font-weight:bold;margin-bottom:3px">自動鑑定（背包）</div>
          <div id="rsh-idinfo" style="color:#555"></div>
          <div style="display:flex;gap:6px;align-items:center;margin-top:4px">
            <button id="rsh-identify" style="flex:1;padding:4px;font-weight:bold">買放大鏡並全部鑑定</button>
            <label title="SP 夠就先用商人的物品鑑定技能（SP 10）"><input id="rsh-skill" type="checkbox"> 先用技能</label>
          </div>
          <div id="rsh-idmsg" style="color:#2a6;margin-top:3px"></div>
        </div>
        <div id="rsh-store" style="display:flex;flex-direction:column;min-height:0;flex:1">
          <div style="padding:6px 8px 0;display:flex;gap:4px">
            <button data-tab="w" style="flex:1;padding:3px">一次領（倉庫 → 背包）</button>
            <button data-tab="d" style="flex:1;padding:3px">存入（背包 → 倉庫）</button>
          </div>
          <div style="padding:4px 8px;display:flex;gap:6px;align-items:center">
            <input id="rsh-filter" placeholder="🔍 搜尋名稱（多個用空白或、分隔）" style="flex:1;min-width:120px;padding:2px 4px">
            <label title="勾選目前搜尋到的全部品項；再按一次全部取消"><input id="rsh-all" type="checkbox"> 全選</label>
          </div>
          <div id="rsh-wopts">
            <div style="padding:0 8px 4px;display:flex;flex-wrap:wrap;gap:6px;align-items:center">
              <label>負重 <input id="rsh-pct" type="number" min="1" max="100" style="width:44px">%</label>
              <label title="留幾格給放大鏡等">留 <input id="rsh-reserve" type="number" min="0" max="99" style="width:36px"> 格</label>
              <label><input id="rsh-auto" type="checkbox"> 自動按取出</label>
            </div>
            <div style="padding:0 8px 4px;display:flex;flex-wrap:wrap;gap:10px;align-items:center">
              <label title="取出完成後，把這次領出的東西直接賣給 NPC（背包原本就有的不會賣）"><input id="rsh-autosell" type="checkbox"> <b>領出後自動賣掉</b></label>
              <label><input id="rsh-skipcard" type="checkbox"> 不賣卡片</label>
            </div>
          </div>
          <div id="rsh-info" style="padding:0 8px 4px;color:#555"></div>
          <div id="rsh-list" style="overflow:auto;flex:1;padding:0 8px;min-height:40px"></div>
          <div style="padding:6px 8px;display:flex;gap:6px">
            <button id="rsh-go" style="flex:1;padding:4px;font-weight:bold"></button>
            <button id="rsh-clear" style="padding:4px">清除勾選</button>
          </div>
          <div id="rsh-msg" style="padding:0 8px 6px;color:#2a6"></div>
        </div>
        <div id="rsh-nostore" style="padding:6px 8px;color:#888">（在城鎮打開倉庫，這裡會出現「一次領」與「存入」）</div>
      </div>`;
    document.body.appendChild(panel);
    $('#rsh-filter').value = cfg.filter;
    $('#rsh-pct').value = cfg.pct;
    $('#rsh-reserve').value = cfg.reserve;
    $('#rsh-auto').checked = cfg.auto;
    $('#rsh-skill').checked = cfg.useSkill;
    $('#rsh-autosell').checked = cfg.autoSell;
    $('#rsh-skipcard').checked = cfg.sellSkipCards;
    $('#rsh-autosell').onchange = (e) => { cfg.autoSell = e.target.checked; save(cfg); };
    $('#rsh-skipcard').onchange = (e) => { cfg.sellSkipCards = e.target.checked; save(cfg); };
    $('#rsh-filter').oninput = (e) => { cfg.filter = e.target.value; save(cfg); renderList(true); };
    $('#rsh-pct').onchange = (e) => { cfg.pct = Math.min(100, Math.max(1, +e.target.value || 100)); e.target.value = cfg.pct; save(cfg); renderList(true); };
    $('#rsh-reserve').onchange = (e) => { cfg.reserve = Math.min(99, Math.max(0, Math.floor(+e.target.value || 0))); e.target.value = cfg.reserve; save(cfg); renderList(true); };
    $('#rsh-auto').onchange = (e) => { cfg.auto = e.target.checked; save(cfg); };
    $('#rsh-skill').onchange = (e) => { cfg.useSkill = e.target.checked; save(cfg); };
    $('#rsh-clear').onclick = () => { if (cfg.tab === 'd') cfg.pickedDep = {}; else cfg.picked = {}; save(cfg); renderList(true); };
    $('#rsh-go').onclick = () => (cfg.tab === 'd' ? deposit() : withdraw());
    $('#rsh-all').onchange = (e) => {
      const st = findStorage();
      if (!st || !st.snap) return;
      const picked = pickedMap(), ts = terms();
      for (const g of tabGroups(st).filter(g => matchTerms(g.label, ts))) {
        if (e.target.checked) picked[g.key] = 1; else delete picked[g.key];
      }
      save(cfg); renderList(true);
    };
    for (const b of panel.querySelectorAll('[data-tab]')) b.onclick = () => { cfg.tab = b.dataset.tab; save(cfg); applyTab(); };
    applyTab();
    $('#rsh-identify').onclick = identifyAll;
    const applyCollapse = () => { $('#rsh-body').style.display = cfg.collapsed ? 'none' : 'flex'; $('#rsh-toggle').textContent = cfg.collapsed ? '＋' : '－'; };
    $('#rsh-toggle').onclick = (e) => { e.stopPropagation(); cfg.collapsed = !cfg.collapsed; save(cfg); applyCollapse(); };
    applyCollapse();
    const head = $('#rsh-head');
    head.onmousedown = (e) => {
      if (e.target.id === 'rsh-toggle') return;
      const r = panel.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const mv = (ev) => { panel.style.left = ev.clientX - dx + 'px'; panel.style.top = ev.clientY - dy + 'px'; panel.style.right = 'auto'; };
      const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    };
  }

  // ---------- 2/3. 倉庫一次領 / 存入 ----------
  function groupItems(items) {
    const g = new Map();
    for (const it of items) {
      const k = kindKey(it);
      if (!g.has(k)) g.set(k, { key: k, label: kindLabel(it), itemId: it.itemId, w: (DB[it.itemId] || {}).w || 0, equip: isEquip(it.itemId), unid: !!it.unidentified, items: [], qty: 0 });
      const e = g.get(k); e.items.push(it); e.qty += it.qty;
    }
    return [...g.values()];
  }
  const groups = (st) => groupItems(st.storage.items);                 // 倉庫裡的
  function bagGroups(snap) {                                           // 背包裡的（裝備中的不列出）
    const equipped = new Set(Object.values(snap.equipment || {}).filter(x => x !== undefined));
    return groupItems(snap.inventory.filter(it => !equipped.has(it.uid)));
  }
  const tabGroups = (st) => (cfg.tab === 'd' ? bagGroups(st.snap) : groups(st));
  const pickedMap = () => (cfg.tab === 'd' ? cfg.pickedDep : cfg.picked);
  // 搜尋：多個關鍵字用空白、頓號、逗號分隔，符合任一個就顯示（未鑑定的也比對真名）
  const terms = () => cfg.filter.toLowerCase().split(/[\s、,，|]+/).filter(Boolean);
  const matchTerms = (label, ts) => !ts.length || ts.some(t => label.toLowerCase().includes(t));

  function applyTab() {
    for (const b of panel.querySelectorAll('[data-tab]')) {
      const on = b.dataset.tab === cfg.tab;
      b.style.background = on ? '#5b7bd5' : '';
      b.style.color = on ? '#fff' : '';
      b.style.fontWeight = on ? 'bold' : '';
    }
    $('#rsh-wopts').style.display = cfg.tab === 'w' ? 'block' : 'none';
    $('#rsh-go').textContent = cfg.tab === 'w' ? '一次領（勾選品項到滿）' : '存入勾選品項';
    $('#rsh-msg').textContent = '';
    renderList(true);
  }

  function capacity(snap) {
    const max = snap.derived.weightMax * cfg.pct / 100;
    return { freeW: Math.max(0, max - snap.weight), freeSlots: Math.max(0, BAG_SLOTS - cfg.reserve - snap.inventory.length) };
  }
  let lastSig = '';
  function renderList(force) {
    const st = findStorage();
    if (!st || !st.snap) return;
    const snap = st.snap, cap = capacity(snap), ts = terms(), picked = pickedMap(), dep = cfg.tab === 'd';
    const all = tabGroups(st);
    const matches = all.filter(g => matchTerms(g.label, ts));
    const shown = all.filter(g => matchTerms(g.label, ts) || picked[g.key]);   // 已勾的就算不符合搜尋也留著
    const sig = JSON.stringify([cfg.tab, shown.map(g => g.key + g.qty), cap, picked, cfg.filter, snap.weight, st.storage.items.length]);
    if (!force && sig === lastSig) return;
    lastSig = sig;
    const allBox = $('#rsh-all');
    allBox.checked = matches.length > 0 && matches.every(g => picked[g.key]);
    allBox.indeterminate = !allBox.checked && matches.some(g => picked[g.key]);
    if (dep) {
      const used = st.storage.items.length, max = st.storage.capacity ?? 600;
      $('#rsh-info').textContent = `倉庫 ${used} / ${max} 格（可再放 ${max - used} 格）｜背包 ${snap.inventory.length} 格（裝備中的不列出）`;
    } else {
      $('#rsh-info').textContent = `負重 ${snap.weight} / ${snap.derived.weightMax}（${cfg.pct}% 內可再放 ${Math.floor(cap.freeW)}）｜背包 ${snap.inventory.length} / ${BAG_SLOTS}（可再放 ${cap.freeSlots} 格）`;
    }
    const list = $('#rsh-list');
    const scroll = list.scrollTop;
    list.innerHTML = '';
    for (const g of shown) {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;gap:4px;align-items:center;padding:1px 0';
      const fit = Math.min(g.qty, g.w ? Math.floor(cap.freeW / g.w) : g.qty, g.equip ? cap.freeSlots : g.qty);
      row.innerHTML = `<input type="checkbox"><span style="flex:1">${g.label}</span><span style="color:#777">×${g.qty}・重${g.w}${dep ? '' : '・可領' + fit}</span>`;
      const cb = row.querySelector('input');
      cb.checked = !!picked[g.key];
      cb.onchange = () => { if (cb.checked) picked[g.key] = 1; else delete picked[g.key]; save(cfg); renderList(true); };
      list.appendChild(row);
    }
    if (!shown.length) list.textContent = dep ? '背包裡沒有符合的品項' : '沒有符合的品項';
    list.scrollTop = scroll;
  }

  // 存入：勾選的品項整疊 / 整組存進倉庫（直接送遊戲的 storageDeposit 指令）
  let depositing = false;
  async function deposit() {
    if (depositing) return;
    const msg = $('#rsh-msg');
    const st = findStorage();
    if (!st || !st.snap) { msg.style.color = '#c00'; msg.textContent = '找不到倉庫視窗'; return; }
    const picked = bagGroups(st.snap).filter(g => cfg.pickedDep[g.key]);
    const items = picked.flatMap(g => g.items.map(it => ({ uid: it.uid, qty: it.qty })));
    if (!items.length) { msg.style.color = '#c00'; msg.textContent = '沒有勾選要存的品項（或背包裡已經沒有了）'; return; }
    // 倉庫格數：同種道具合併為一格，裝備（含未鑑定）每件一格
    const stored = new Set(st.storage.items.filter(x => !x.unidentified && !isEquip(x.itemId)).map(x => x.itemId));
    const need = picked.reduce((n, g) => n + (g.equip || g.unid ? g.items.length : (stored.has(g.itemId) ? 0 : 1)), 0);
    const free = (st.storage.capacity ?? 600) - st.storage.items.length;
    if (need > free) { msg.style.color = '#c00'; msg.textContent = `倉庫空間不足：需要 ${need} 格，只剩 ${free} 格`; return; }
    depositing = true;
    $('#rsh-go').disabled = true;
    msg.style.color = '#2a6';
    msg.textContent = `存入中 ${picked.length} 項…`;
    try {
      for (let i = 0; i < items.length; i += 100) await sendCmd({ type: 'storageDeposit', items: items.slice(i, i + 100) });
      msg.textContent = '已存入：' + picked.map(g => `${g.label} ×${g.qty}`).join('、');
    } catch (e) {
      msg.style.color = '#c00';
      msg.textContent = '存入失敗：' + e.message;
    } finally {
      depositing = false;
      $('#rsh-go').disabled = false;
      renderList(true);
    }
  }
  function withdraw() {
    const msg = $('#rsh-msg');
    const st = findStorage();
    if (!st || !st.setWithdraw || !st.snap) { msg.style.color = '#c00'; msg.textContent = '找不到倉庫視窗'; return; }
    const cap = capacity(st.snap);
    let freeW = cap.freeW, freeSlots = cap.freeSlots;
    const bagIds = new Set(st.snap.inventory.map(x => x.itemId));
    const sel = {}, done = [];
    for (const g of groups(st).filter(g => cfg.picked[g.key])) {
      let n = 0;
      for (const it of g.items) {
        if (g.equip || it.unidentified) {
          if (freeSlots < 1 || freeW < g.w) break;
          sel[it.sid] = 1; freeSlots--; freeW -= g.w; n++;
        } else {
          const needSlot = !bagIds.has(it.itemId);
          if (needSlot && freeSlots < 1) break;
          const q = Math.min(it.qty, g.w ? Math.floor(freeW / g.w) : it.qty);
          if (q < 1) break;
          sel[it.sid] = q; freeW -= q * g.w; n += q;
          if (needSlot) { freeSlots--; bagIds.add(it.itemId); }
        }
      }
      if (n) done.push(`${g.label} ×${n}`);
    }
    if (!done.length) { msg.style.color = '#c00'; msg.textContent = '沒有可領的（沒勾品項，或負重/格數已滿）'; return; }
    st.setWithdraw(sel);
    msg.style.color = '#2a6';
    msg.textContent = '已勾選：' + done.join('、');
    if (cfg.autoSell) {
      // 記下領出前的背包與這次要領的數量，取出完成後只賣多出來的部分
      const bySid = new Map(st.storage.items.map(x => [String(x.sid), x]));
      const want = new Map();
      for (const [sid, q] of Object.entries(sel)) {
        const it = bySid.get(String(sid));
        if (!it) continue;
        const k = itemKey(it);
        want.set(k, (want.get(k) || 0) + q);
      }
      pendingSell = { before: new Map(st.snap.inventory.map(x => [x.uid, x.qty])), want, at: Date.now() };
      msg.textContent += '（取出後會自動賣掉）';
    }
    if (cfg.auto) {
      setTimeout(() => {
        const btn = [...document.querySelectorAll('button')].find(b => /^取出\s*\d+\s*項/.test(b.textContent.trim()));
        if (btn && !btn.disabled) { btn.click(); msg.textContent += ' → 已送出取出'; }
        else msg.textContent += '（請手動按「取出」）';
      }, 150);
    }
  }

  // ---------- 5. 領出後自動賣掉 ----------
  // 手動買賣目前不限地點（遊戲設定 anywhere），所以不用移動，取出完成後直接賣
  let pendingSell = null;   // { before: Map(uid -> qty), want: Map(itemKey -> qty), at }
  let selling = false;
  const itemKey = (it) => it.itemId + (it.unidentified ? 'U' : '');
  // 商人「高價賣出」加成，與遊戲公式相同
  const overchargePct = (ch) => { const lv = (ch.skills || {}).MC_OVERCHARGE || 0; return lv > 0 ? 5 + lv * 2 - (lv === 10 ? 1 : 0) : 0; };

  // 比對領出前後的背包，找出這次領出的東西（數量不超過要領的量）
  function withdrawnItems(p, snap) {
    const want = new Map(p.want);
    const out = [];
    for (const it of snap.inventory) {
      const prev = p.before.get(it.uid) || 0;
      const inc = it.qty - prev;
      const left = want.get(itemKey(it)) || 0;
      if (inc <= 0 || left <= 0) continue;
      const qty = Math.min(inc, left);
      want.set(itemKey(it), left - qty);
      out.push({ it, qty, whole: prev === 0 && qty === it.qty });
    }
    return out;
  }

  function checkPendingSell() {
    if (!pendingSell || selling) return;
    const msg = $('#rsh-msg');
    if (Date.now() - pendingSell.at > 60000) {
      pendingSell = null;
      msg.style.color = '#c00';
      msg.textContent = '等不到取出結果，沒有自動賣出';
      return;
    }
    const snap = findSnapshot();
    if (!snap) return;
    const got = withdrawnItems(pendingSell, snap);
    if (!got.length) return;           // 還沒取出
    pendingSell = null;
    sellWithdrawn(got, snap);
  }

  async function sellWithdrawn(got, snap) {
    const msg = $('#rsh-msg');
    const skipped = [];
    const list = got.filter(({ it, qty }) => {
      const d = DB[it.itemId] || {};
      const name = `${it.unidentified ? (d.unidName || '?') + '（未鑑定）' : realName(it.itemId)} ×${qty}`;
      if (cfg.sellSkipCards && d.cat === 'card') { skipped.push(name + '（卡片）'); return false; }
      if (!d.sell) { skipped.push(name + '（不可販售）'); return false; }
      return true;
    });
    const skipText = skipped.length ? `；未賣：${skipped.join('、')}` : '';
    if (!list.length) { msg.style.color = '#c00'; msg.textContent = '沒有可賣的東西' + skipText; return; }

    const pct = 100 + overchargePct(snap.character);
    const total = list.reduce((s, { it, qty }) => s + Math.floor(DB[it.itemId].sell * pct / 100) * qty, 0);
    if (snap.character.zeny + total > ZENY_CAP) {
      msg.style.color = '#c00';
      msg.textContent = `賣出後 Zeny 會超過上限（約 +${total.toLocaleString()}），沒有自動賣出，請先把 Zeny 存入倉庫`;
      return;
    }

    selling = true;
    msg.style.color = '#2a6';
    msg.textContent = `賣出中 ${list.length} 項…`;
    let sold = 0;
    try {
      // 整疊都是這次領出的：一次批次賣；疊在原本就有的那疊上：只賣多出來的數量
      const whole = list.filter(x => x.whole);
      if (whole.length) { await sendCmd({ type: 'sellBatch', uids: whole.map(x => x.it.uid) }); sold += whole.length; }
      for (const x of list.filter(x => !x.whole)) {
        await sendCmd({ type: 'sell', uid: x.it.uid, qty: x.qty });
        sold++;
        await sleep(250);
      }
      msg.textContent = `已賣出 ${sold} 項，約 ${total.toLocaleString()} Zeny` + skipText;
    } catch (e) {
      msg.style.color = '#c00';
      msg.textContent = `賣出中斷（已賣 ${sold} / ${list.length} 項）：${e.message}` + skipText;
    } finally {
      selling = false;
    }
  }

  // ---------- 4. 自動鑑定 ----------
  let identifying = false;
  function renderIdInfo(snap) {
    if (!snap || identifying) return;
    const un = snap.inventory.filter(x => x.unidentified).length;
    const mag = snap.inventory.filter(x => x.itemId === MAGNIFIER).reduce((a, x) => a + x.qty, 0);
    $('#rsh-idinfo').textContent = `背包未鑑定 ${un} 件｜放大鏡 ${mag} 個｜SP ${snap.character.sp}`;
  }
  async function identifyAll() {
    if (identifying) { identifying = false; return; }   // 再按一次＝停止
    const msg = $('#rsh-idmsg'), btn = $('#rsh-identify');
    let snap = findSnapshot();
    if (!snap) { msg.style.color = '#c00'; msg.textContent = '讀不到角色資料'; return; }
    identifying = true; btn.textContent = '停止'; msg.style.color = '#2a6';
    const found = {};
    try {
      let todo = snap.inventory.filter(x => x.unidentified).map(x => x.uid);
      if (!todo.length) { msg.textContent = '背包沒有未鑑定的東西'; return; }
      let sp = snap.character.sp;
      const skillN = cfg.useSkill && (snap.character.skills || {}).MC_IDENTIFY ? Math.min(todo.length, Math.floor(sp / 10)) : 0;
      const haveMag = snap.inventory.filter(x => x.itemId === MAGNIFIER).reduce((a, x) => a + x.qty, 0);
      const needBuy = Math.max(0, todo.length - skillN - haveMag);
      if (needBuy > 0) {
        msg.textContent = `購買放大鏡 ×${needBuy}…`;
        const j = await sendCmd({ type: 'buy', itemId: MAGNIFIER, qty: needBuy });
        if (j.view && j.view.snapshot) snap = j.view.snapshot;
        const now = snap.inventory.filter(x => x.itemId === MAGNIFIER).reduce((a, x) => a + x.qty, 0);
        if (now < todo.length - skillN) throw new Error(`放大鏡只買到 ${now} 個（可能 Zeny、負重或背包格不夠）`);
      }
      let n = 0, skillLeft = skillN;
      for (const uid of todo) {
        if (!identifying) { msg.textContent += '（已停止）'; break; }
        const method = skillLeft > 0 ? 'skill' : 'item';
        let j;
        try { j = await sendCmd({ type: 'identify', uid, method }); }
        catch (e) {
          if (method === 'skill') { skillLeft = 0; j = await sendCmd({ type: 'identify', uid, method: 'item' }); }
          else throw e;
        }
        if (method === 'skill') skillLeft--;
        n++;
        const s = j.view && j.view.snapshot;
        const it = s && s.inventory.find(x => x.uid === uid);
        if (it) { const nm = realName(it.itemId); found[nm] = (found[nm] || 0) + 1; }
        msg.textContent = `鑑定中 ${n} / ${todo.length}…`;
        await sleep(250);
      }
      msg.textContent = `完成 ${n} 件：` + Object.entries(found).map(([k, v]) => `${k} ×${v}`).join('、');
    } catch (e) {
      msg.style.color = '#c00';
      msg.textContent = '中斷：' + e.message + (Object.keys(found).length ? '（已鑑定：' + Object.entries(found).map(([k, v]) => `${k} ×${v}`).join('、') + '）' : '');
    } finally {
      identifying = false; btn.textContent = '買放大鏡並全部鑑定';
    }
  }

  // 給其他腳本用（例如自動精煉從倉庫領神之金屬 / 鋁）
  window.ROStorageHelper = { sendCmd, findSnapshot, findStore };

  // ---------- 主迴圈 ----------
  async function main() {
    while (!document.body) await sleep(100);
    await loadDB();
    buildPanel();
    setInterval(() => {
      const snap = findSnapshot();
      panel.style.display = snap ? 'flex' : 'none';
      if (!snap) return;
      renderIdInfo(snap);
      checkPendingSell();
      const st = findStorage();
      $('#rsh-store').style.display = st ? 'flex' : 'none';
      $('#rsh-nostore').style.display = st ? 'none' : 'block';
      if (st) { annotate(st); renderList(false); }
    }, 700);
  }
  main().catch(e => console.warn('[倉庫小幫手]', e));
})();