/*
 * RO放置仙境 精簡顯示 + 資料擷取腳本
 * --------------------------------------------------------------
 * 用法：在每個帳號視窗載入完 https://ro-idle.app/ 後注入這整段 JS
 *   - WebView2 :  await webView.CoreWebView2.ExecuteScriptAsync(js)
 *                 （或 AddScriptToExecuteOnDocumentCreatedAsync，每次重載自動注入）
 *   - Electron :  win.webContents.executeJavaScript(js)
 *   - CefSharp :  browser.ExecuteScriptAsync(js)
 *   - 瀏覽器測試：直接貼到 DevTools Console，或做成 Tampermonkey 腳本
 *
 * 對外 API（掛在 window.ROCompact）：
 *   ROCompact.setMode('compact' | 'stats' | 'full')   // 精簡 / 僅統計 / 完整畫面
 *   ROCompact.toggle()           -> 依序循環 精簡 → 僅統計 → 完整畫面
 *   ROCompact.getData()          -> 回傳目前擷取到的資料物件
 *   ROCompact.subscribe(fn)      -> 資料有變動時呼叫 fn(data)，回傳取消函式
 *   ROCompact.find('負重')        -> 除錯用：列出含有該文字的元素 HTML
 *
 * 資料推送：資料有變動時會
 *   1. 觸發 window 事件 'ro-data'（event.detail = data）
 *   2. 若在 WebView2 內：window.chrome.webview.postMessage({type:'ro-data', data})
 *   3. 若宿主有定義 window.__RO_HOST_POST__(data)，也會呼叫它
 */
