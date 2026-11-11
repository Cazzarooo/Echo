// Canais de IPC entre o processo principal e as páginas. Os preloads rodam em
// sandbox e não conseguem importar este arquivo, então repetem os nomes;
// desktop/test/channels.test.mjs garante que os dois lados batem.

module.exports = Object.freeze({
  // Janela principal -> processo principal (invoke)
  APP_INFO: 'echo:app:info',
  SETTINGS_GET: 'echo:settings:get',
  SETTINGS_SET: 'echo:settings:set',
  NOTIFY: 'echo:notify',
  BADGE_SET: 'echo:badge:set',
  TITLEBAR_COLORS: 'echo:titlebar:colors',
  // Processo principal -> janela principal
  NOTIFICATION_CLICK: 'echo:notification:click',

  // Tela de abertura
  SPLASH_STATE: 'echo:splash:state',
  SPLASH_RETRY: 'echo:splash:retry',
  SPLASH_SET_SERVER: 'echo:splash:set-server',
  SPLASH_EDITING: 'echo:splash:editing',
  SPLASH_QUIT: 'echo:splash:quit',
});
