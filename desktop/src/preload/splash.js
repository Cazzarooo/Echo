// Preload da tela de abertura. Os nomes dos canais repetem os de src/main/channels.js.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('EchoSplash', {
  /** Recebe { phase: 'checking' | 'starting' | 'loading' | 'error', serverUrl, message? }. */
  onState: (callback) => ipcRenderer.on('echo:splash:state', (_event, state) => callback(state)),
  retry: () => ipcRenderer.send('echo:splash:retry'),
  setServer: (url) => ipcRenderer.invoke('echo:splash:set-server', url),
  /** Enquanto a pessoa digita outro endereço, as tentativas automáticas esperam. */
  setEditing: (editing) => ipcRenderer.send('echo:splash:editing', editing),
  quit: () => ipcRenderer.send('echo:splash:quit'),
});
