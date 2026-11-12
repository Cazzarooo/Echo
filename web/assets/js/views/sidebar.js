import { isDesktop } from '../desktop.js';
import { avatar, h, icon } from '../dom.js';
import { activeSpace, isUnread, selectChannel, selectSpace, spaceHasUnread, state, subscribe } from '../state.js';
import { subscribeVoice, voice } from '../voice.js';
import { createVoiceBar } from './voice-stage.js';
import { openChannelDialog, openDesktopSettingsDialog, openInviteDialog, promptCreateChannel, promptCreateSpace, promptJoinSpace } from './dialogs.js';

/** Barra lateral: troca de roda, canais da roda atual e o cartão de quem está logado. */
export function createSidebar({ onNavigate, onLogout }) {
  const switcher = h('div', { class: 'space-switch' });
  const channels = h('nav', { class: 'channels', 'aria-label': 'Canais' });
  const foot = h('div', { class: 'sidebar__foot' });
  const voiceBar = createVoiceBar({
    onOpen(channelId) {
      selectChannel(channelId);
      onNavigate();
    },
  });
  const element = h('aside', { class: 'sidebar' }, switcher, channels, voiceBar.element, foot);
  let menuOpen = false;

  function closeMenu() {
    if (!menuOpen) return;
    menuOpen = false;
    renderSwitcher();
  }

  function renderSwitcher() {
    const current = activeSpace();
    const elsewhereUnread = state.spaces.some((space) => space.id !== current?.id && spaceHasUnread(space));

    const button = h(
      'button',
      {
        class: 'space-switch__button',
        type: 'button',
        'aria-haspopup': 'menu',
        'aria-expanded': String(menuOpen),
        onclick: () => {
          menuOpen = !menuOpen;
          renderSwitcher();
        },
      },
      h('span', { class: 'space-switch__name' }, current ? current.name : 'Suas rodas'),
      elsewhereUnread && h('span', { class: 'unread-dot', role: 'img', 'aria-label': 'há mensagens novas em outra roda' }),
      icon('chevron', 16),
    );

    const menu =
      menuOpen &&
      h(
        'div',
        { class: 'menu', role: 'menu' },
        state.spaces.length > 0 && h('div', { class: 'menu__label' }, 'Suas rodas'),
        state.spaces.map((space) =>
          h(
            'button',
            {
              class: space.id === current?.id ? 'menu__item is-current' : 'menu__item',
              type: 'button',
              role: 'menuitem',
              onclick: () => {
                menuOpen = false;
                selectSpace(space.id);
                onNavigate();
              },
            },
            h('span', { class: 'menu__item-name' }, space.name),
            spaceHasUnread(space) && h('span', { class: 'unread-dot', role: 'img', 'aria-label': 'mensagens novas' }),
          ),
        ),
        state.spaces.length > 0 && h('div', { class: 'menu__rule' }),
        menuAction('plus', 'Criar uma roda', promptCreateSpace),
        menuAction('ticket', 'Entrar com convite', promptJoinSpace),
      );

    switcher.replaceChildren(...[button, menu].filter(Boolean));
  }

  function menuAction(iconName, label, run) {
    return h(
      'button',
      {
        class: 'menu__item',
        type: 'button',
        role: 'menuitem',
        onclick: () => {
          closeMenu();
          run();
        },
      },
      icon(iconName, 16),
      h('span', { class: 'menu__item-name' }, label),
    );
  }

  function renderChannels() {
    const space = activeSpace();
    // Redesenhar não pode roubar o foco de quem está navegando pelo teclado.
    const focused = channels.contains(document.activeElement) ? document.activeElement.getAttribute('data-key') : null;

    if (!space) {
      channels.replaceChildren(h('p', { class: 'sidebar__empty' }, 'Crie uma roda ou entre em uma com um convite para começar a conversar.'));
      return;
    }

    const isOwner = space.ownerId === state.user.id;
    const sectionHead = (label, kind, addLabel) =>
      h(
        'div',
        { class: 'section-head' },
        h('span', {}, label),
        isOwner &&
          h(
            'button',
            {
              class: 'icon-button',
              type: 'button',
              title: addLabel,
              'aria-label': addLabel,
              'data-key': `novo-${kind}`,
              onclick: () => promptCreateChannel(space, kind),
            },
            icon('plus', 16),
          ),
      );
    const voiceChannels = space.channels.filter((channel) => channel.kind === 'voice');
    // O lápis de editar (renomear ou excluir) aparece ao passar o mouse, só para quem criou a roda.
    const editButton = (channel) =>
      isOwner &&
      h(
        'button',
        {
          class: 'icon-button channel-edit',
          type: 'button',
          title: 'Editar canal',
          'aria-label': `Editar o canal ${channel.name}`,
          'data-key': `editar-${channel.id}`,
          onclick: () => openChannelDialog(space, channel),
        },
        icon('pencil', 14),
      );

    channels.replaceChildren(
      sectionHead('Canais', 'text', 'Abrir um canal'),
      h(
        'ul',
        {},
        space.channels.filter((channel) => channel.kind !== 'voice').map((channel) => {
          const active = channel.id === state.activeChannelId;
          const unread = isUnread(channel);
          return h(
            'li',
            { class: 'channel-item' },
            h(
              'button',
              {
                class: ['channel', active && 'is-active', unread && 'is-unread'].filter(Boolean).join(' '),
                type: 'button',
                'aria-current': active ? 'page' : null,
                'data-key': `canal-${channel.id}`,
                onclick: () => {
                  selectChannel(channel.id);
                  onNavigate();
                },
              },
              icon('hash', 16),
              h('span', { class: 'channel__name' }, channel.name),
              unread && h('span', { class: 'unread-dot', role: 'img', 'aria-label': 'mensagens novas' }),
            ),
            editButton(channel),
          );
        }),
      ),
      // A seção de voz aparece se há canais de voz, ou para quem pode criá-los.
      (voiceChannels.length > 0 || isOwner) && sectionHead('Voz', 'voice', 'Abrir um canal de voz'),
      h(
        'ul',
        {},
        voiceChannels.map((channel) => {
          const active = channel.id === state.activeChannelId;
          const inCall = voice.status !== 'idle' && voice.channelId === channel.id;
          return h(
            'li',
            { class: 'channel-item' },
            h(
              'button',
              {
                class: ['channel', active && 'is-active', inCall && 'is-in-call'].filter(Boolean).join(' '),
                type: 'button',
                'aria-current': active ? 'page' : null,
                'data-key': `canal-${channel.id}`,
                onclick: () => {
                  selectChannel(channel.id);
                  onNavigate();
                },
              },
              icon('speaker', 16),
              h('span', { class: 'channel__name' }, channel.name),
            ),
            editButton(channel),
            (channel.voice ?? []).length > 0 &&
              h(
                'ul',
                { class: 'callers' },
                channel.voice.map((participant) => {
                  const person = space.members.find((member) => member.id === participant.userId);
                  return (
                    person &&
                    h(
                      'li',
                      { class: voice.speaking.has(participant.peerId) ? 'caller is-speaking' : 'caller' },
                      avatar(person, true),
                      h('span', { class: 'caller__name' }, person.displayName),
                      participant.muted && icon('micOff', 14),
                      participant.screen && icon('screen', 14),
                    )
                  );
                }),
              ),
          );
        }),
      ),
    );

    if (focused) channels.querySelector(`[data-key="${focused}"]`)?.focus();
  }

  function renderFoot() {
    const space = activeSpace();
    foot.replaceChildren(
      ...[
        space &&
          h(
            'button',
            { class: 'button button--quiet invite-button', type: 'button', onclick: () => openInviteDialog(space) },
            icon('invite', 16),
            'Convidar para a roda',
          ),
        h(
          'div',
          { class: 'me' },
          avatar(state.user),
          h(
            'div',
            { class: 'me__text' },
            h('div', { class: 'me__name' }, state.user.displayName),
            h('div', { class: 'me__handle' }, `@${state.user.username}`),
          ),
          isDesktop &&
            h(
              'button',
              {
                class: 'icon-button',
                type: 'button',
                title: 'Opções do aplicativo',
                'aria-label': 'Opções do aplicativo',
                onclick: openDesktopSettingsDialog,
              },
              icon('sliders'),
            ),
          h(
            'button',
            { class: 'icon-button', type: 'button', title: 'Sair da conta', 'aria-label': 'Sair da conta', onclick: onLogout },
            icon('leave'),
          ),
        ),
      ].filter(Boolean),
    );
  }

  function onPointerDown(event) {
    if (!switcher.contains(event.target)) closeMenu();
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') closeMenu();
  }

  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('keydown', onKeyDown);

  const unsubscribe = subscribe((topic) => {
    if (topic === 'spaces' || topic === 'active') {
      renderSwitcher();
      renderChannels();
      renderFoot();
    } else if (topic === 'unread') {
      renderSwitcher();
      renderChannels();
    } else if (topic === 'voice' || topic === 'members') {
      renderChannels();
    }
  });
  const unsubscribeVoice = subscribeVoice(renderChannels);

  renderSwitcher();
  renderChannels();
  renderFoot();

  return {
    element,
    destroy() {
      unsubscribe();
      unsubscribeVoice();
      voiceBar.destroy();
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    },
  };
}
