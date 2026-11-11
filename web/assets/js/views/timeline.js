import { avatar, h } from '../dom.js';
import { dayKey, formatDay, formatTime, renderContent } from '../format.js';

const GROUP_GAP_MS = 5 * 60_000;
const NEAR_BOTTOM_PX = 80;
const NEAR_TOP_PX = 240;

/**
 * A conversa em si. Mensagens seguidas da mesma pessoa se agrupam; rolar para
 * perto do topo pede as anteriores (`onNearTop`), chegar ao fim avisa `onReachBottom`.
 */
export function createTimeline({ onNearTop, onReachBottom }) {
  const list = h('div', { class: 'timeline__list' });
  const element = h('section', { class: 'timeline', tabIndex: 0, 'aria-label': 'Mensagens' }, list);
  let lastDrawn = null;

  const isAtBottom = () => element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;

  function scrollToBottom() {
    element.scrollTop = element.scrollHeight;
  }

  element.addEventListener(
    'scroll',
    () => {
      if (element.scrollTop < NEAR_TOP_PX) onNearTop();
      if (isAtBottom()) onReachBottom();
    },
    { passive: true },
  );

  function rowsFor(previous, message) {
    const rows = [];
    const newDay = !previous || dayKey(previous.createdAt) !== dayKey(message.createdAt);
    if (newDay) rows.push(h('div', { class: 'day', role: 'separator' }, formatDay(message.createdAt)));

    const startsGroup =
      newDay || previous.author.id !== message.author.id || message.createdAt - previous.createdAt > GROUP_GAP_MS;
    const text = h('div', { class: 'msg__text' }, renderContent(message.content));
    const time = formatTime(message.createdAt);

    rows.push(
      startsGroup
        ? h(
            'article',
            { class: 'msg msg--head' },
            avatar(message.author),
            h(
              'div',
              {},
              h('div', { class: 'msg__meta' }, h('span', { class: 'msg__author' }, message.author.displayName), h('time', { class: 'msg__time' }, time)),
              text,
            ),
          )
        : h('article', { class: 'msg' }, h('time', { class: 'msg__side-time' }, time), text),
    );
    return rows;
  }

  function intro(channel) {
    return h(
      'div',
      { class: 'intro' },
      h('h2', { class: 'intro__title' }, h('span', {}, '#'), channel.name),
      h('p', { class: 'intro__text' }, `Aqui começa o canal #${channel.name}.`),
    );
  }

  return {
    element,
    isAtBottom,
    scrollToBottom,

    showStatus(text) {
      lastDrawn = null;
      list.replaceChildren(h('p', { class: 'timeline__status' }, text));
    },

    /**
     * Desenha o histórico inteiro. `keep: 'bottom'` cola no fim da conversa;
     * `keep: 'position'` mantém na tela o que a pessoa estava lendo (usado ao
     * acrescentar mensagens antigas no topo).
     */
    render(channel, history, keep) {
      const distanceFromBottom = element.scrollHeight - element.scrollTop;
      const nodes = [history.hasMore ? h('p', { class: 'timeline__status' }, 'Buscando mensagens anteriores…') : intro(channel)];
      let previous = null;
      for (const message of history.items) {
        nodes.push(...rowsFor(previous, message));
        previous = message;
      }
      lastDrawn = previous;
      list.replaceChildren(...nodes);

      if (keep === 'position') element.scrollTop = element.scrollHeight - distanceFromBottom;
      else scrollToBottom();
      // Janela alta com pouca conversa: não há o que rolar, então já busca mais.
      if (history.hasMore && element.scrollTop < NEAR_TOP_PX) onNearTop();
    },

    append(message) {
      list.append(...rowsFor(lastDrawn, message));
      lastDrawn = message;
    },
  };
}
