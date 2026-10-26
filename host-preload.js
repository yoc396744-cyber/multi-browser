const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mb', {
  clearPartition: (partition) => ipcRenderer.invoke('clear-partition', partition),
  readScript: (name) => ipcRenderer.invoke('read-script', name),
  importCookies: (partition, url, text) => ipcRenderer.invoke('import-cookies', partition, url, text),
  fitHeight: (height) => ipcRenderer.invoke('fit-height', height),
  restoreHeight: () => ipcRenderer.invoke('restore-height'),
});
