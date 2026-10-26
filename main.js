const { app, BrowserWindow, Menu, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');

// 避免視窗被遮住 / 縮小時 Chromium 降速或暫停背景頁面
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const SPOOF_PRELOAD = path.join(__dirname, 'spoof-preload.js');

// 只允許操作本工具建立的帳號分區
const isAccountPartition = (p) => typeof p === 'string' && /^persist:acc-\d+$/.test(p);

// RO放置仙境的腳本都放在 scripts/（每次重新讀檔，改了腳本只要重新整理該視窗）
const SCRIPTS_DIR = path.join(__dirname, 'scripts');
const RO_HOST = /(^|\.)ro-idle\.app$/i;
// 頁面載入後自動注入：精簡顯示 + 資料擷取、倉庫小幫手（面板操作才會動作）
const AUTO_SCRIPTS = ['ro-compact.js', 'ro-storage-helper.js'];
// 會實際花 Zeny / 操作遊戲的腳本：只能由啟動器按鈕手動執行
const MANUAL_SCRIPTS = ['ro-auto-refine.js'];

function injectRoScripts(contents) {
  let host = '';
  try { host = new URL(contents.getURL()).hostname; } catch (_) { return; }
  if (!RO_HOST.test(host)) return;
  for (const name of AUTO_SCRIPTS) {
    fs.readFile(path.join(SCRIPTS_DIR, name), 'utf8', (err, code) => {
      if (err) return console.error(`讀取 ${name} 失敗：`, err.message);
      contents.executeJavaScript(code).catch((e) => console.error(`注入 ${name} 失敗：`, e));
    });
  }
}

// 移除 UA 中的 Electron / 應用程式名稱，讓網站看到的是一般 Chrome
function cleanUserAgent(ua) {
  return ua
    .replace(/\s?Electron\/\S+/i, '')
    .replace(new RegExp(`\\s?${app.getName()}\\/\\S+`, 'i'), '');
}

// 設定網頁內容（webview 與其彈出視窗）
function setupGuest(contents, ua) {
  contents.setUserAgent(ua);
  contents.setBackgroundThrottling(false);
  contents.on('dom-ready', () => injectRoScripts(contents));
  // 登入時常見的彈出視窗（例如 OAuth）沿用同一個 session，並套用前景偽裝
  contents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      width: 1000,
      height: 750,
      autoHideMenuBar: true,
      webPreferences: {
        preload: SPOOF_PRELOAD,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    },
  }));
  contents.on('did-create-window', (child) => setupGuest(child.webContents, ua));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 950,
    title: '多帳號瀏覽器',
    backgroundColor: '#1e1f22',
    webPreferences: {
      preload: path.join(__dirname, 'host-preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: false,
    },
  });

  // 每個 webview 附加前強制安全設定，並掛上前景偽裝 preload
  win.webContents.on('will-attach-webview', (_e, webPreferences) => {
    webPreferences.preload = SPOOF_PRELOAD;
    webPreferences.sandbox = true;
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.backgroundThrottling = false;
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  const ua = cleanUserAgent(app.userAgentFallback);
  app.userAgentFallback = ua;

  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() === 'webview') setupGuest(contents, ua);
  });

  ipcMain.handle('read-script', async (_e, name) => {
    if (!MANUAL_SCRIPTS.includes(name)) return null;
    try { return await fs.promises.readFile(path.join(SCRIPTS_DIR, name), 'utf8'); } catch (_) { return null; }
  });

  ipcMain.handle('clear-partition', async (_e, partition) => {
    if (!isAccountPartition(partition)) return false;
    const ses = session.fromPartition(partition);
    await ses.clearStorageData();
    await ses.clearCache();
    return true;
  });

  // 匯入登入：Google 擋內嵌瀏覽器，所以在一般瀏覽器用 Google 登入遊戲後，
  // 把遊戲的 cookie（DevTools 裡 Request Headers 的 cookie 整串）貼進來，寫入該帳號的分區
  ipcMain.handle('import-cookies', async (_e, partition, url, text) => {
    if (!isAccountPartition(partition) || typeof text !== 'string') return 0;
    let origin;
    try { origin = new URL(url).origin; } catch (_) { return 0; }
    if (!origin.startsWith('https://')) return 0;
    // 也接受 DevTools「Copy as cURL (bash)」的整段：取出 -b '...' 或 -H 'cookie: ...'
    const curl = text.match(/(?:^|\s)(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/) || text.match(/-H\s+(['"])cookie:\s*([\s\S]*?)\1/i);
    if (curl) text = curl[2];
    const ses = session.fromPartition(partition);
    const pairs = text.replace(/^\s*cookie\s*:\s*/i, '').split(';').map((s) => s.trim()).filter(Boolean);
    let count = 0;
    for (const pair of pairs) {
      const i = pair.indexOf('=');
      if (i <= 0) continue;
      await ses.cookies.set({
        url: origin,
        name: pair.slice(0, i).trim(),
        value: pair.slice(i + 1).trim(),
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
        expirationDate: Math.floor(Date.now() / 1000) + 365 * 86400,
      });
      count++;
    }
    await ses.cookies.flushStore();
    return count;
  });

  // 只看總覽：視窗化時把內容高度貼齊總覽表，切回時還原（最大化 / 全螢幕時不動）
  // Windows 非整數縮放比例下，setBounds 每次寬度會多 1px：設定後讀回，有偏差就反向補正
  const setBoundsExact = (win, target) => {
    let req = { ...target };
    for (let i = 0; i < 4; i++) {
      win.setBounds(req);
      const b = win.getBounds();
      const d = { x: b.x - target.x, y: b.y - target.y, width: b.width - target.width, height: b.height - target.height };
      if (!d.x && !d.y && !d.width && !d.height) return;
      req = { x: req.x - d.x, y: req.y - d.y, width: req.width - d.width, height: req.height - d.height };
    }
  };
  const savedHeights = new WeakMap(); // win -> 進入只看總覽前的視窗高度
  ipcMain.handle('fit-height', (e, contentHeight) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isMaximized() || win.isFullScreen() || win.isMinimized() || !Number.isFinite(contentHeight)) return false;
    const bounds = win.getBounds();
    const content = win.getContentBounds();
    if (!content.height) return false;
    const frame = bounds.height - content.height; // 標題列 + 邊框
    if (!savedHeights.has(win)) savedHeights.set(win, bounds.height);
    setBoundsExact(win, { ...bounds, height: Math.max(120, Math.ceil(contentHeight)) + frame });
    return true;
  });
  ipcMain.handle('restore-height', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const h = win && savedHeights.get(win);
    if (!win || h == null) return false;
    savedHeights.delete(win);
    if (win.isMaximized() || win.isFullScreen() || win.isMinimized()) return false;
    setBoundsExact(win, { ...win.getBounds(), height: h });
    return true;
  });

  // 移除預設選單，避免 Ctrl+R 重新整理整個主畫面
  Menu.setApplicationMenu(null);
  createWindow();
});

app.on('window-all-closed', () => app.quit());
