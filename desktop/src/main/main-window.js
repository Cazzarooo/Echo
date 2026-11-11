const { app, BrowserWindow, desktopCapturer, nativeTheme, screen } = require('electron');
const path = require('node:path');
const { lockDown } = require('./security');

const DEFAULT_SIZE = { width: 1180, height: 760 };
const MIN_SIZE = { width: 880, height: 560 };
/** Altura da faixa de título; igual a --titlebar-h em web/assets/styles.css. */
const TITLEBAR_HEIGHT = 36;
/** Cores iniciais, antes de a interface web informar as dela (mesmos valores do CSS). */
const CHROME = {
  light: { background: '#F0F4F8', color: '#D5DEE9', symbolColor: '#0B132B' },
  dark: { background: '#0B132B', color: '#060C1D', symbolColor: '#F0F4F8' },
};

/** Reaproveita tamanho e posição da última vez, desde que a janela ainda caia em algum monitor. */
function restoredBounds(saved) {
  if (!saved) return DEFAULT_SIZE;
  const width = Math.max(MIN_SIZE.width, Math.round(saved.width));
  const height = Math.max(MIN_SIZE.height, Math.round(saved.height));
  const onScreen = screen.getAllDisplays().some(({ workArea }) => {
    const grabbable = 120; // quanto da barra de título precisa ficar ao alcance do mouse
    return (
      saved.x + width > workArea.x + grabbable &&
      saved.x < workArea.x + workArea.width - grabbable &&
      saved.y >= workArea.y - 8 &&
      saved.y < workArea.y + workArea.height - grabbable
    );
  });
  return onScreen ? { x: Math.round(saved.x), y: Math.round(saved.y), width, height } : { width, height };
}

/**
 * Janela principal: carrega a interface que o servidor entrega. A página roda
 * isolada (sem Node) e só fala com o sistema pela ponte do preload.
 */
function createMainWindow({ origin, settings, icon }) {
  const chrome = nativeTheme.shouldUseDarkColors ? CHROME.dark : CHROME.light;
  const isMac = process.platform === 'darwin';

  const window = new BrowserWindow({
    ...restoredBounds(settings.get('windowBounds')),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: 'Echo',
    icon,
    backgroundColor: chrome.background,
    // Sem moldura do sistema: a faixa de título é desenhada pela interface web
    // e o sistema põe os botões de minimizar/maximizar/fechar por cima dela.
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? {} : { titleBarOverlay: { color: chrome.color, symbolColor: chrome.symbolColor, height: TITLEBAR_HEIGHT } }),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'main.js'),
      partition: 'persist:echo',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  lockDown(window.webContents, origin);

  // Compartilhar a tela numa chamada: por enquanto entrega a tela principal inteira (sem seletor de janela).
  window.webContents.session.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => callback(sources.length > 0 ? { video: sources[0] } : {}))
      .catch(() => callback({}));
  });

  let saveTimer = null;
  const rememberBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (window.isDestroyed()) return;
      settings.set('windowMaximized', window.isMaximized());
      settings.set('windowBounds', window.getNormalBounds());
    }, 300);
  };
  for (const event of ['resize', 'move', 'maximize', 'unmaximize']) window.on(event, rememberBounds);
  window.on('closed', () => clearTimeout(saveTimer));

  if (!app.isPackaged) {
    // Em desenvolvimento, F12 abre as ferramentas do navegador.
    window.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') window.webContents.toggleDevTools();
    });
  }

  return window;
}

module.exports = { createMainWindow };
