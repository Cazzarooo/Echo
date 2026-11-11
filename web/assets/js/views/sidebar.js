import { isDesktop } from '../desktop.js';
import { avatar, h, icon } from '../dom.js';
import { activeSpace, isUnread, selectChannel, selectSpace, spaceHasUnread, state, subscribe } from '../state.js';
import { openDesktopSettingsDialog, openInviteDialog, promptCreateChannel, promptCreateSpace, promptJoinSpace } from './dialogs.js';

/** Barra lateral: troca de roda, canais da roda atual e o cartão de quem está logado. */
export function createSidebar({ onNavigate, onLogout }) {
  const switcher = h('div', { class: 'space-switch' });
  const channels = h('nav', { class: 'channels', 'aria-label': 'Canais' });
  const foot = h('div', { class: 'sidebar__foot' });
  const element = h('aside', { class: 'sidebar' }, switcher, channels, foot);
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

    channels.replaceChildren(
      h(
        'div',
        { class: 'section-head' },
        h('span', {}, 'Canais'),
        space.ownerId === state.user.id &&
          h(
            'button',
            {
              class: 'icon-button',
              type: 'button',
              title: 'Abrir um canal',
              'aria-label': 'Abrir um canal',
              'data-key': 'novo-canal',
              onclick: () => promptCreateChannel(space),
            },
            icon('plus', 16),
          ),
      ),
      h(
        'ul',
        {},
        space.channels.map((channel) => {
          const active = channel.id === state.activeChannelId;
          const unread = isUnread(channel);
          return h(
            'li',
            {},
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
    }
  });

  renderSwitcher();
  renderChannels();
  renderFoot();

  return {
    element,
    destroy() {
      unsubscribe();
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    },
  };
}
