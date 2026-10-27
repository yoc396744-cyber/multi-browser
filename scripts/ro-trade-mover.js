// ==UserScript==
// @name         RO放置仙境 交易搬移（把倉庫的東西透過交易搬到別的帳號）
// @namespace    yo.ro-idle
// @version      1.0
// @description  送出方：勾選要搬的品項，自動從倉庫領出 → 交易給指定角色，一筆最多 10 項，重複到搬完；接收方：自動接受指定角色的交易並存入倉庫
// @match        https://ro-idle.app/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// 需要倉庫小幫手（ro-storage-helper.js）一起載入，畫面在小幫手的「交易搬移」分頁。
// 兩個角色都要在同一座有卡普拉的城鎮、都停止掛機。
// 接收方只會自動確認「自己沒放任何東西」的交易，所以不會被換走東西。

(function () {
  'use strict';
  if (window.__roTradeMover) return;
  window.__roTradeMover = true;

  const LS_KEY = 'roTradeMover.v1';
  const MAX_ENTRIES = 10;              // 遊戲一筆交易最多放 10 項
  const BAG_SLOTS = 100;
  const ZENY_CAP = 21e8;
  const TRADABLE_SPECIAL = new Set([900010, 900011, 900012, 900013, 900014, 900015]);   // 髮型 / 染髮 / 名字顏色券、稱號（其他 9000xx 不可交易）
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const load = () => { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; } };
  const save = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch {} };
  const cfg = Object.assign({
    role: 's',
    target: '', picked: {}, filter: '', fromStorage: true, fromBag: false, zeny: 0, maxW: 1000,     // 送出方
    from: '', recvOn: false, recvDeposit: true, recvZeny: false,                                    // 接收方
  }, load());

  const H = () => window.ROStorageHelper;
  const DB = () => (H() && H().DB) || {};
  const wOf = (id) => (DB()[id] || {}).w || 0;
  const tradable = (it) => {
    const d = DB()[it.itemId];
    if (d) return !d.noTrade;
    return it.itemId < 900000 || TRADABLE_SPECIAL.has(it.itemId);
  };
  const isStack = (it) => !it.unidentified && !H().isEquip(it.itemId);
  const itemKey = (it) => it.itemId + (it.unidentified ? 'U' : '');
  const equippedSet = (s) => new Set(Object.values(s.equipment || {}).filter(x => x !== undefined));
  const live = (t) => t && (t.status === 'pending' || t.status === 'open');
  const fmtW = (w) => Math.round(w * 10) / 10;

  // ---------- 伺服器 ----------
  function charId() {
    const id = H() && H().charId();
    if (!id) throw new Error('抓不到角色 ID，隨便操作一下遊戲再試');
    return id;
  }
  async function api(method, path, body) {
    for (let tries = 0; ; tries++) {
      const r = await fetch(path, {
        method, credentials: 'same-origin',
        headers: method === 'POST' ? { 'content-type': 'application/json', 'x-ro-client': '1' } : {},
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let j = {}; try { j = await r.json(); } catch {}
      if (r.ok) return j;
      const code = j.error && j.error.code;
      if ((r.status === 429 || ['RATE_LIMITED', 'SERVER_BUSY', 'BUSY_CATCHING_UP'].includes(code) || r.status >= 502) && tries < 5) {
        await sleep(800 * (tries + 1)); continue;
      }
      throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    }
  }
  const trade = (p, body) => api(body === undefined ? 'GET' : 'POST', `/api/characters/${charId()}/trade${p}`, body);
  const getTrade = async () => (await trade('')).trade || null;
  const getStorage = async () => (await api('GET', '/api/storage')).storage;
  function snap() {
    const h = H(), s = h && h.findStore && h.findStore();
    return (s && s.getState().snapshot) || (h && h.findSnapshot());
  }

  // ---------- 面板 ----------
  let panel;
  const $ = (sel) => panel.querySelector(sel);
  // 畫面放在倉庫小幫手的「交易搬移」分頁裡
  function buildPanel(host) {
    panel = document.createElement('div');
    panel.id = 'rtm-root';
    panel.style.cssText = 'display:flex;flex-direction:column;min-height:0;flex:1';
    panel.innerHTML = `
      <div id="rtm-body" style="display:flex;flex-direction:column;min-height:0;flex:1">
        <div style="padding:6px 8px 0;display:flex;gap:4px">
          <button data-role="s" style="flex:1;padding:3px">送出（這個角色交出去）</button>
          <button data-role="r" style="flex:1;padding:3px">接收（這個角色收下）</button>
        </div>
        <div id="rtm-send" style="display:flex;flex-direction:column;min-height:0;flex:1">
          <div style="padding:4px 8px;display:flex;gap:6px;align-items:center">
            <label style="flex:1;display:flex;gap:4px;align-items:center">交易對象 <input id="rtm-target" placeholder="接收方的角色名稱" maxlength="24" style="flex:1;min-width:0;padding:2px 4px"></label>
          </div>
          <div style="padding:0 8px 4px;display:flex;flex-wrap:wrap;gap:10px;align-items:center">
            <span>來源</span>
            <label><input id="rtm-fromstore" type="checkbox"> 倉庫</label>
            <label title="背包裡勾選的品項也一起送（裝備中的不會送）"><input id="rtm-frombag" type="checkbox"> 背包</label>
            <label title="接收方負重放不下時會自動減半">每筆最多重 <input id="rtm-maxw" type="number" min="1" style="width:56px"></label>
          </div>
          <div style="padding:0 8px 4px;display:flex;gap:6px;align-items:center">
            <input id="rtm-filter" placeholder="🔍 搜尋名稱（多個用空白或、分隔）" style="flex:1;min-width:120px;padding:2px 4px">
            <label title="勾選目前搜尋到的全部品項；再按一次全部取消"><input id="rtm-all" type="checkbox"> 全選</label>
          </div>
          <div id="rtm-list" style="overflow:auto;flex:1;padding:0 8px;min-height:60px"></div>
          <div style="padding:4px 8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            <label>Zeny 也搬 <input id="rtm-zeny" type="number" min="0" style="width:110px"></label>
            <span id="rtm-zinfo" style="color:#777"></span>
          </div>
          <div id="rtm-sum" style="padding:0 8px 4px;color:#555"></div>
          <div style="padding:4px 8px;display:flex;gap:6px">
            <button id="rtm-go" style="flex:1;padding:4px;font-weight:bold">開始搬移</button>
            <button id="rtm-clear" style="padding:4px">清除勾選</button>
          </div>
        </div>
        <div id="rtm-recv" style="padding:6px 8px;display:none">
          <div style="display:flex;gap:4px;align-items:center;margin-bottom:4px">
            <label style="flex:1;display:flex;gap:4px;align-items:center">只接受 <input id="rtm-from" placeholder="送出方的角色名稱" maxlength="24" style="flex:1;min-width:0;padding:2px 4px"></label>
          </div>
          <label style="display:block;margin-bottom:3px"><input id="rtm-recvdep" type="checkbox"> 收到的東西自動存入倉庫</label>
          <label style="display:block;margin-bottom:3px"><input id="rtm-recvzeny" type="checkbox"> 收到的 Zeny 也存入倉庫</label>
          <button id="rtm-recvon" style="width:100%;padding:4px;font-weight:bold;margin-top:4px"></button>
          <div style="color:#777;margin-top:4px">只會自動確認「我方沒放任何東西」的交易；我方有放東西時要自己按。</div>
        </div>
        <div id="rtm-msg" style="padding:0 8px 6px;color:#2a6;white-space:pre-line;max-height:7em;overflow:auto"></div>
      </div>`;
    host.appendChild(panel);

    $('#rtm-target').value = cfg.target;
    $('#rtm-from').value = cfg.from;
    $('#rtm-filter').value = cfg.filter;
    $('#rtm-fromstore').checked = cfg.fromStorage;
    $('#rtm-frombag').checked = cfg.fromBag;
    $('#rtm-maxw').value = cfg.maxW;
    $('#rtm-zeny').value = cfg.zeny || '';
    $('#rtm-recvdep').checked = cfg.recvDeposit;
    $('#rtm-recvzeny').checked = cfg.recvZeny;
    $('#rtm-target').onchange = (e) => { cfg.target = e.target.value.trim(); save(); };
    $('#rtm-from').onchange = (e) => { cfg.from = e.target.value.trim(); save(); renderRecv(); };
    $('#rtm-filter').oninput = (e) => { cfg.filter = e.target.value; save(); renderList(true); };
    $('#rtm-fromstore').onchange = (e) => { cfg.fromStorage = e.target.checked; save(); renderList(true); };
    $('#rtm-frombag').onchange = (e) => { cfg.fromBag = e.target.checked; save(); renderList(true); };
    $('#rtm-maxw').onchange = (e) => { cfg.maxW = Math.max(1, +e.target.value || 1000); e.target.value = cfg.maxW; save(); };
    $('#rtm-zeny').onchange = (e) => { cfg.zeny = Math.max(0, Math.floor(+e.target.value || 0)); e.target.value = cfg.zeny || ''; save(); renderList(true); };
    $('#rtm-recvdep').onchange = (e) => { cfg.recvDeposit = e.target.checked; save(); };
    $('#rtm-recvzeny').onchange = (e) => { cfg.recvZeny = e.target.checked; save(); };
    $('#rtm-clear').onclick = () => { cfg.picked = {}; save(); renderList(true); };
    $('#rtm-go').onclick = () => (sending ? stopSending() : runSender());
    $('#rtm-recvon').onclick = () => {
      if (!cfg.recvOn && !cfg.from) { say('先填「只接受」的角色名稱', true); return; }
      cfg.recvOn = !cfg.recvOn; save(); renderRecv();
      say(cfg.recvOn ? `接收中：等 ${cfg.from} 發起交易…` : '已停止接收');
    };
    $('#rtm-all').onchange = (e) => {
      const ts = terms();
      for (const k of lastKinds.filter(k => k.ok && matchTerms(k.label, ts))) {
        if (e.target.checked) cfg.picked[k.key] = 1; else delete cfg.picked[k.key];
      }
      save(); renderList(true);
    };
    for (const b of panel.querySelectorAll('[data-role]')) b.onclick = () => { cfg.role = b.dataset.role; save(); applyRole(); };
    applyRole();
    renderRecv();
  }

  const visible = () => panel && panel.offsetParent !== null;    // 小幫手切到「交易搬移」分頁、而且沒收起來

  function applyRole() {
    for (const b of panel.querySelectorAll('[data-role]')) {
      const on = b.dataset.role === cfg.role;
      b.style.background = on ? '#5b7bd5' : '';
      b.style.color = on ? '#fff' : '';
      b.style.fontWeight = on ? 'bold' : '';
    }
    $('#rtm-send').style.display = cfg.role === 's' ? 'flex' : 'none';
    $('#rtm-recv').style.display = cfg.role === 'r' ? 'block' : 'none';
    renderList(true);
  }
  function renderRecv() {
    const b = $('#rtm-recvon');
    b.textContent = cfg.recvOn ? `停止接收（接收 ${cfg.from} 中）` : '開始接收';
    b.style.background = cfg.recvOn ? '#5b7bd5' : '';
    b.style.color = cfg.recvOn ? '#fff' : '';
    renderBadge();
  }
  // 在小幫手的分頁按鈕上顯示狀態，切到「倉庫」分頁時也看得到
  function renderBadge() {
    const tab = document.querySelector('#rsh-panel [data-main="trade"]');
    if (tab) tab.textContent = '交易搬移' + (sending ? '（送出中）' : cfg.recvOn ? '（接收中）' : '');
  }
  function say(text, err) {
    const m = $('#rtm-msg');
    m.style.color = err ? '#c00' : '#2a6';
    m.textContent = text;
    console.log('[交易搬移]', text);
  }

  // ---------- 送出方：品項清單 ----------
  const terms = () => cfg.filter.toLowerCase().split(/[\s、,，|]+/).filter(Boolean);
  const matchTerms = (label, ts) => !ts.length || ts.some(t => label.toLowerCase().includes(t));
  let storageCache = null, storageAt = 0, storageErr = '';
  let lastKinds = [], lastSig = '';

  async function refreshStorage(force) {
    if (!force && Date.now() - storageAt < 4000) return;
    storageAt = Date.now();
    try { storageCache = await getStorage(); storageErr = ''; }
    catch (e) { storageErr = e.message; }
  }

  function kinds(storage, s) {
    const h = H(), eq = equippedSet(s), m = new Map();
    const add = (it, where) => {
      const k = h.kindKey(it);
      if (!m.has(k)) m.set(k, { key: k, label: h.kindLabel(it), w: wOf(it.itemId), ok: tradable(it), store: 0, bag: 0 });
      m.get(k)[where] += it.qty;
    };
    for (const it of (storage && storage.items) || []) add(it, 'store');
    for (const it of s.inventory) if (!eq.has(it.uid)) add(it, 'bag');
    return [...m.values()];
  }

  function renderList(force) {
    if (!visible() || cfg.role !== 's') return;
    const s = snap();
    if (!s || !H()) return;
    const all = kinds(storageCache, s), ts = terms();
    lastKinds = all;
    const shown = all.filter(k => (k.store && cfg.fromStorage) || (k.bag && cfg.fromBag) || cfg.picked[k.key])
      .filter(k => matchTerms(k.label, ts) || cfg.picked[k.key]);
    const sig = JSON.stringify([shown.map(k => k.key + k.store + '/' + k.bag), cfg.picked, cfg.filter, cfg.fromStorage, cfg.fromBag, cfg.zeny, storageErr, s.character.zeny, storageCache && storageCache.zeny]);
    if (!force && sig === lastSig) return;
    lastSig = sig;

    const matches = shown.filter(k => k.ok && matchTerms(k.label, ts));
    const allBox = $('#rtm-all');
    allBox.checked = matches.length > 0 && matches.every(k => cfg.picked[k.key]);
    allBox.indeterminate = !allBox.checked && matches.some(k => cfg.picked[k.key]);

    const list = $('#rtm-list'), scroll = list.scrollTop;
    list.innerHTML = '';
    if (storageErr && cfg.fromStorage) {
      const p = document.createElement('div');
      p.style.color = '#c00';
      p.textContent = `讀不到倉庫：${storageErr}（要在有卡普拉的城鎮）`;
      list.appendChild(p);
    }
    for (const k of shown) {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;gap:4px;align-items:center;padding:1px 0' + (k.ok ? '' : ';color:#aaa');
      const where = [cfg.fromStorage && k.store ? `倉${k.store}` : '', cfg.fromBag && k.bag ? `包${k.bag}` : ''].filter(Boolean).join('・');
      row.innerHTML = `<input type="checkbox"><span style="flex:1"></span><span style="color:#777"></span>`;
      row.children[1].textContent = k.label;
      row.children[2].textContent = k.ok ? `${where}・重${k.w}` : '不可交易';
      const cb = row.querySelector('input');
      cb.disabled = !k.ok;
      cb.checked = k.ok && !!cfg.picked[k.key];
      cb.onchange = () => { if (cb.checked) cfg.picked[k.key] = 1; else delete cfg.picked[k.key]; save(); renderList(true); };
      list.appendChild(row);
    }
    if (!shown.length && !storageErr) list.append('沒有符合的品項');
    list.scrollTop = scroll;

    const pick = all.filter(k => k.ok && cfg.picked[k.key]);
    const n = pick.reduce((a, k) => a + (cfg.fromStorage ? k.store : 0) + (cfg.fromBag ? k.bag : 0), 0);
    const w = pick.reduce((a, k) => a + k.w * ((cfg.fromStorage ? k.store : 0) + (cfg.fromBag ? k.bag : 0)), 0);
    $('#rtm-sum').textContent = `已選 ${pick.length} 種、共 ${n} 個、總重 ${fmtW(w)}` + (cfg.zeny ? `，Zeny ${cfg.zeny.toLocaleString()}` : '');
    $('#rtm-zinfo').textContent = `身上 ${s.character.zeny.toLocaleString()}` + (storageCache ? `／倉庫 ${(storageCache.zeny || 0).toLocaleString()}` : '');
  }

  // ---------- 送出方：搬移流程 ----------
  let sending = false, stopFlag = false;
  let pulled = new Map();     // 這次為了搬移從倉庫領出來、還沒交出去的：背包 uid -> 數量

  function stopSending() {
    stopFlag = true;
    say('停止中…（目前這筆交易會取消）');
  }

  // 這一輪可以交出去的背包物品
  function candidates(s) {
    const eq = equippedSet(s), out = [];
    for (const it of s.inventory) {
      if (eq.has(it.uid) || !tradable(it)) continue;
      const fromBag = cfg.fromBag && cfg.picked[H().kindKey(it)] ? it.qty : 0;
      const qty = Math.min(it.qty, Math.max(pulled.get(it.uid) || 0, fromBag));
      if (qty > 0) out.push({ it, qty });
    }
    return out;
  }

  // 挑出這筆交易要放的：最多 10 項、總重不超過 budget（可堆疊的會拆數量）
  function planOffer(cands, budget) {
    const entries = [];
    let w = 0;
    for (const { it, qty } of cands) {
      if (entries.length >= MAX_ENTRIES) break;
      const iw = wOf(it.itemId);
      const q = iw ? Math.min(qty, Math.floor((budget - w) / iw + 1e-9)) : qty;
      if (q < 1) continue;
      entries.push({ uid: it.uid, qty: q, label: H().kindLabel(it) });
      w += q * iw;
    }
    return { entries, w };
  }

  // 從倉庫領出勾選的品項，補滿這一筆（自己的負重 / 背包格也要放得下）
  async function pullFromStorage(s, slots, budget) {
    const storage = await getStorage();
    storageCache = storage; storageAt = Date.now();
    const rows = storage.items.filter(it => cfg.picked[H().kindKey(it)] && tradable(it));
    if (!rows.length || slots < 1) return { got: 0, left: rows.length };
    let wLeft = Math.min(s.derived.weightMax - s.weight, budget);
    let freeSlots = BAG_SLOTS - s.inventory.length;
    const bagIds = new Set(s.inventory.filter(isStack).map(x => x.itemId));
    const items = [];
    for (const it of rows) {
      if (items.length >= slots) break;
      const needSlot = !isStack(it) || !bagIds.has(it.itemId);
      if (needSlot && freeSlots < 1) continue;
      const iw = wOf(it.itemId);
      const q = iw ? Math.min(it.qty, Math.floor(wLeft / iw + 1e-9)) : it.qty;
      if (q < 1) continue;
      items.push({ sid: it.sid, qty: q });
      wLeft -= q * iw;
      if (needSlot) { freeSlots--; if (isStack(it)) bagIds.add(it.itemId); }
    }
    if (!items.length) return { got: 0, left: rows.length };
    const before = new Map(s.inventory.map(x => [x.uid, x.qty]));
    const j = await H().sendCmd({ type: 'storageWithdraw', items });
    const after = (j.view && j.view.snapshot) || snap();
    for (const it of after.inventory) {
      const inc = it.qty - (before.get(it.uid) || 0);
      if (inc > 0) pulled.set(it.uid, (pulled.get(it.uid) || 0) + inc);
    }
    return { got: items.length, left: rows.length };
  }

  // 要交出的 Zeny：身上不夠時先從倉庫領
  async function prepareZeny(want) {
    let have = snap().character.zeny;
    if (have < want && cfg.fromStorage) {
      const st = await getStorage();
      const take = Math.min(want - have, st.zeny || 0, ZENY_CAP - have);
      if (take > 0) {
        await H().sendCmd({ type: 'storageZeny', action: 'withdraw', amount: take });
        have = snap().character.zeny;
      }
    }
    return Math.max(0, Math.min(want, have));
  }

  // 等交易狀態符合條件；交易換了一筆 / 沒了就回傳 null
  async function waitTrade(id, pred, ms) {
    const end = Date.now() + ms;
    for (;;) {
      if (stopFlag) return 'stop';
      const t = await getTrade();
      if (!t || t.id !== id) return null;
      if (pred(t) || Date.now() > end) return t;
      await sleep(800);
    }
  }

  async function cancelQuietly(id) { try { await trade('/cancel', { tradeId: id }); } catch {} }
  const weightish = (s) => /負重|重量|超重|空間不足|背包/.test(s || '');

  // 一筆交易：邀請 → 等對方接受 → 放東西 → 鎖定 → 等對方鎖定 → 確認 → 等成交
  async function doTrade(entries, zeny) {
    const name = cfg.target;
    let t = await getTrade();
    if (live(t)) await cancelQuietly(t.id);
    t = (await trade('/request', { name })).trade;
    if (!t) return { fatal: true, reason: '發起交易失敗' };
    const id = t.id;
    say(`等 ${name} 接受交易…`);
    t = await waitTrade(id, x => x.status !== 'pending', 65000);
    if (t === 'stop') { await cancelQuietly(id); return { stopped: true }; }
    if (!t || t.status !== 'open') {
      if (t && t.status === 'pending') await cancelQuietly(id);
      return { fatal: true, reason: `${name} 沒有接受交易（接收方要按「開始接收」）` + (t && t.endReason ? `：${t.endReason}` : '') };
    }
    try {
      await trade('/offer', { tradeId: id, zeny, items: entries.map(e => ({ uid: e.uid, qty: e.qty })) });
      await trade('/lock', { tradeId: id });
      say(`等 ${name} 鎖定…`);
      t = await waitTrade(id, x => x.status !== 'open' || x.other.locked, 60000);
      if (t === 'stop') { await cancelQuietly(id); return { stopped: true }; }
      if (t && t.status === 'open') {
        if (!t.other.locked) { await cancelQuietly(id); return { fatal: true, reason: `${name} 沒有鎖定` }; }
        let r;
        try { r = await trade('/confirm', { tradeId: id, revision: t.revision }); }
        catch (e) {     // 內容版本剛好變了：用最新的再確認一次
          const t2 = await getTrade();
          if (!t2 || t2.id !== id || t2.status !== 'open') throw e;
          r = await trade('/confirm', { tradeId: id, revision: t2.revision });
        }
        if (r.result && r.result.status === 'done') return { ok: true };
        say(`等 ${name} 確認…`);
        t = await waitTrade(id, x => x.status !== 'open', 60000);
        if (t === 'stop') { await cancelQuietly(id); return { stopped: true }; }
      }
      if (t && t.status === 'done') return { ok: true };
      if (t && t.status === 'open') { await cancelQuietly(id); return { fatal: true, reason: `${name} 沒有確認` }; }
      const reason = (t && t.endReason) || '交易被取消';
      return { reason, weight: weightish(reason) };
    } catch (e) {
      await cancelQuietly(id);
      return { reason: e.message, weight: weightish(e.message) };
    }
  }

  async function runSender() {
    if (sending) return;
    cfg.target = $('#rtm-target').value.trim(); save();
    if (!cfg.target) { say('先填交易對象的角色名稱', true); return; }
    if (!Object.keys(cfg.picked).length && !cfg.zeny) { say('沒有勾選要搬的品項', true); return; }
    if (!H() || !H().charId) { say('需要倉庫小幫手才能使用', true); return; }
    if (!confirm(`把勾選的品項${cfg.zeny ? `和 ${cfg.zeny.toLocaleString()} Zeny` : ''}交易給「${cfg.target}」？\n對方要在同一座城鎮、停止掛機，並在「交易搬移 → 接收」按開始接收。`)) return;

    sending = true; stopFlag = false; pulled = new Map();
    $('#rtm-go').textContent = '停止';
    renderBadge();
    let budget = cfg.maxW, zenyLeft = cfg.zeny, count = 0;
    const moved = new Map();
    const summary = () => [...moved].map(([k, v]) => `${k} ×${v}`).join('、') + (cfg.zeny - zenyLeft > 0 ? `${moved.size ? '、' : ''}${(cfg.zeny - zenyLeft).toLocaleString()} Zeny` : '');
    let end = '', bad = false;
    try {
      for (;;) {
        if (stopFlag) { end = '已停止'; break; }
        let s = snap();
        if (!s) throw new Error('讀不到角色資料');
        if (s.activity !== 'stopped') throw new Error('請先停止掛機');
        let plan = planOffer(candidates(s), budget);
        let left = 0;
        if (cfg.fromStorage && plan.entries.length < MAX_ENTRIES && plan.w < budget) {
          say('從倉庫領出…');
          const r = await pullFromStorage(s, MAX_ENTRIES - plan.entries.length, budget - plan.w);
          left = r.left;
          if (r.got) { s = snap(); plan = planOffer(candidates(s), budget); }
        }
        let zeny = 0;
        if (!plan.entries.length) {
          if (candidates(s).length) throw new Error(`「每筆最多重」${budget} 放不下剩下的東西，請調大`);
          if (left) throw new Error('負重或背包格滿了，沒辦法再從倉庫領出（先清一下背包）');
          if (zenyLeft > 0) zeny = await prepareZeny(zenyLeft);
          if (!zeny) { end = zenyLeft > 0 ? `完成，但 Zeny 不夠，還差 ${zenyLeft.toLocaleString()}` : '全部搬完'; break; }
        }
        count++;
        say(`第 ${count} 筆：` + (plan.entries.map(e => `${e.label} ×${e.qty}`).join('、') || `${zeny.toLocaleString()} Zeny`));
        const res = await doTrade(plan.entries, zeny);
        if (res.stopped) { count--; end = '已停止'; break; }
        if (res.ok) {
          for (const e of plan.entries) {
            moved.set(e.label, (moved.get(e.label) || 0) + e.qty);
            const p = (pulled.get(e.uid) || 0) - e.qty;
            if (p > 0) pulled.set(e.uid, p); else pulled.delete(e.uid);
          }
          zenyLeft -= zeny;
          await sleep(500);
          continue;
        }
        count--;
        if (res.weight && budget > 1) {
          budget = Math.max(1, Math.floor(budget / 2));
          say(`交易失敗（${res.reason}），改成每筆最多重 ${budget} 再試`);
          await sleep(1500);
          continue;
        }
        throw new Error(res.reason);
      }
    } catch (e) {
      end = '中斷：' + e.message; bad = true;
    } finally {
      sending = false;
      $('#rtm-go').textContent = '開始搬移';
      renderBadge();
      const rest = [...pulled.values()].reduce((a, b) => a + b, 0);
      say(`${end}（交易 ${count} 筆）` + (moved.size || cfg.zeny - zenyLeft > 0 ? `\n已交出：${summary()}` : '') +
        (rest ? `\n背包裡還有 ${rest} 個領出來但沒交出去的，可以再按開始繼續` : ''), bad);
      refreshStorage(true).then(() => renderList(true));
    }
  }

  // ---------- 接收方 ----------
  let recvBusy = false, pendingDeposit = null, lastRecvMsg = '';
  const rsay = (t, err) => { if (t !== lastRecvMsg) { lastRecvMsg = t; say(t, err); } };

  // 比對交易前後的背包，找出收到的東西（數量不超過交易內容）
  function received(p, s) {
    const want = new Map();
    for (const it of p.items) want.set(itemKey(it), (want.get(itemKey(it)) || 0) + it.qty);
    const out = [];
    for (const it of s.inventory) {
      const inc = it.qty - (p.before.get(it.uid) || 0);
      const left = want.get(itemKey(it)) || 0;
      if (inc <= 0 || left <= 0) continue;
      const qty = Math.min(inc, left);
      want.set(itemKey(it), left - qty);
      out.push({ uid: it.uid, qty });
    }
    const missing = [...want.values()].reduce((a, b) => a + b, 0);
    return { out, missing };
  }

  async function tryDeposit() {
    const p = pendingDeposit, s = snap();
    if (!s) return;
    const { out, missing } = received(p, s);
    if (missing > 0 && Date.now() - p.at < 15000) return;      // 背包還沒更新
    pendingDeposit = null;
    if (!cfg.recvDeposit && !(cfg.recvZeny && p.zeny)) return;
    try {
      if (cfg.recvDeposit && out.length) {
        for (let i = 0; i < out.length; i += 100) await H().sendCmd({ type: 'storageDeposit', items: out.slice(i, i + 100) });
      }
      if (cfg.recvZeny && p.zeny > 0) await H().sendCmd({ type: 'storageZeny', action: 'deposit', amount: p.zeny });
      p.total.deposited += out.length;
      rsay(`已收 ${p.total.trades} 筆` + (cfg.recvDeposit ? `，存入倉庫 ${p.total.deposited} 項` : '') + (missing > 0 ? `（有 ${missing} 個沒對到，留在背包）` : '') + `，等下一筆…`);
    } catch (e) {
      rsay(`存入倉庫失敗：${e.message}（東西留在背包）`, true);
    }
  }

  const recvTotal = { trades: 0, deposited: 0 };
  async function recvTick() {
    if (!cfg.recvOn || recvBusy || sending) return;
    recvBusy = true;
    try {
      const t = await getTrade();
      const p = pendingDeposit;
      if (p && t && t.id === p.id) {
        if (t.status === 'open') return;                  // 我方確認了，等對方確認
        if (t.status === 'cancelled') { pendingDeposit = null; rsay(`交易取消：${t.endReason || ''}，等下一筆…`, true); return; }
      }
      if (p) {
        if (!p.counted) { p.counted = true; p.at = Date.now(); recvTotal.trades++; }   // 成交了，從現在開始等背包更新
        await tryDeposit();
        if (pendingDeposit) return;
      }
      if (!live(t) || t.other.name !== cfg.from) return;
      if (t.status === 'pending') {
        if (!t.incoming) return;
        await trade('/respond', { tradeId: t.id, accept: true });
        rsay(`已接受 ${cfg.from} 的交易，等對方放東西…`);
        return;
      }
      // open：我方有放東西就不自動處理，免得被換走
      if (t.me.items.length || t.me.zeny) { rsay('我方有放東西，不自動確認，請自己處理這筆交易', true); return; }
      if (t.other.locked && !t.me.locked) {
        await trade('/lock', { tradeId: t.id });
      } else if (t.other.locked && t.me.locked && !t.me.confirmed) {
        const s = snap();
        const np = { id: t.id, items: t.other.items, zeny: t.other.zeny, before: new Map(s.inventory.map(x => [x.uid, x.qty])), at: Date.now(), total: recvTotal };
        const r = await trade('/confirm', { tradeId: t.id, revision: t.revision });
        const st = r.trade && r.trade.status;
        if (st === 'cancelled') { rsay(`交易取消：${(r.result && r.result.reason) || r.trade.endReason || ''}`, true); return; }
        pendingDeposit = np;
        rsay(`已確認：` + (np.items.map(it => `${H().kindLabel(it)} ×${it.qty}`).join('、') || '') + (np.zeny ? ` ${np.zeny.toLocaleString()} Zeny` : '') + (st === 'done' ? '' : `，等 ${cfg.from} 確認…`));
      }
    } catch (e) {
      rsay('接收出錯：' + e.message, true);
    } finally {
      recvBusy = false;
    }
  }

  // ---------- 主迴圈 ----------
  async function main() {
    let host;
    while (!(host = document.getElementById('rsh-page-trade'))) await sleep(300);    // 等倉庫小幫手的面板建好
    buildPanel(host);
    renderBadge();
    setInterval(() => {
      if (visible() && cfg.role === 's' && !sending && snap()) refreshStorage(false).then(() => renderList(false));
    }, 1000);
    setInterval(recvTick, 1000);
  }
  main().catch(e => console.warn('[交易搬移]', e));
})();
