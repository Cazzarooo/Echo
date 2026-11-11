import { loadLatest } from './actions.js';
import { api } from './api.js';
import { desktop, initDesktop } from './desktop.js';
import { h, toast } from './dom.js';
import { createGateway } from './gateway.js';
import { applyEvent, findChannel, resetState, selectChannel, setBootstrap, setConnection, state, subscribe, unreadChannelCount } from './state.js';
import { renderAuth } from './views/auth.js';
import { renderShell } from './views/shell.js';

const root = document.getElementById('root');
let gateway = null;
let shell = null;

async function boot() {
  let data;
  try {
    data = await api.bootstrap();
  } catch (failure) {
    if (failure.status === 401) showAuth();
    else showBootError(failure);
    return;
  }
  enter(data);
}

function showAuth() {
  leave();
  renderAuth(root, { onAuthenticated: boot });
}

function showBootError(failure) {
  root.replaceChildren(
    h(
      'div',
      { class: 'welcome' },
      h('h1', { class: 'welcome__title' }, 'Não deu para abrir o Echo.'),
      h('p', { class: 'welcome__text' }, failure.message),
      h('div', { class: 'welcome__actions' }, h('button', { class: 'button', type: 'button', onclick: boot }, 'Tentar de novo')),
    ),
  );
}

function enter(data) {
  setBootstrap(data);
  if (!shell) shell = renderShell(root, { sendToGateway: (event) => gateway?.send(event), onLogout: logout });
  if (!gateway) {
    gateway = createGateway({ onEvent: applyEvent, onStatus: onGatewayStatus });
    gateway.connect();
  }
}

/** Desmonta a sessão local: usado ao sair e quando o servidor diz que a sessão acabou. */
function leave() {
  gateway?.close();
  gateway = null;
  shell?.destroy();
  shell = null;
  resetState();
  updateUnreadSignals();
}

async function logout() {
  try {
    await api.logout();
  } catch (failure) {
    toast(failure.message, 'error');
    return;
  }
  showAuth();
}

function onGatewayStatus(status) {
  setConnection(status);
  // A cada (re)conexão, pega a foto atual do servidor: cobre o que passou enquanto estava fora.
  if (status === 'online') resync();
  // Conexão recusada pode ser sessão encerrada em outro lugar; uma consulta simples tira a dúvida.
  if (status === 'offline') checkSession();
}

async function resync() {
  try {
    setBootstrap(await api.bootstrap());
    if (state.activeChannelId !== null) await loadLatest(state.activeChannelId);
  } catch (failure) {
    if (failure.status === 401) showAuth();
  }
}

async function checkSession() {
  try {
    await api.bootstrap();
  } catch (failure) {
    if (failure.status === 401) showAuth();
  }
}

function updateUnreadSignals() {
  const count = state.user ? unreadChannelCount() : 0;
  document.title = count > 0 ? `(${count}) Echo` : 'Echo';
  desktop.setBadgeCount(count);
}

function notifyIfAway({ message, live }) {
  if (!live || message.author.id === state.user.id) return;
  const watching = document.hasFocus() && message.channelId === state.activeChannelId;
  if (watching) return;
  const found = findChannel(message.channelId);
  if (!found) return;
  const preview = message.content.length > 160 ? `${message.content.slice(0, 159)}…` : message.content;
  desktop.notify({
    title: `${message.author.displayName} em #${found.channel.name}`,
    body: preview,
    tag: String(message.channelId),
  });
}

subscribe((topic, detail) => {
  if (topic === 'unread' || topic === 'spaces') updateUnreadSignals();
  if (topic === 'message') notifyIfAway(detail);
  if (topic === 'resync') resync();
});

desktop.onNotificationClick((tag) => selectChannel(Number(tag)));

initDesktop();
boot();
