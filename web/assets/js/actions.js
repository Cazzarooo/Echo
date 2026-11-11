// O que a interface pede ao servidor. Cada ação fala com a API e atualiza o estado.

import { api } from './api.js';
import {
  addChannel,
  addMessage,
  addSpace,
  findChannel,
  historyOf,
  isUnread,
  prependOlder,
  selectChannel,
  selectSpace,
  setLatest,
  setRead,
} from './state.js';

const loadingLatest = new Map();
const loadingOlder = new Set();

/** Busca a página mais recente do canal. Pedidos simultâneos para o mesmo canal viram um só. */
export function loadLatest(channelId) {
  let pending = loadingLatest.get(channelId);
  if (!pending) {
    pending = api
      .listMessages(channelId)
      .then(({ messages, hasMore }) => setLatest(channelId, messages, hasMore))
      .finally(() => loadingLatest.delete(channelId));
    loadingLatest.set(channelId, pending);
  }
  return pending;
}

export async function loadOlder(channelId) {
  const history = historyOf(channelId);
  if (!history.loaded || !history.hasMore || history.items.length === 0 || loadingOlder.has(channelId)) return;
  loadingOlder.add(channelId);
  try {
    const { messages, hasMore } = await api.listMessages(channelId, { before: history.items[0].id });
    prependOlder(channelId, messages, hasMore);
  } finally {
    loadingOlder.delete(channelId);
  }
}

export async function sendMessage(channelId, content) {
  const { message } = await api.sendMessage(channelId, content);
  addMessage(message, { live: false });
}

/** Marca o canal como lido até a última mensagem conhecida. */
export function markRead(channelId) {
  const channel = findChannel(channelId)?.channel;
  if (!channel || !isUnread(channel)) return;
  const messageId = channel.lastMessageId;
  setRead(channelId, messageId);
  api.ack(channelId, messageId).catch(() => {
    /* se falhar, a próxima leitura tenta de novo */
  });
}

export async function createSpace(name) {
  const { space } = await api.createSpace(name);
  addSpace(space);
  selectSpace(space.id);
}

export async function joinSpace(code) {
  const { space } = await api.joinSpace(code);
  addSpace(space);
  selectSpace(space.id);
}

export async function createChannel(spaceId, name) {
  const { channel } = await api.createChannel(spaceId, name);
  addChannel(channel);
  selectChannel(channel.id);
}
