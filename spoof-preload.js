// 注入到每個網頁：讓頁面永遠認為自己「可見」且「有焦點」
const { contextBridge, webFrame } = require('electron');

function spoofForeground() {
  const defineGetter = (obj, prop, getter) => {
    try {
      Object.defineProperty(obj, prop, { configurable: true, enumerable: true, get: getter });
    } catch (_) { /* ignore */ }
  };

  // Page Visibility API
  defineGetter(Document.prototype, 'hidden', function () { return false; });
  defineGetter(Document.prototype, 'webkitHidden', function () { return false; });
  defineGetter(Document.prototype, 'visibilityState', function () { return 'visible'; });
  defineGetter(Document.prototype, 'webkitVisibilityState', function () { return 'visible'; });

  // document.hasFocus()
  try {
    Object.defineProperty(Document.prototype, 'hasFocus', {
      configurable: true,
      writable: true,
      value: function hasFocus() { return true; },
    });
  } catch (_) { /* ignore */ }

  // 攔截「失去焦點 / 變成不可見」事件。只擋 window/document 層級的 blur，
  // 輸入框等元素自己的 blur 照常觸發，避免表單驗證壞掉。
  const block = (e) => {
    if (e.type === 'blur' && e.target !== window && e.target !== document) return;
    e.stopImmediatePropagation();
  };
  for (const type of ['visibilitychange', 'webkitvisibilitychange', 'blur']) {
    window.addEventListener(type, block, true);
  }
}

try {
  if (typeof contextBridge.executeInMainWorld === 'function') {
    // 同步執行於頁面的主世界，保證早於網站自己的腳本
    contextBridge.executeInMainWorld({ func: spoofForeground });
  } else {
    webFrame.executeJavaScript(`(${spoofForeground.toString()})();`);
  }
} catch (_) {
  webFrame.executeJavaScript(`(${spoofForeground.toString()})();`);
}
