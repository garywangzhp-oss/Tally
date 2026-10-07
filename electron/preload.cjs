const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tally', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),

  fetchUsage: (profileId) => ipcRenderer.invoke('usage:fetch', profileId),
  fetchAllUsage: () => ipcRenderer.invoke('usage:fetchAll'),
  fetchCommandCode: () => ipcRenderer.invoke('cc:fetch'),
  fetchUsageHistory: () => ipcRenderer.invoke('usage:history'),
  getCheckinStatus: (opts) => ipcRenderer.invoke('checkin:status', opts),
  claimCheckin: () => ipcRenderer.invoke('checkin:claim'),
  getCheckinDiagnose: (opts) => ipcRenderer.invoke('checkin:diagnose', opts),
  getCreditBalance: () => ipcRenderer.invoke('checkin:balance'),

  minimize: () => ipcRenderer.invoke('window:minimize'),
  setHeight: (height) => ipcRenderer.invoke('window:height', height),
  // 拖右下角等比缩放：渲染层只报告「按下 / 松手」，位移由主进程轮询鼠标自己算
  beginScale: () => ipcRenderer.invoke('window:scale-start'),
  endScale: () => ipcRenderer.invoke('window:scale-end'),
  // 主进程缩放后推回最新倍率，用于显示右下角的百分比角标
  onScaleChanged: (handler) => {
    const listener = (_e, s) => handler(s);
    ipcRenderer.on('window:scale-changed', listener);
    return () => ipcRenderer.removeListener('window:scale-changed', listener);
  },
  hide: () => ipcRenderer.invoke('window:hide'),
  close: () => ipcRenderer.invoke('window:close'),
  quit: () => ipcRenderer.invoke('window:quit'),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  getAppInfo: () => ipcRenderer.invoke('app:info'),

  setTrayTip: (text) => ipcRenderer.invoke('tray:tip', text),
  // 托盘菜单「立即领取今日积分」的回调；返回取消订阅函数
  onTrayClaim: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('tray:claim', listener);
    return () => ipcRenderer.removeListener('tray:claim', listener);
  },
});
