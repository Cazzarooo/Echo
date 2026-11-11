const { BrowserWindow, nativeTheme } = require('electron');
const path = require('node:path');
const CH = require('./channels');

/**
 * Tela de abertura: fica à vista enquanto a casca procura o servidor, e é por
 * ela que a pessoa tenta de novo ou aponta para outro endereço.
 */
function createSplashWindow({ icon }) {
  const window = new BrowserWindow({
    width: 360,
    height: 440,
    center: true,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Echo',
    icon,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0B132B' : '#F0F4F8',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'splash.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // É uma página local e fixa: não navega nem abre nada.
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  let state = null;
  // O estado pode chegar antes de a página carregar; nesse caso é reenviado quando ela fica pronta.
  window.webContents.on('did-finish-load', () => {
    if (state) window.webContents.send(CH.SPLASH_STATE, state);
  });
  window.once('ready-to-show', () => window.show());
  window.loadFile(path.join(__dirname, '..', 'splash', 'index.html'));

  return {
    window,
    setState(next) {
      state = next;
      if (!window.isDestroyed()) window.webContents.send(CH.SPLASH_STATE, next);
    },
  };
}

module.exports = { createSplashWindow };
