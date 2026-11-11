// `npm run smoke`: verifica a casca desktop de ponta a ponta, abrindo o Electron de verdade.
//
//  1. Com um servidor de teste no ar, a casca carrega a interface, a ponte
//     (window.EchoDesktop) responde e recusa o que não deve, e dá para entrar e conversar.
//  2. Sem servidor no endereço local, a casca sobe o servidor embutido e funciona sozinha.
//  3. Com o servidor embutido desligado e nada no ar, fica na tela de abertura dizendo o que houve.
//
// As janelas aparecem por alguns segundos. Capturas e relatórios ficam em .smoke/.
//
// Para verificar o aplicativo já empacotado em vez do código-fonte:
//   ECHO_SMOKE_EXE=dist/win-unpacked/Echo.exe npm run smoke

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/src/app.js';
import { loadConfig } from '../server/src/config.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.smoke');
const TIMEOUT_MS = 90_000;

const packagedExe = process.env.ECHO_SMOKE_EXE ? path.resolve(process.env.ECHO_SMOKE_EXE) : null;
const [command, args] = packagedExe
  ? [packagedExe, []]
  : [createRequire(import.meta.url)('electron'), [path.join(root, 'desktop')]];

function runDesktop(name, serverUrl, extraEnv = {}) {
  const directory = path.join(outDir, name);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: { ...process.env, ECHO_SMOKE_DIR: directory, ECHO_SERVER_URL: serverUrl, ...extraEnv },
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`a casca não concluiu a verificação "${name}" em ${TIMEOUT_MS / 1000} s`));
    }, TIMEOUT_MS);
    child.on('exit', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(fs.readFileSync(path.join(directory, 'report.json'), 'utf8')));
      } catch {
        reject(new Error(`a verificação "${name}" terminou sem gerar relatório`));
      }
    });
  });
}

/** Uma porta de 127.0.0.1 que está livre agora. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function assertSignedIn(report) {
  assert.equal(report.connected, true, 'a casca deveria ter aberto a interface');
  assert.equal(report.error, undefined, `a ponte falhou: ${report.error}`);
  assert.equal(report.signedIn.shellShown, true, 'depois de entrar, a tela principal deveria aparecer');
  assert.equal(report.signedIn.channel, 'geral');
  assert.deepEqual(report.signedIn.messages, ['A casca desktop abriu, entrou e conversou.']);
}

fs.rmSync(outDir, { recursive: true, force: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-smoke-'));
const config = loadConfig({});
config.port = 0;
config.dbFile = path.join(dataDir, 'echo.sqlite');
const server = createApp(config);
const { port } = await server.listen();
const serverUrl = `http://127.0.0.1:${port}`;

console.log(`[smoke] verificando ${packagedExe ? `o aplicativo empacotado (${packagedExe})` : 'o código-fonte da casca'}`);

try {
  // 1. Servidor de teste já no ar. Ele é temporário, então a casca pode criar uma conta descartável.
  const online = await runDesktop('conectado', serverUrl, { ECHO_SMOKE_SIGNUP: '1' });
  assertSignedIn(online);
  assert.equal(online.localServer, false, 'havendo servidor no ar, o embutido não deve subir');
  const { bridge } = online;
  assert.equal(bridge.url, `${serverUrl}/app`);
  assert.equal(bridge.desktopClass, true, 'a interface deveria saber que está na casca');
  assert.equal(bridge.titlebarShown, true);
  assert.equal(bridge.nodeLeaked, false, 'a página não pode enxergar o Node');
  assert.deepEqual(bridge.bridgeKeys, [
    'getInfo',
    'getSettings',
    'notify',
    'onNotificationClick',
    'platform',
    'setBadgeCount',
    'setSetting',
    'setTitleBarColors',
  ]);
  assert.equal(bridge.info.version, '0.1.0');
  assert.equal(bridge.info.isPackaged, packagedExe !== null);
  assert.deepEqual(Object.keys(bridge.settings).sort(), ['minimizeToTray', 'openAtLogin']);
  assert.equal(bridge.setBadge, 'accepted');
  assert.equal(bridge.setColors, 'accepted');
  assert.equal(bridge.badColor, 'rejected', 'cor fora do formato tem de ser recusada');
  assert.equal(bridge.unknownSetting, 'rejected', 'a página não pode mexer em opções que não são dela');
  assert.equal(bridge.nonBooleanSetting, 'rejected');
  console.log('[smoke] 1/3 conectado a um servidor: interface, ponte e conversa funcionando.', online.captures);

  // 2. Nada no ar numa porta local livre: a casca tem de subir o servidor embutido.
  const ownUrl = `http://127.0.0.1:${await freePort()}`;
  const selfHosted = await runDesktop('servidor-embutido', ownUrl, { ECHO_SMOKE_SIGNUP: '1' });
  assertSignedIn(selfHosted);
  assert.equal(selfHosted.localServer, true, 'a casca deveria ter subido o servidor embutido');
  assert.equal(selfHosted.bridge.url, `${ownUrl}/app`);
  console.log('[smoke] 2/3 sem servidor no ar: o embutido subiu e a conversa funcionou.', selfHosted.captures);

  // 3. Embutido desligado e nada escutando (porta 9): tem de avisar na tela de abertura.
  const offline = await runDesktop('sem-servidor', 'http://127.0.0.1:9', { ECHO_NO_LOCAL_SERVER: '1' });
  assert.equal(offline.connected, false);
  assert.equal(offline.splash.phase, 'error');
  assert.equal(offline.splash.serverUrl, 'http://127.0.0.1:9');
  console.log(`[smoke] 3/3 sem servidor nenhum: a tela de abertura avisa "${offline.splash.message}"`, offline.captures);

  console.log(`[smoke] tudo certo. Capturas em ${path.relative(process.cwd(), outDir)}`);
} finally {
  await server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
