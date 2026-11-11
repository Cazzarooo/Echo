// Os preloads rodam em sandbox e repetem os nomes dos canais de IPC em vez de
// importá-los. Este teste impede que os dois lados saiam de sincronia.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const desktopDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const channels = createRequire(import.meta.url)(path.join(desktopDir, 'src', 'main', 'channels.js'));

function channelsUsedBy(preloadFile) {
  const source = fs.readFileSync(path.join(desktopDir, 'src', 'preload', preloadFile), 'utf8');
  return new Set([...source.matchAll(/'(echo:[a-z:-]+)'/g)].map((match) => match[1]));
}

test('todo canal usado nos preloads existe no processo principal, e vice-versa', () => {
  const declared = new Set(Object.values(channels));
  const used = new Set([...channelsUsedBy('main.js'), ...channelsUsedBy('splash.js')]);

  assert.deepEqual([...used].filter((channel) => !declared.has(channel)), [], 'canais usados num preload, mas não declarados em channels.js');
  assert.deepEqual([...declared].filter((channel) => !used.has(channel)), [], 'canais declarados em channels.js, mas que nenhum preload usa');
});

test('a tela de abertura e a janela principal não dividem canais', () => {
  const shared = [...channelsUsedBy('main.js')].filter((channel) => channelsUsedBy('splash.js').has(channel));
  assert.deepEqual(shared, []);
});