(() => {
  if (window.ROCompact) { window.ROCompact.refresh(); return; }

  // 各模式要留下的區塊（legend 開頭比對）；full = 完整畫面
  const KEEP = { compact: ['基本資料', '目前狀態', '統計'], stats: ['統計'] };
  const MODES = ['compact', 'stats', 'full'];
  const LABEL = { compact: '精簡', stats: '僅統計', full: '完整畫面' };
  const STORE_KEY = 'roCompactMode';
  const POLL_MS = 1000;
  const html = document.documentElement;

  // ---------- 樣式 ----------
  const style = document.createElement('style');
  style.id = 'roc-style';
  style.textContent = `
    html.roc-compact [data-roc-hide]{display:none!important}
    html.roc-compact #rsh-panel{display:none!important}
    html.roc-compact main{max-width:none!important;padding-top:24px}
    html.roc-compact main>div{overflow:auto!important}
    html.roc-compact aside{width:100%!important;max-width:none!important;flex:1 1 auto!important;overflow:visible!important}
    html.roc-compact [data-roc-col]{display:grid!important;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:6px;align-items:start}
    #roc-toggle{position:fixed;top:4px;right:4px;z-index:2147483647;font:12px/1 sans-serif;padding:4px 8px;
      border:1px solid #6b7fb8;border-radius:3px;background:linear-gradient(#fff,#d8e0f5);color:#1d2d5a;cursor:pointer;opacity:.85}
    #roc-toggle:hover{opacity:1}
  `;
  document.head.appendChild(style);

  // ---------- 切換按鈕 ----------
  const btn = document.createElement('button');
  btn.id = 'roc-toggle';
  btn.type = 'button';
  btn.addEventListener('click', () => toggle());
  document.body.appendChild(btn);

  // ---------- 工具 ----------
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const num = (s) => { const m = String(s ?? '').replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };
  const pair = (s) => { const m = String(s ?? '').replace(/,/g, '').match(/(\d+)\s*\/\s*(\d+)/); return m ? { cur: +m[1], max: +m[2] } : null; };
  const legendOf = (el) => txt(el.querySelector(':scope > legend'));
  const findGroup = (name) => [...document.querySelectorAll('aside fieldset')].find((f) => legendOf(f).startsWith(name));

  // ---------- 標記要隱藏的元素 ----------
  function tag() {
    const aside = document.querySelector('main aside');
    const main = document.querySelector('main');
    if (!aside || !main) return false;

    const set = (el, hide) => { if (!el) return; hide ? el.setAttribute('data-roc-hide', '') : el.removeAttribute('data-roc-hide'); };

    // 主畫面以外的區塊（標題/選單列、底部狀態列）
    [...main.parentElement.children].forEach((c) => set(c, c !== main));
    // main 內除了右側 aside 以外（戰鬥訊息、聊天）
    [...aside.parentElement.children].forEach((c) => set(c, c !== aside));
    // aside 內只留目前模式的 KEEP 區塊
    const keep = KEEP[mode] || KEEP.compact;
    const col = aside.firstElementChild;
    if (col) {
      col.setAttribute('data-roc-col', '');
      [...col.children].forEach((c) => set(c, !keep.some((k) => c.tagName === 'FIELDSET' && legendOf(c).startsWith(k))));
    }
    return true;
  }

  // ---------- 模式切換 ----------
  let mode = 'compact';
  try { const saved = localStorage.getItem(STORE_KEY); if (MODES.includes(saved)) mode = saved; } catch (e) {}

  const nextMode = () => MODES[(MODES.indexOf(mode) + 1) % MODES.length];

  function setMode(m) {
    mode = MODES.includes(m) ? m : 'compact';
    try { localStorage.setItem(STORE_KEY, mode); } catch (e) {}
    if (mode !== 'full' && !document.querySelector('main aside')) {
      // 不在主控台頁面時先切回主控台
      [...document.querySelectorAll('nav button')].find((b) => txt(b) === '主控台')?.click();
    }
    tag();
    html.classList.toggle('roc-compact', mode !== 'full');
    btn.textContent = `⇄ ${LABEL[nextMode()]}`;
    btn.title = `目前：${LABEL[mode]}，點一下切換到「${LABEL[nextMode()]}」`;
  }
  // 依序循環：精簡 → 僅統計 → 完整畫面 → 精簡
  const toggle = () => setMode(nextMode());

  // React 重繪時重新標記
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; if (mode !== 'full') tag(); });
  }).observe(document.getElementById('root') || document.body, { childList: true, subtree: true });

  // ---------- 資料擷取 ----------
  function parseBasic() {
    const g = findGroup('基本資料');
    if (!g) return null;
    const head = g.querySelector('div.grid > div');
    const spans = [...g.querySelectorAll('span')];
    const barOf = (label) => {
      const s = spans.find((x) => txt(x) === label);
      return pair(txt(s?.nextElementSibling?.querySelector('span')));
    };
    const lvOf = (label) => {
      const s = spans.find((x) => txt(x).startsWith(label));
      return num(txt(s?.nextElementSibling));
    };
    const all = txt(g);
    // EXP 百分比是獨立的 <span>，逐一比對避免黏到前面的等級數字
    const pcts = spans.map(txt).filter((t) => /^\d+(\.\d+)?%$/.test(t)).map(num);
    const zeny = all.match(/Zeny\s*:\s*([\d,]+)/);
    return {
      name: txt(head?.children[0]),
      job: txt(head?.children[1]),
      hp: barOf('HP'),
      sp: barOf('SP'),
      baseLv: lvOf('Base Lv'),
      jobLv: lvOf('Job Lv'),
      baseExpPct: pcts[0] ?? null,
      jobExpPct: pcts[1] ?? null,
      weight: parseWeight(g),
      zeny: zeny ? num(zeny[1]) : null,
      statPoints: parsePoints(g, '屬性點'),
      skillPoints: parsePoints(g, '技能點'),
    };
  }

  // 負重可能帶小數（523.4 / 3,200）、冒號或百分比（負重：27% (1234/5678)），
  // 先找「基本資料」，找不到再擴大到整個主畫面
  const WEIGHT_RE = /負重[^/]{0,15}?(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/;
  function parseWeight(g) {
    for (const src of [g, document.querySelector('main'), document.body]) {
      const m = txt(src).replace(/,/g, '').match(WEIGHT_RE);
      if (m) {
        const cur = +m[1], max = +m[2];
        return { cur, max, pct: max ? Math.round((cur / max) * 100) : null };
      }
    }
    return null;
  }

  // 剩餘點數：「尚有 59 點屬性點」「尚有 2 點技能點、3 點屬性點」「屬性點：3」都能抓；
  // 先找「基本資料」，找不到再擴大到整個主畫面；畫面上沒出現就當作 0
  function parsePoints(g, label) {
    const res = [new RegExp(`(\\d+)\\s*點\\s*${label}`), new RegExp(`${label}[^\\d]{0,6}(\\d+)`)];
    for (const src of [g, document.querySelector('main')]) {
      const text = txt(src).replace(/,/g, '');
      for (const re of res) {
        const m = text.match(re);
        if (m) return +m[1];
      }
    }
    return 0;
  }

  function parseStatus() {
    const g = findGroup('目前狀態');
    if (!g) return null;
    const out = {};
    const map = { '地圖': 'map', '行動': 'action', '目標': 'target', '儲存點': 'savePoint' };
    g.querySelectorAll('div.flex.justify-between').forEach((row) => {
      const [k, v] = row.children;
      const key = map[txt(k)] || txt(k);
      if (key) out[key] = txt(v);
    });
    const buffTitle = [...g.querySelectorAll('div')].find((d) => txt(d) === '目前增益');
    const buffs = buffTitle ? [...buffTitle.parentElement.children].slice(1).map(txt).filter((t) => t && !/沒有/.test(t)) : [];
    out.buffs = buffs;
    return out;
  }

  function parseStats() {
    const g = findGroup('統計');
    if (!g) return null;
    const map = { '掛機時間': 'idleTime', '擊殺數': 'kills', 'Base EXP / 時': 'baseExpPerHour', 'Job EXP / 時': 'jobExpPerHour', '死亡次數': 'deaths' };
    const out = {};
    g.querySelectorAll('tr').forEach((tr) => {
      const [k, v] = tr.children;
      const label = txt(k);
      const key = map[label] || label;
      out[key] = key === 'idleTime' ? txt(v) : num(txt(v));
    });
    if (out.idleTime) {
      const p = out.idleTime.split(':').map(Number);
      out.idleSeconds = p.reduce((a, b) => a * 60 + b, 0);
    }
    return out;
  }

  function getData() {
    return {
      ts: Date.now(),
      onMainPage: !!document.querySelector('main aside'),
      basic: parseBasic(),
      status: parseStatus(),
      stats: parseStats(),
    };
  }

  // ---------- 推送 ----------
  const subs = new Set();
  let last = '';
  function emit() {
    const d = getData();
    const { ts, ...rest } = d;
    const key = JSON.stringify(rest);
    if (key === last) return;
    last = key;
    window.dispatchEvent(new CustomEvent('ro-data', { detail: d }));
    subs.forEach((fn) => { try { fn(d); } catch (e) { console.error(e); } });
    try { window.chrome?.webview?.postMessage({ type: 'ro-data', data: d }); } catch (e) {}
    try { window.__RO_HOST_POST__?.(d); } catch (e) {}
  }
  setInterval(emit, POLL_MS);

  window.ROCompact = {
    setMode, toggle, getData,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    refresh() { setMode(mode); },
    // 除錯：找出頁面上含有指定文字的元素，回傳 HTML 片段，例如 ROCompact.find('負重')
    find(text) {
      const out = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (!walker.currentNode.nodeValue.includes(text)) continue;
        const el = walker.currentNode.parentElement;
        out.push((el.parentElement || el).outerHTML.slice(0, 600));
      }
      return out;
    },
    get mode() { return mode; },
  };

  setMode(mode);
  emit();
})();