// Verificação automática da casca (scripts/smoke.mjs). Só é carregado quando
// ECHO_SMOKE_DIR está definida: fotografa as janelas, pergunta à ponte o que
// ela responde, grava tudo num relatório e encerra o aplicativo.

const { app } = require('electron');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Roda dentro da página, como a interface web rodaria.
const BRIDGE_PROBE = `(async () => {
  const bridge = window.EchoDesktop;
  const outcome = (promise) => promise.then(() => 'accepted', () => 'rejected');
  return {
    url: location.href,
    desktopClass: document.documentElement.classList.contains('is-desktop'),
    titlebarShown: !document.getElementById('titlebar').hidden,
    nodeLeaked: typeof require !== 'undefined' || typeof process !== 'undefined',
    bridgeKeys: Object.keys(bridge ?? {}).sort(),
    info: await bridge.getInfo(),
    settings: await bridge.getSettings(),
    setBadge: await outcome(bridge.setBadgeCount(2)),
    setColors: await outcome(bridge.setTitleBarColors({ color: '#120F0D', symbolColor: '#F2EADF' })),
    badColor: await outcome(bridge.setTitleBarColors({ color: 'red', symbolColor: '#fff' })),
    unknownSetting: await outcome(bridge.setSetting('serverUrl', true)),
    nonBooleanSetting: await outcome(bridge.setSetting('minimizeToTray', 'sim')),
  };
})()`;

// Cria uma conta descartável, uma roda e uma mensagem, como a interface faria.
// Só roda com ECHO_SMOKE_SIGNUP=1, que o scripts/smoke.mjs liga apontando para
// um servidor temporário; nunca contra um servidor de verdade.
function signUpScript() {
  const username = `casca_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(12).toString('base64url');
  return `(async () => {
    const post = async (path, body) => {
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(path + ' respondeu ' + response.status);
      return response.json();
    };
    await post('/api/auth/register', { username: ${JSON.stringify(username)}, displayName: 'Teste da Casca', password: ${JSON.stringify(password)} });
    const { space } = await post('/api/spaces', { name: 'Roda de teste' });
    await post('/api/channels/' + space.channels[0].id + '/messages', { content: 'A casca desktop abriu, entrou e conversou.' });
    return true;
  })()`;
}

const SIGNED_IN_PROBE = `({
  shellShown: document.querySelector('.shell') !== null,
  channel: document.querySelector('.main__channel')?.textContent ?? null,
  messages: [...document.querySelectorAll('.msg__text')].map((node) => node.textContent),
  title: document.title,
})`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createSmoke(directory) {
  fs.mkdirSync(directory, { recursive: true });
  /** nome do arquivo -> 'ok' ou o motivo da falha. Captura é registro, não critério. */
  const captures = {};

  // A janela precisa estar carregada, visível e pintada; encoberta por outra, a captura falha.
  async function capture(window, name) {
    try {
      if (window.webContents.isLoading()) await new Promise((resolve) => window.webContents.once('did-finish-load', resolve));
      if (!window.isVisible()) await new Promise((resolve) => window.once('show', resolve));
      await delay(700);
      const image = await window.webContents.capturePage();
      fs.writeFileSync(path.join(directory, name), image.toPNG());
      captures[name] = 'ok';
    } catch (error) {
      captures[name] = `falhou: ${error.message}`;
    }
  }

  function finish(report) {
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ ...report, captures }, null, 2));
    app.exit(0);
  }

  return {
    capture,
    async reportConnected(mainWindow, facts = {}) {
      try {
        await delay(800);
        const contents = mainWindow.webContents;
        const bridge = await contents.executeJavaScript(BRIDGE_PROBE, true);
        await capture(mainWindow, 'main-window.png');

        let signedIn = null;
        if (process.env.ECHO_SMOKE_SIGNUP === '1') {
          await contents.executeJavaScript(signUpScript(), true);
          const reloaded = new Promise((resolve) => contents.once('did-finish-load', resolve));
          contents.reload();
          await reloaded;
          await delay(1500); // tempo de a interface buscar a conta e a conversa
          signedIn = await contents.executeJavaScript(SIGNED_IN_PROBE, true);
          await capture(mainWindow, 'main-window-signed-in.png');
        }
        finish({ connected: true, ...facts, bridge, signedIn });
      } catch (error) {
        finish({ connected: true, ...facts, error: error.message });
      }
    },
    async reportFailure(splashWindow, state) {
      await capture(splashWindow, 'splash-error.png');
      finish({ connected: false, splash: state });
    },
  };
}

module.exports = { createSmoke };
