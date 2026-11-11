import { h, icon, toast } from '../dom.js';

const MAX_LENGTH = 4000;
const MAX_HEIGHT_PX = 180;

/** Caixa de escrever. Enter envia, Shift+Enter quebra linha; o rascunho fica guardado por canal. */
export function createComposer({ onSend, onTyping }) {
  const drafts = new Map();
  let channelId = null;
  let sending = false;

  const input = h('textarea', { class: 'composer__input', rows: 1, maxLength: MAX_LENGTH, 'aria-label': 'Mensagem' });
  const send = h('button', { class: 'composer__send', type: 'submit', title: 'Enviar', 'aria-label': 'Enviar mensagem', disabled: true }, icon('send'));
  const element = h(
    'form',
    {
      class: 'composer',
      onsubmit: (event) => {
        event.preventDefault();
        submit();
      },
    },
    input,
    send,
  );

  function refresh() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, MAX_HEIGHT_PX)}px`;
    send.disabled = input.value.trim() === '';
  }

  async function submit() {
    const content = input.value;
    if (sending || content.trim() === '' || channelId === null) return;
    const target = channelId;
    sending = true;
    input.value = '';
    refresh();
    try {
      await onSend(target, content);
    } catch (failure) {
      // Devolve o texto para a pessoa não perder o que escreveu.
      if (channelId === target) {
        input.value = input.value ? `${content}\n${input.value}` : content;
        refresh();
      } else {
        drafts.set(target, content);
      }
      toast(failure.message, 'error');
    } finally {
      sending = false;
    }
  }

  input.addEventListener('input', () => {
    refresh();
    if (input.value.trim() !== '') onTyping();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });

  return {
    element,
    focus: () => input.focus(),
    setChannel(channel) {
      if (channel.id === channelId) return;
      if (channelId !== null) drafts.set(channelId, input.value);
      channelId = channel.id;
      input.placeholder = `Escreva em #${channel.name}`;
      input.value = drafts.get(channel.id) ?? '';
      refresh();
    },
  };
}
