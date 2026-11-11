import { loadLatest, loadOlder, markRead, sendMessage } from '../actions.js';
import { h, icon, toast } from '../dom.js';
import { joinNames } from '../format.js';
import { activeChannel, activeSpace, historyOf, state, subscribe, typingNames } from '../state.js';
import { createComposer } from './composer.js';
import { promptCreateSpace, promptJoinSpace } from './dialogs.js';
import { createMembers } from './members.js';
import { createSidebar } from './sidebar.js';
import { createTimeline } from './timeline.js';
import { createVoiceStage } from './voice-stage.js';

const MEMBERS_KEY = 'echo:membros';
const TYPING_SIGNAL_MS = 3000;
const BANNER_DELAY_MS = 5000;

// Abaixo desta largura o painel de membros vira gaveta por cima da conversa.
const isNarrow = () => window.innerWidth <= 1000;

function loadMembersOpen() {
  // Em tela estreita a gaveta sempre começa fechada, para não tapar a conversa.
  if (isNarrow()) return false;
  try {
    const saved = localStorage.getItem(MEMBERS_KEY);
    if (saved !== null) return saved === '1';
  } catch {
    /* sem armazenamento local: fica aberto */
  }
  return true;
}

const report = (failure) => toast(failure.message, 'error');

/** A tela principal: barra lateral, conversa e painel de membros. */
export function renderShell(root, { sendToGateway, onLogout }) {
  let shownChannelId = null;
  let lastTypingSignal = 0;
  let bannerTimer = null;
  let membersOpen = loadMembersOpen();

  const sidebar = createSidebar({ onNavigate: () => setNavOpen(false), onLogout });
  const members = createMembers();
  const stage = createVoiceStage();
  const timeline = createTimeline({
    onNearTop: () => {
      if (state.activeChannelId !== null) loadOlder(state.activeChannelId).catch(report);
    },
    onReachBottom: () => {
      jump.hidden = true;
      readIfWatching();
    },
  });
  const composer = createComposer({
    onSend: sendMessage,
    onTyping: () => {
      const now = Date.now();
      if (state.activeChannelId === null || now - lastTypingSignal < TYPING_SIGNAL_MS) return;
      lastTypingSignal = now;
      sendToGateway({ type: 'typing', channelId: state.activeChannelId });
    },
  });

  const title = h('h1', { class: 'main__channel' });
  const spaceName = h('span', { class: 'main__space' });
  const membersButton = h(
    'button',
    { class: 'icon-button', type: 'button', title: 'Quem está na roda', 'aria-label': 'Mostrar ou esconder quem está na roda', onclick: () => toggleMembers() },
    icon('people'),
  );
  const head = h(
    'header',
    { class: 'main__head' },
    h('button', { class: 'icon-button only-narrow', type: 'button', 'aria-label': 'Abrir rodas e canais', onclick: () => setNavOpen(true) }, icon('menu')),
    h('div', { class: 'main__title' }, title, spaceName),
    membersButton,
  );
  const banner = h('div', { class: 'banner', role: 'status', hidden: true }, 'Sem conexão com o servidor. Tentando de novo…');
  const jump = h('button', { class: 'jump', type: 'button', hidden: true, onclick: () => timeline.scrollToBottom() }, icon('down', 14), 'Mensagens novas');
  const typing = h('div', { class: 'typing', 'aria-live': 'polite' });
  const welcome = h(
    'div',
    { class: 'welcome', hidden: true },
    h('h2', { class: 'welcome__title' }, 'Puxe uma cadeira.'),
    h('p', { class: 'welcome__text' }, 'No Echo as conversas acontecem em rodas, e cada roda tem seus canais. Crie a sua ou entre em uma com o código de convite que te passaram.'),
    h(
      'div',
      { class: 'welcome__actions' },
      h('button', { class: 'button', type: 'button', onclick: promptCreateSpace }, 'Criar uma roda'),
      h('button', { class: 'button button--quiet', type: 'button', onclick: promptJoinSpace }, 'Entrar com convite'),
    ),
  );
  const main = h('main', { class: 'main' }, head, banner, timeline.element, jump, typing, composer.element, stage.element, welcome);
  const scrim = h('button', { class: 'scrim', type: 'button', 'aria-label': 'Fechar rodas e canais', onclick: () => setNavOpen(false) });
  const shell = h('div', { class: 'shell' }, sidebar.element, main, members.element, scrim);

  function setNavOpen(open) {
    shell.classList.toggle('is-nav-open', open);
  }

  function layoutMembers() {
    // Sem canal aberto (tela de boas-vindas) o painel não tem o que mostrar.
    shell.classList.toggle('is-members-closed', !membersOpen || state.activeChannelId === null);
  }

  function setMembersOpen(open) {
    membersOpen = open;
    layoutMembers();
    membersButton.setAttribute('aria-pressed', String(open));
  }

  function toggleMembers() {
    setMembersOpen(!membersOpen);
    // Abrir a gaveta na tela estreita é coisa do momento; só a escolha feita na tela larga fica guardada.
    if (isNarrow()) return;
    try {
      localStorage.setItem(MEMBERS_KEY, membersOpen ? '1' : '0');
    } catch {
      /* preferência só desta visita */
    }
  }

  /** Só conta como lido se a pessoa está de fato olhando o fim da conversa. */
  function readIfWatching() {
    if (activeChannel()?.kind === 'text' && document.hasFocus() && timeline.isAtBottom()) markRead(state.activeChannelId);
  }

  function showTyping() {
    const names = state.activeChannelId === null ? [] : typingNames(state.activeChannelId);
    if (names.length === 0) typing.textContent = '';
    else if (names.length === 1) typing.textContent = `${names[0]} está digitando…`;
    else typing.textContent = `${joinNames(names)} estão digitando…`;
  }

  function showActive() {
    const space = activeSpace();
    const channel = activeChannel();
    const hasChannel = channel !== null;

    // Canal de voz mostra o palco da chamada (voice-stage.js) no lugar da conversa escrita.
    const isText = hasChannel && channel.kind !== 'voice';
    title.textContent = hasChannel ? channel.name : '';
    title.hidden = !hasChannel;
    title.classList.toggle('main__channel--voice', hasChannel && !isText);
    spaceName.textContent = space ? space.name : '';
    for (const part of [timeline.element, typing, composer.element]) part.hidden = !isText;
    membersButton.hidden = !hasChannel;
    welcome.hidden = hasChannel;
    layoutMembers();

    if (!isText) {
      shownChannelId = null;
      jump.hidden = true;
      return;
    }
    composer.setChannel(channel);
    if (shownChannelId === channel.id) return;

    shownChannelId = channel.id;
    lastTypingSignal = 0;
    jump.hidden = true;
    showTyping();
    const history = historyOf(channel.id);
    if (history.loaded) {
      timeline.render(channel, history, 'bottom');
      readIfWatching();
    } else {
      timeline.showStatus('Abrindo a conversa…');
      loadLatest(channel.id).catch((failure) => {
        if (shownChannelId === channel.id) timeline.showStatus('Não foi possível abrir a conversa. Verifique a conexão.');
        report(failure);
      });
    }
    composer.focus();
  }

  const unsubscribe = subscribe((topic, detail) => {
    switch (topic) {
      case 'active':
      case 'spaces':
        showActive();
        break;
      case 'history': {
        const channel = activeChannel();
        if (!channel || detail.channelId !== channel.id) break;
        timeline.render(channel, historyOf(channel.id), detail.reason === 'older' ? 'position' : 'bottom');
        if (detail.reason !== 'older') readIfWatching();
        break;
      }
      case 'message': {
        const { message } = detail;
        if (message.channelId !== state.activeChannelId || !historyOf(message.channelId).loaded) break;
        const follow = timeline.isAtBottom() || message.author.id === state.user.id;
        timeline.append(message);
        if (follow) {
          timeline.scrollToBottom();
          readIfWatching();
        } else {
          jump.hidden = false;
        }
        break;
      }
      case 'typing':
        showTyping();
        break;
      case 'connection':
        // Quedas curtas são normais (servidores hospedados renovam a conexão de
        // tempos em tempos); o aviso só aparece se a reconexão demorar.
        if (state.connection === 'online') {
          clearTimeout(bannerTimer);
          bannerTimer = null;
          banner.hidden = true;
        } else if (state.connection === 'offline' && bannerTimer === null && banner.hidden) {
          bannerTimer = setTimeout(() => {
            bannerTimer = null;
            banner.hidden = false;
          }, BANNER_DELAY_MS);
        }
        break;
      default:
        break;
    }
  });

  window.addEventListener('focus', readIfWatching);

  root.replaceChildren(shell);
  setMembersOpen(membersOpen);
  showActive();

  return {
    destroy() {
      unsubscribe();
      clearTimeout(bannerTimer);
      sidebar.destroy();
      stage.destroy();
      members.destroy();
      window.removeEventListener('focus', readIfWatching);
    },
  };
}
