// Processo principal da casca desktop do Echo.
//
// A casca é fina de propósito: mostra uma tela de abertura enquanto procura o
// servidor, abre uma janela que carrega a interface vinda dele e oferece a essa
// interface, por uma ponte estreita (preload + IPC), o que só o sistema tem:
// avisos, bandeja, indicador de não lidas, cores da janela e preferências.

const { app, Menu, Notification, Tray, ipcMain, nativeImage, net } = require('electron');
const path = require('node:path');
const CH = require('./channels');
const { createLocalServer } = require('./local-server');
const { createMainWindow } = require('./main-window');
const { isLocalOrigin, normalizeServerUrl, sameOrigin } = require('./security');
const { createSettings } = require('./settings');
const { createSplashWindow } = require('./splash-window');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const RETRY_MS = 8000;
const PROBE_TIMEOUT_MS = 5000;
const LOCAL_SERVER_START_MS = 15_000;
const MAX_LIVE_NOTIFICATIONS = 20;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

// Verificação automática (scripts/smoke.mjs): trabalha numa pasta de dados só dela.
const smokeDir = process.env.ECHO_SMOKE_DIR || null;
if (smokeDir) app.setPath('userData', path.join(smokeDir, 'user-data'));
const smoke = smokeDir ? require('./smoke').createSmoke(smokeDir) : null;

const localServer = createLocalServer();
let settings = null;
let splash = null;
let mainWindow = null;
let tray = null;
let icons = null;
/** Origem do servidor carregado na janela principal; a ponte só atende páginas dela. */
let serverOrigin = null;
/** ECHO_SERVER_URL vale até a pessoa escolher outro endereço na tela de abertura. */
let serverOverride = normalizeServerUrl(process.env.ECHO_SERVER_URL);
let quitting = false;
let editingServer = false;
let retryTimer = null;
let connectRun = 0;
const liveNotifications = new Set();

const configuredServer = () => serverOverride ?? settings.get('serverUrl');

function reveal(window) {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function quit() {
  quitting = true;
  app.quit();
}

// --- conexão com o servidor --------------------------------------------------

async function probeServer(origin) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await net.fetch(`${origin}/api/health`, { signal: controller.signal });
    const body = response.ok ? await response.json() : null;
    if (body?.ok === true && body.name === 'echo') return { ok: true };
    return { ok: false, message: 'Esse endereço respondeu, mas não é um servidor Echo.' };
  } catch {
    return { ok: false, message: 'Não foi possível falar com o servidor.' };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Sem servidor no endereço local configurado, sobe o embutido e espera ele
 * atender. É o caminho normal do aplicativo instalado.
 */
async function startLocalServer(origin, isStale) {
  const { port } = new URL(origin);
  localServer.start(port || 80);
  const deadline = Date.now() + LOCAL_SERVER_START_MS;
  while (Date.now() < deadline && localServer.isRunning() && !isStale()) {
    const probe = await probeServer(origin);
    if (probe.ok) return probe;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return {
    ok: false,
    message: localServer.isRunning()
      ? 'O servidor local demorou demais para responder.'
      : `Não foi possível iniciar o servidor local. A porta ${port || 80} pode estar em uso por outro programa.`,
  };
}

const canHostLocally = (origin) => origin.startsWith('http://') && isLocalOrigin(origin) && localServer.isAvailable();

function tellSplash(state) {
  if (!splash) {
    const created = createSplashWindow({ icon: icons.app });
    created.window.on('closed', () => {
      if (splash === created) splash = null;
    });
    splash = created;
  }
  splash.setState(state);
}

function closeSplash() {
  const current = splash;
  splash = null;
  if (current && !current.window.isDestroyed()) current.window.close();
}

/** Procura o servidor e, achando, troca a tela de abertura pela janela principal. */
async function connect() {
  clearTimeout(retryTimer);
  const run = ++connectRun;
  const stale = () => run !== connectRun || quitting;
  const origin = configuredServer();

  tellSplash({ phase: 'checking', serverUrl: origin });
  let probe = await probeServer(origin);
  if (stale()) return;
  if (!probe.ok && canHostLocally(origin)) {
    tellSplash({ phase: 'starting', serverUrl: origin });
    probe = await startLocalServer(origin, stale);
    if (stale()) return;
  }
  if (!probe.ok) return connectFailed(origin, probe.message);

  tellSplash({ phase: 'loading', serverUrl: origin });
  if (smoke) await smoke.capture(splash.window, 'splash.png');
  try {
    await openMainWindow(origin);
  } catch {
    if (!stale()) connectFailed(origin, 'O servidor respondeu, mas a interface não abriu.');
    return;
  }
  closeSplash();
  if (smoke) await smoke.reportConnected(mainWindow, { localServer: localServer.isRunning() });
}

function connectFailed(origin, message) {
  const state = { phase: 'error', serverUrl: origin, message };
  tellSplash(state);
  if (smoke) {
    smoke.reportFailure(splash.window, state);
    return;
  }
  scheduleRetry();
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    // Com o formulário de endereço aberto, espera a pessoa terminar.
    if (editingServer) scheduleRetry();
    else connect();
  }, RETRY_MS);
}

