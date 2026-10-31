// RO放置仙境 自動精煉腳本
// 用法：由多開啟動器的「精煉」按鈕執行，設定由 window.__autoRefineCfg 傳入（沒有就用下面的預設值）。
//      也可以在遊戲分頁按 F12 → Console 貼上整段後 Enter。畫面右下會出現狀態框與「停止」按鈕。
// 流程：裝備背包中符合名稱的裝備 → 在背包的物品資訊直接請忽克連精煉 → 依精煉畫面判斷要用的材料
//      → 還沒到安全值時用「一鍵精煉到安全值」一次做完（每一步都一定成功），超過安全值才一級一級敲
//      → 級數一、二用完自動到金屬商人補貨；神之金屬、鋁商店沒賣，背包沒有時從倉庫領（需要倉庫小幫手、
//        要在有卡普拉的城鎮），倉庫也沒有就把原石合成（背包的先、再來倉庫的；5 個原石換 1 個，不收費）
//      → 達到目標等級或裝備損壞後換下一把 → 沒裝備、材料或錢不夠就停止。
(() => {
  if (window.__autoRefine && window.__autoRefine.running) { console.log('[精煉] 已在執行中'); return; }

  const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const CFG = Object.assign({
    target: 10,            // 目標精煉值
    match: /短劍/,          // 要精煉的裝備名稱（短劍、卡特短劍都會符合）
    metalShop: '金屬商人',
    buyQty: 50,            // 一次購買 / 從倉庫領出的數量
    minZeny: 0,            // Zeny 低於（此值 + 一次精煉手續費）就停止
    delay: 400,
  }, window.__autoRefineCfg || {});

  // 精煉材料（與遊戲精煉表相同）：price = 金屬商人售價，0 = 商店沒賣，只能自備
  // id = 道具編號（從倉庫領時只認這個；神之金屬原石 756、鋁原石 757 不能精煉）
  const ORE = { 984: 756, 985: 757 };   // 金屬 -> 原石（神之金屬原石、鋁原石）：5 個原石合成 1 個
  const MATERIALS = {
    '強化武器金屬-級數一': { id: 1010, weight: 20, price: 200, fee: 50 },     // 武器等級 1
    '強化武器金屬-級數二': { id: 1011, weight: 20, price: 1000, fee: 200 },   // 武器等級 2
    '神之金屬': { id: 984, weight: 20, price: 0, fee: 5000 },                // 武器等級 3（等級 4 手續費 20,000）
    '鋁': { id: 985, weight: 20, price: 0, fee: 2000 },                      // 防具
  };
  // 啟動器傳來的武器名稱是字串：可用 | 分隔多個；不是合法的正規式就當純文字
  if (typeof CFG.match === 'string') {
    try { CFG.match = new RegExp(CFG.match); } catch (e) { CFG.match = new RegExp(esc(CFG.match)); }
  }

  const S = { running: true, tries: 0, ok: 0, broken: 0, done: 0, spent: 0, log: [] };
  window.__autoRefine = S;

  const sl = ms => new Promise(r => setTimeout(r, ms));
  const btns = () => [...document.querySelectorAll('button')];
  const btn = t => btns().find(b => b.innerText.trim() === t);
  // 主選單的分頁：遊戲 p6.30 起「商店與 NPC」在選單上只寫「商店」，新舊名稱都認
  const menu = (...names) => [...document.querySelectorAll('nav button')].find(b => names.includes(b.innerText.trim())) || btns().find(b => names.includes(b.innerText.trim()));
  const txt = () => document.body.innerText;
  const lvl = s => { const m = s.match(/\+(\d+)\s/); return m ? +m[1] : 0; };
  // 「Zeny : 12,345」在隱藏的元素裡，innerText 讀不到，改用 textContent
  const zeny = () => {
    const el = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && /^\s*Zeny\s*[:：]/.test(e.textContent));
    const s = el ? el.textContent : txt();
    return +((s.match(/Zeny\s*[:：]\s*([\d,]+)/) || [])[1] || '0').replace(/,/g, '');
  };
  // 背包裡 [E] 標記、且符合名稱的那一列＝目前裝備的武器
  const eqBtn = () => { const r = [...document.querySelectorAll('tr')].find(r => r.innerText.includes('[E]') && CFG.match.test(r.innerText)); return r && r.querySelector('button'); };
  const weapon = () => { const b = eqBtn(); return b ? b.innerText.trim() : ''; };
  // 從精煉畫面讀出這次要用的材料：「神之金屬 ×1（持有 3）」
  const MAT_RES = Object.keys(MATERIALS).map(name => [name, new RegExp(esc(name) + ' ×1（持有 ([\\d,]+)）')]);
  const material = () => {
    const t = txt();
    for (const [name, re] of MAT_RES) {
      const m = t.match(re);
      if (m) return { name, have: +m[1].replace(/,/g, ''), ...MATERIALS[name] };
    }
    return null;
  };
  // 精煉師的按鈕：「請忽克連精煉」（每座城鎮的精煉師名字不同）；一鍵精煉：「一鍵精煉到安全值 +7（12,000 Zeny、強化武器金屬-級數一 ×7）」
  const refineBtn = () => btns().find(b => /^請\S+精煉$/.test(b.innerText.trim()));
  function safePlan() {
    const b = btns().find(b => b.innerText.includes('一鍵精煉到安全值'));
    const m = b && b.innerText.match(/安全值 \+(\d+)（([\d,]+) Zeny、(.+)）/);
    if (!m) return null;
    const mats = m[3].split('、').map(x => x.match(/^(.+) ×(\d+)$/)).filter(Boolean).map(x => ({ name: x[1], qty: +x[2] }));
    return { btn: b, to: +m[1], zeny: +m[2].replace(/,/g, ''), mats };
  }
  async function waitFor(fn, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sl(100); } return false; }
  // 遊戲送指令失敗時只在畫面下方跳 3 秒的提示（role=alert），例如「操作太頻繁」「伺服器正在補算離線期間的進度」
  const alertText = () => { const a = document.querySelector('[role=alert]'); return a ? a.innerText.trim() : ''; };

  // 按下精煉按鈕並等畫面變化。遊戲回錯誤時畫面不會變：等按鈕恢復、過幾秒再按，最多試 5 次
  // （按鈕在指令送出到回應前是灰的，所以不會重複送出；每次按之前先看是不是上一次其實已經成功了）
  async function press(getBtn, changed, ms) {
    const usable = () => { const b = getBtn(); return b && !b.disabled ? b : null; };
    let why = '';
    for (let i = 0; i < 5 && S.running; i++) {
      if (changed()) return true;
      if (!(await waitFor(usable, 5000))) { await openEquipped(); await waitFor(usable, 5000); }
      if (changed()) return true;
      const b = usable();
      if (!b) { why = '按鈕一直無法使用'; break; }
      let seen = '';
      b.click();
      const ok = await waitFor(() => { seen = alertText() || seen; return changed(); }, ms);
      if (ok) return true;
      await waitFor(() => { seen = alertText() || seen; return changed() || usable(); }, 20000);
      if (changed()) return true;
      why = seen || '沒有反應';
      if (i < 4) { say(`精煉沒有成功（${why}），${3 * (i + 1)} 秒後重試`); await sl(3000 * (i + 1)); }
    }
    S.failWhy = why;
    return false;
  }

  // 自動按掉確認視窗
  const origConfirm = window.confirm, origAlert = window.alert;
  window.confirm = () => true; window.alert = m => console.log('[alert]', m);

  // 狀態框
  const box = document.createElement('div');
  // 顏色用倉庫小幫手的配色（跟著遊戲的夜間模式切換）；單獨貼到 Console 執行時用後面的預設淺色
  box.className = 'mb-ui';
  box.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99999;background:var(--mb-bg,#fff);border:2px solid var(--mb-accent,#4a6fa5);border-radius:6px;padding:8px 10px;font:12px/1.5 sans-serif;color:var(--mb-text,#222);min-width:220px;box-shadow:0 2px 8px rgba(0,0,0,.3)';
  const info = document.createElement('div');
  const stopBtn = document.createElement('button');
  stopBtn.textContent = '停止'; stopBtn.style.marginTop = '6px';
  stopBtn.onclick = () => { S.running = false; say('使用者停止'); };
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '關閉視窗'; closeBtn.style.cssText = 'margin-top:6px;margin-left:6px';
  closeBtn.onclick = () => box.remove();  // 只關掉狀態框；若還在跑，腳本會繼續
  box.append(info, stopBtn, closeBtn); document.body.append(box);
  function say(m) { S.log.push(m); console.log('[精煉]', m); render(m); }
  function render(m) {
    info.innerHTML = `<b>自動精煉 → +${CFG.target}</b><br>目前：${weapon() || '—'}<br>` +
      `嘗試 ${S.tries}｜成功 ${S.ok}｜損壞 ${S.broken}｜完成 +${CFG.target}：${S.done}<br>` +
      `花費約 ${S.spent.toLocaleString()} Zeny<br><span style="color:var(--mb-dim,#555)">${m || ''}</span>`;
  }

  // 留在背包介面：點開身上的武器，直接用物品資訊裡的精煉
  async function openEquipped() {
    if (!eqBtn()) {
      menu('背包').click();
      await waitFor(() => !!eqBtn(), 1500);
    }
    const b = eqBtn(); if (!b) return false;
    if (!refineBtn() || !txt().includes('精煉 +' + lvl(b.innerText) + ' →')) {
      b.click();
      await waitFor(() => !!refineBtn(), 2000);
    }
    return true;
  }

  async function buyMetal(mat, need = 1) {
    const z = zeny();
    const qty = Math.min(Math.max(CFG.buyQty, need), Math.floor((z - CFG.minZeny) / (mat.price + mat.fee))); // 每個金屬都要留一次精煉手續費
    if (qty < 1) return false;
    menu('商店', '商店與 NPC').click();
    await waitFor(() => !!btn(CFG.metalShop));
    btn(CFG.metalShop).click();
    await waitFor(() => [...document.querySelectorAll('tr')].some(r => r.innerText.includes(mat.name + ' #')));
    const row = [...document.querySelectorAll('tr')].find(r => r.innerText.includes(mat.name + ' #'));
    if (!row) { menu('背包').click(); return false; }
    const inp = row.querySelector('input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(inp, String(qty));
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    await sl(200);
    row.querySelector('button').click();
    const ok = await waitFor(() => +(row.children[2]?.innerText || '0').replace(/,/g, '') > 0);
    menu('背包').click(); await waitFor(() => !!eqBtn(), 1500);
    if (ok) { S.spent += qty * mat.price; say(`買了 ${qty} 個 ${mat.name}`); }
    return ok;
  }

  // 從倉庫領材料（神之金屬 / 鋁）。回傳 true＝領到、false＝倉庫沒有、null＝出錯（已說明原因）
  async function withdrawFromStorage(mat, need = 1) {
    const api = window.ROStorageHelper;
    if (!api) { say(`背包沒有 ${mat.name}，需要倉庫小幫手才能從倉庫領`); return null; }
    let storage;
    try {
      const r = await fetch('/api/storage', { credentials: 'same-origin' });
      storage = (await r.json()).storage;
    } catch (e) { say('讀不到倉庫：' + e.message); return null; }
    // 只認材料本身的道具編號，名字很像的原石不會被領出來
    const rows = ((storage && storage.items) || []).filter(x => x.itemId === mat.id && !x.unidentified);
    const inStore = rows.reduce((s, x) => s + x.qty, 0);
    if (!inStore) return false;
    const snap = api.findSnapshot();
    const room = snap && snap.derived ? Math.floor((snap.derived.weightMax - snap.weight) / mat.weight) : CFG.buyQty;
    const qty = Math.min(inStore, Math.max(CFG.buyQty, need), room);
    if (qty < 1) { say(`負重不夠，無法從倉庫領 ${mat.name}`); return null; }
    const items = [];
    let left = qty;
    for (const x of rows) {
      const q = Math.min(left, x.qty);
      items.push({ sid: x.sid, qty: q });
      left -= q;
      if (!left) break;
    }
    try { await api.sendCmd({ type: 'storageWithdraw', items }); }
    catch (e) { say(`從倉庫領 ${mat.name} 失敗：${e.message}（倉庫要在有卡普拉的城鎮）`); return null; }
    say(`從倉庫領出 ${qty} 個 ${mat.name}（倉庫還有 ${inStore - qty} 個）`);
    await sl(500);
    return true;
  }

  // 原石合成：背包的原石先合成，不夠再合成倉庫的（倉庫合成不收倉庫費，合成完再領出來）。上鎖的原石不用
  // 回傳 true＝背包多了材料、false＝沒有原石、null＝出錯（已說明原因）
  async function combineOre(mat, need) {
    const api = window.ROStorageHelper, ore = ORE[mat.id];
    if (!api || !ore) return false;
    const want = Math.max(CFG.buyQty, need);
    const snap = api.findSnapshot();
    const bagOre = snap && snap.inventory ? snap.inventory.filter(x => x.itemId === ore && !x.locked).reduce((s, x) => s + x.qty, 0) : 0;
    try {
      if (bagOre >= 5) {
        const qty = Math.min(want, Math.floor(bagOre / 5));
        await api.sendCmd({ type: 'purifyOre', itemId: mat.id, qty, where: 'inventory' });
        say(`背包的原石 ×${qty * 5} 合成 ${mat.name} ×${qty}`);
        await sl(500);
        return true;
      }
      const storage = (await (await fetch('/api/storage', { credentials: 'same-origin' })).json()).storage;
      const storeOre = ((storage && storage.items) || []).filter(x => x.itemId === ore && !x.locked).reduce((s, x) => s + x.qty, 0);
      if (storeOre < 5) return false;
      const qty = Math.min(want, Math.floor(storeOre / 5));
      await api.sendCmd({ type: 'purifyOre', itemId: mat.id, qty, where: 'storage' });
      say(`倉庫的原石 ×${qty * 5} 合成 ${mat.name} ×${qty}`);
    } catch (e) { say(`原石合成失敗：${e.message}`); return null; }
    return withdrawFromStorage(mat, need);
  }

  // 補材料到至少 need 個。回傳 true＝補到、false＝已說明原因要停止
  async function supply(mat, need) {
    if (mat.price) {
      if (await buyMetal(mat, need)) return true;
      say(`買不起 ${mat.name}，停止`); return false;
    }
    // 商店沒賣：從倉庫領，倉庫也沒有就合成原石
    let got = await withdrawFromStorage(mat, need);
    if (got === false) got = await combineOre(mat, need);
    if (got === false) say(`${mat.name} 用完了，倉庫也沒有，也沒有原石可以合成，停止`);
    return !!got;
  }

  async function equipNext() {
    menu('背包').click();
    await waitFor(() => btns().some(b => CFG.match.test(b.innerText)), 2000);
    const cands = btns().filter(b => {
      const row = b.closest('tr');
      // 上鎖（🔒）的不能精煉，跳過
      return CFG.match.test(b.innerText) && row && !row.innerText.includes('[E]') && !row.innerText.includes('🔒') && lvl(b.innerText) < CFG.target;
    }).sort((a, b) => lvl(b.innerText) - lvl(a.innerText)); // 先做已經有精煉值的
    if (!cands.length) return false;
    const name = cands[0].innerText.trim();
    const before = weapon();
    cands[0].click();
    // 背包上方的分類篩選也有一顆「裝備」，要用物品資訊裡的（最後一顆）
    const eqBtnInfo = () => btns().filter(b => b.innerText.trim() === '裝備').at(-1);
    await waitFor(() => btns().filter(b => b.innerText.trim() === '裝備').length > 1);
    const eq = eqBtnInfo(); if (!eq) return false;
    eq.click();
    const ok = await waitFor(() => weapon() === name && weapon() !== before || (before === '' && weapon() === name));
    if (!ok) { say(`裝備 ${name} 失敗`); return false; }
    say(`裝備 ${name}`);
    return true;
  }

  async function main() {
    try {
      while (S.running) {
        await openEquipped();
        const w = weapon();
        if (!w || lvl(w) >= CFG.target) {
          if (!(await equipNext())) { say('沒有可精煉的裝備了'); break; }
          continue;
        }
        const eqRow = eqBtn() && eqBtn().closest('tr');
        if (eqRow && eqRow.innerText.includes('🔒')) { say(`${w} 已上鎖，不能精煉（要精煉請先解鎖或換一把），停止`); break; }
        let mat = material();
        if (!mat) { await openEquipped(); mat = material(); }
        if (!mat) { say('讀不到精煉材料，停止'); break; }
        if (zeny() < mat.fee + CFG.minZeny) { say(`Zeny 不足（精煉一次 ${mat.fee.toLocaleString()} Zeny），停止`); break; }
        if (!mat.have) {
          if (!(await supply(mat, 1))) break;
          await openEquipped();
          mat = material();
          if (!mat || !mat.have) { say('讀不到材料數量，停止'); break; }
        }
        const have = mat.have;
        const L = lvl(w);
        // 一鍵精煉到安全值：安全上限以內每一步都一定成功，一次做完；目標比安全值低時照舊一級一級敲
        const plan = safePlan();
        if (plan && plan.to <= CFG.target && zeny() >= plan.zeny + CFG.minZeny) {
          const need = (plan.mats.find(x => x.name === mat.name) || { qty: 0 }).qty;
          if (mat.have < need) {     // 材料不夠一次做完：先補齊
            if (!(await supply(mat, need - mat.have))) break;
            continue;
          }
          if (!(await waitFor(() => { const p = safePlan(); return p && !p.btn.disabled; }, 5000))) { await openEquipped(); await waitFor(() => { const p = safePlan(); return p && !p.btn.disabled; }, 5000); }
          const p = safePlan();
          if (p && !p.btn.disabled && p.to === plan.to) {
            const done = await press(() => { const q = safePlan(); return q && q.to === p.to ? q.btn : null; }, () => weapon() !== w, 10000);
            await sl(CFG.delay);
            if (!done) { say(`一鍵精煉一直沒有成功（${S.failWhy}），停止`); break; }
            if (lvl(weapon()) !== p.to) continue;   // 理論上不會發生（一鍵不會只做一半），重新讀畫面再判斷
            const steps = p.to - L;
            S.tries += steps; S.ok += steps; S.spent += p.zeny;
            if (p.to >= CFG.target) { S.done++; say(`★ ${weapon()} 完成！（一鍵精煉到安全值）`); } else say(`一鍵精煉 +${L} → +${p.to}（安全值）`);
            continue;
          }
          // 按鈕不能按（例如材料、Zeny 剛好不夠）：改成一級一級敲，安全值以內一樣一定成功
        }
        // 精煉後按鈕會冷卻（灰掉），press 會等它恢復可按；遊戲回錯誤就等一下重試
        const changed = await press(refineBtn, () => { const m = material(); return (m && m.have !== have) || weapon() !== w; }, 8000);
        await sl(CFG.delay);
        const w2 = weapon();
        // 材料沒少、裝備也沒變＝精煉沒有執行，不能當成損壞
        if (!changed && w2 === w) {
          say(S.failWhy === '按鈕一直無法使用' ? '精煉按鈕一直無法使用（Zeny 或材料不夠？），停止' : `精煉一直沒有成功（${S.failWhy}），停止`);
          break;
        }
        S.tries++; S.spent += mat.fee;
        if (w2 && CFG.match.test(w2) && lvl(w2) === L + 1) {
          S.ok++;
          if (L + 1 >= CFG.target) { S.done++; say(`★ ${w2} 完成！`); } else say(`${w2} 成功`);
        } else {
          S.broken++; say(`+${L}→+${L + 1} 失敗，${w} 損壞`);
        }
      }
    } catch (e) { say('錯誤：' + e.message); console.error(e); }
    S.running = false;
    window.confirm = origConfirm; window.alert = origAlert;
    say(`結束。完成 +${CFG.target} 共 ${S.done} 把`);
  }
  main();
})();