const { shell } = require('electron');

/** Aceita só http(s) sem usuário/senha e devolve a origem (sem caminho), ou null. */
function normalizeServerUrl(input) {
  let url;
  try {
    url = new URL(String(input ?? '').trim());
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
  return url.origin;
}

function isLocalOrigin(origin) {
  const { hostname } = new URL(origin);
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function sameOrigin(url, origin) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** Abre no navegador padrão, e só endereços http(s). */
function openExternal(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') shell.openExternal(parsed.href);
}

/**
 * Prende a janela ao servidor: links para fora vão para o navegador, nada de
 * janelas novas ou webviews, e só as permissões que o Echo usa: área de
 * transferência (copiar convite) e microfone, câmera e tela (chamadas).
 */
function lockDown(webContents, origin) {
  const leave = (event, url) => {
    if (sameOrigin(url, origin)) return;
    event.preventDefault();
    openExternal(url);
  };
  webContents.on('will-navigate', leave);
  webContents.on('will-redirect', leave);
  webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  webContents.on('will-attach-webview', (event) => event.preventDefault());

  // Tudo fora desta lista fica negado, e a lista só vale para a página do servidor.
  const allowed = new Set(['clipboard-sanitized-write', 'media', 'display-capture']);
  webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(contents === webContents && allowed.has(permission) && sameOrigin(details.requestingUrl, origin));
  });
  webContents.session.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    return allowed.has(permission) && sameOrigin(requestingOrigin, origin);
  });
}

module.exports = { isLocalOrigin, lockDown, normalizeServerUrl, openExternal, sameOrigin };
