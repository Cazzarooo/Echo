// `npm start`: sobe o servidor (se ainda não houver um no ar) e abre a casca
// desktop apontando para ele. Fechar o aplicativo encerra o servidor que este
// script iniciou.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.ECHO_PORT ?? 3210);
const serverUrl = `http://127.0.0.1:${port}`;

async function serverIsUp() {
  try {
    const response = await fetch(`${serverUrl}/api/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok && (await response.json()).name === 'echo';
  } catch {
    return false;
  }
}

let server = null;
if (await serverIsUp()) {
  console.log(`[dev] já existe um servidor Echo em ${serverUrl}; vou usar esse.`);
} else {
  server = spawn(process.execPath, [path.join(root, 'server', 'src', 'index.js')], { stdio: 'inherit' });
  for (let attempt = 0; attempt < 50 && !(await serverIsUp()); attempt++) {
    if (server.exitCode !== null) process.exit(server.exitCode);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

// O pacote `electron` exporta o caminho do executável (e o baixa na primeira vez).
const electronPath = createRequire(import.meta.url)('electron');
const desktop = spawn(electronPath, [path.join(root, 'desktop')], {
  stdio: 'inherit',
  env: { ...process.env, ECHO_SERVER_URL: process.env.ECHO_SERVER_URL ?? serverUrl },
});

function shutdown() {
  server?.kill();
  desktop.kill();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

desktop.on('exit', (code) => {
  server?.kill();
  process.exit(code ?? 0);
});
