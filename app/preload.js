const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  saveParams: (params) => ipcRenderer.invoke('save-params', params),
  getPresets: () => ipcRenderer.invoke('get-presets'),
  openResult: () => ipcRenderer.invoke('open-result'),
  readSummary: () => ipcRenderer.invoke('read-summary'),
  fetchIndexQuote: () => ipcRenderer.invoke('fetch-index-quote'),
  fetchStockQuotes: (codes) => ipcRenderer.invoke('fetch-stock-quotes', codes),
  fetchStockDetail: (code) => ipcRenderer.invoke('fetch-stock-detail', code),
  fetchStockKline: (payload) => ipcRenderer.invoke('fetch-stock-kline', payload),
  updateCodes: () => ipcRenderer.send('update-codes'),
  runScreen: () => ipcRenderer.send('run-screen'),
  runScreenFull: () => ipcRenderer.send('run-screen-full'),
  cancelTask: () => ipcRenderer.send('cancel-task'),
  onLog: (channel, cb) => ipcRenderer.on(channel, (_, data) => cb(data)),
  onDone: (channel, cb) => ipcRenderer.once(channel, (_, data) => cb(data)),
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});
