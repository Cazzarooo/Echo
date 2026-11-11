const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeServerUrl } = require('./security');

const DEFAULTS = Object.freeze({
  /** Onde está o servidor Echo; a interface inteira vem de lá. */
  serverUrl: 'http://127.0.0.1:3210',
  /** Fechar a janela mantém o aplicativo na bandeja. */
  minimizeToTray: true,
  /** { x, y, width, height } da última vez, ou null. */
  windowBounds: null,
  windowMaximized: false,
});

function sanitize(saved) {
  const values = { ...DEFAULTS };
  if (saved === null || typeof saved !== 'object') return values;

  values.serverUrl = normalizeServerUrl(saved.serverUrl) ?? DEFAULTS.serverUrl;
  if (typeof saved.minimizeToTray === 'boolean') values.minimizeToTray = saved.minimizeToTray;
  if (typeof saved.windowMaximized === 'boolean') values.windowMaximized = saved.windowMaximized;

  const bounds = saved.windowBounds;
  if (bounds && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key]))) {
    values.windowBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  }
  return values;
}

/** Preferências da casca, guardadas em settings.json na pasta de dados do usuário. */
function createSettings() {
  const file = path.join(app.getPath('userData'), 'settings.json');
  let values;
  try {
    values = sanitize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    values = sanitize(null); // primeira vez, ou arquivo ilegível: começa do padrão
  }
  let pending = null;

  function flush() {
    clearTimeout(pending);
    pending = null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Escreve num temporário e troca de uma vez, para nunca deixar o arquivo pela metade.
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(values, null, 2));
      fs.renameSync(`${file}.tmp`, file);
    } catch (error) {
      console.error('[echo] não foi possível salvar as preferências:', error.message);
    }
  }

  return {
    get: (key) => values[key],
    set(key, value) {
      values[key] = value;
      pending ??= setTimeout(flush, 400);
    },
    flush,
  };
}

module.exports = { createSettings };
