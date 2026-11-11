// Preload da janela principal. Roda em sandbox, isolado da página: a interface
// web só enxerga o objeto `EchoDesktop` abaixo, nunca o Node nem o ipcRenderer.
// Os nomes dos canais repetem os de src/main/channels.js.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('EchoDesktop', {
  platform: process.platform,

  /** { version, platform, isPackaged } */
  getInfo: () => ipcRenderer.invoke('echo:app:info'),

  /** { minimizeToTray, openAtLogin } */
  getSettings: () => ipcRenderer.invoke('echo:settings:get'),
  setSetting: (key, value) => ipcRenderer.invoke('echo:settings:set', key, value),

  /** Aviso do sistema: { title, body, tag }. O `tag` volta em onNotificationClick. */
  notify: (notification) => ipcRenderer.invoke('echo:notify', notification),
  onNotificationClick(callback) {
    const listener = (_event, tag) => callback(tag);
    ipcRenderer.on('echo:notification:click', listener);
    return () => ipcRenderer.removeListener('echo:notification:click', listener);
  },

  /** Quantas conversas têm mensagem nova (0 limpa o indicador). */
  setBadgeCount: (count) => ipcRenderer.invoke('echo:badge:set', count),

  /** Cores dos botões da janela: { color: '#rrggbb', symbolColor: '#rrggbb' }. */
  setTitleBarColors: (colors) => ipcRenderer.invoke('echo:titlebar:colors', colors),
});