// --- janela principal e bandeja ----------------------------------------------

async function openMainWindow(origin) {
  const window = createMainWindow({ origin, settings, icon: icons.app });
  serverOrigin = origin;
  mainWindow = window;

  window.on('close', (event) => {
    // Fechar a janela só esconde, se a pessoa quis manter o Echo na bandeja.
    if (quitting || !tray || !settings.get('minimizeToTray')) return;
    event.preventDefault();
    window.hide();
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  try {
    await window.loadURL(`${origin}/app`);
  } catch (error) {
    mainWindow = null;
    window.destroy();
    throw error;
  }
  if (settings.get('windowMaximized')) window.maximize();
  window.show();
  ensureTray();
}

function ensureTray() {
  if (tray) return;
  tray = new Tray(icons.tray);
  tray.setToolTip('Echo');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir o Echo', click: () => reveal(mainWindow) },
      { type: 'separator' },
      { label: 'Sair', click: quit },
    ]),
  );
  tray.on('click', () => reveal(mainWindow));
}

// --- ponte com a interface web -----------------------------------------------

/** Só o quadro principal da janela principal, e só se ainda estiver na página do servidor. */
function isFromApp(event) {
  const frame = event.senderFrame;
  return (
    mainWindow !== null &&
    !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents &&
    frame !== null &&
    frame.parent === null &&
    sameOrigin(frame.url, serverOrigin)
  );
}

function handleFromApp(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isFromApp(event)) throw new Error('Remetente não autorizado.');
    return handler(...args);
  });
}

const isFromSplash = (event) => splash !== null && !splash.window.isDestroyed() && event.sender === splash.window.webContents;

const clip = (value, maxLength) => (typeof value === 'string' ? value.slice(0, maxLength) : '');

// Rodando sem empacotar, "abrir com o computador" precisa apontar para o Electron mais a pasta do app.
const loginItem = () => (app.isPackaged ? {} : { path: process.execPath, args: [app.getAppPath()] });

function readSettings() {
  return {
    minimizeToTray: settings.get('minimizeToTray'),
    openAtLogin: app.getLoginItemSettings(loginItem()).openAtLogin,
  };
}

