// Ponte com a casca desktop. No navegador comum `window.EchoDesktop` não
// existe e tudo aqui vira "não faz nada": a interface é a mesma nos dois.

const bridge = window.EchoDesktop ?? null;

export const isDesktop = bridge !== null;

function syncTitleBarColors() {
  const styles = getComputedStyle(document.documentElement);
  bridge
    .setTitleBarColors({
      color: styles.getPropertyValue('--chrome').trim(),
      symbolColor: styles.getPropertyValue('--ink').trim(),
    })
    .catch(() => {});
}

export function initDesktop() {
  if (!bridge) return;
  document.documentElement.classList.add('is-desktop', `platform-${bridge.platform}`);
  document.getElementById('titlebar').hidden = false;
  syncTitleBarColors();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncTitleBarColors);
}

export const desktop = {
  notify: (notification) => bridge?.notify(notification).catch(() => {}),
  setBadgeCount: (count) => bridge?.setBadgeCount(count).catch(() => {}),
  onNotificationClick: (callback) => bridge?.onNotificationClick(callback),
  getSettings: () => bridge.getSettings(),
  setSetting: (key, value) => bridge.setSetting(key, value),
  getInfo: () => bridge.getInfo(),
};