function registerBridge() {
  handleFromApp(CH.APP_INFO, () => ({ version: app.getVersion(), platform: process.platform, isPackaged: app.isPackaged }));

  handleFromApp(CH.SETTINGS_GET, readSettings);
  handleFromApp(CH.SETTINGS_SET, (key, value) => {
    if (typeof value !== 'boolean') throw new Error('Valor inválido.');
    if (key === 'minimizeToTray') settings.set('minimizeToTray', value);
    else if (key === 'openAtLogin') app.setLoginItemSettings({ openAtLogin: value, ...loginItem() });
    else throw new Error('Opção desconhecida.');
    return readSettings();
  });

  handleFromApp(CH.NOTIFY, (payload) => {
    const title = clip(payload?.title, 80);
    if (!title || !Notification.isSupported()) return false;
    const tag = clip(payload?.tag, 40);
    const notification = new Notification({ title, body: clip(payload?.body, 240), icon: icons.app });

    // Guarda a referência enquanto o aviso existe; sem isso o clique pode se perder.
    liveNotifications.add(notification);
    if (liveNotifications.size > MAX_LIVE_NOTIFICATIONS) liveNotifications.delete(liveNotifications.values().next().value);
    notification.on('close', () => liveNotifications.delete(notification));
    notification.on('click', () => {
      liveNotifications.delete(notification);
      reveal(mainWindow);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(CH.NOTIFICATION_CLICK, tag);
    });
    notification.show();
    return true;
  });

  handleFromApp(CH.BADGE_SET, (count) => {
    const unread = Number.isInteger(count) && count > 0 ? Math.min(count, 9999) : 0;
    const label = unread === 1 ? '1 conversa com mensagens novas' : `${unread} conversas com mensagens novas`;
    if (process.platform === 'win32') mainWindow.setOverlayIcon(unread ? icons.badge : null, unread ? label : '');
    else app.setBadgeCount(unread);
    tray?.setToolTip(unread ? `Echo: ${label}` : 'Echo');
  });

  handleFromApp(CH.TITLEBAR_COLORS, (colors) => {
    if (!HEX_COLOR.test(colors?.color) || !HEX_COLOR.test(colors?.symbolColor)) throw new Error('Cor inválida.');
    if (process.platform !== 'darwin') mainWindow.setTitleBarOverlay({ color: colors.color, symbolColor: colors.symbolColor });
  });

  ipcMain.on(CH.SPLASH_RETRY, (event) => {
    if (isFromSplash(event)) connect();
  });
  ipcMain.on(CH.SPLASH_EDITING, (event, editing) => {
    if (isFromSplash(event)) editingServer = editing === true;
  });
  ipcMain.on(CH.SPLASH_QUIT, (event) => {
    if (isFromSplash(event)) quit();
  });
  ipcMain.handle(CH.SPLASH_SET_SERVER, (event, url) => {
    if (!isFromSplash(event)) throw new Error('Remetente não autorizado.');
    const origin = normalizeServerUrl(url);
    if (!origin) return false;
    settings.set('serverUrl', origin);
    serverOverride = null;
    editingServer = false;
    connect();
    return true;
  });
}

// --- ciclo de vida -------------------------------------------------------------

function start() {
  // No Windows os avisos precisam de um identificador do aplicativo; em desenvolvimento serve o próprio executável.
  app.setAppUserModelId(app.isPackaged ? 'app.echo.desktop' : process.execPath);
  settings = createSettings();
  icons = {
    app: nativeImage.createFromPath(path.join(ASSETS, 'icon.png')),
    tray: nativeImage.createFromPath(path.join(ASSETS, 'tray.png')),
    badge: nativeImage.createFromPath(path.join(ASSETS, 'badge.png')),
  };
  // Sem barra de menus; no macOS ficam os menus padrão, que dão os atalhos de copiar e colar.
  Menu.setApplicationMenu(
    process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null,
  );
  registerBridge();
  connect();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Abrir o Echo de novo só traz a janela que já existe para a frente.
  app.on('second-instance', () => reveal(mainWindow ?? splash?.window));
  app.on('activate', () => reveal(mainWindow ?? splash?.window));
  app.on('before-quit', () => {
    quitting = true;
    clearTimeout(retryTimer);
    settings?.flush();
  });
  app.on('will-quit', () => localServer.stop());
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.whenReady().then(start);
}
