// Estado da interface num lugar só. As telas assinam mudanças por tópico e se
// redesenham; ninguém fora daqui altera `state` diretamente.

const TYPING_TTL_MS = 6000;
const SELECTION_KEY = 'echo:selecao';

export const state = {
  user: null,
  /** Rodas: [{ id, name, ownerId, inviteCode, channels: [...], members: [...] }] */
  spaces: [],
  activeSpaceId: null,
  activeChannelId: null,
  /** channelId -> { items, hasMore, loaded } */
  history: new Map(),
  /** channelId -> Map(userId -> timer) */
  typing: new Map(),
  /** 'connecting' | 'online' | 'offline' */
  connection: 'connecting',
};

const listeners = new Set();

/** Tópicos: spaces, active, members, unread, message, history, typing, connection, resync, voice. */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(topic, detail) {
  for (const listener of [...listeners]) listener(topic, detail);
}

// --- seleção lembrada entre visitas (só conveniência; funciona sem) ----------

let selection = { spaceId: null, channels: {} };
try {
  const saved = JSON.parse(localStorage.getItem(SELECTION_KEY));
  if (saved && typeof saved === 'object') selection = { spaceId: saved.spaceId ?? null, channels: saved.channels ?? {} };
} catch {
  /* sem armazenamento local: começa do zero */
}

function rememberSelection() {
  selection.spaceId = state.activeSpaceId;
  if (state.activeSpaceId && state.activeChannelId) selection.channels[state.activeSpaceId] = state.activeChannelId;
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify(selection));
  } catch {
    /* idem */
  }
}

// --- consultas ---------------------------------------------------------------

export const findSpace = (spaceId) => state.spaces.find((space) => space.id === spaceId) ?? null;
export const activeSpace = () => findSpace(state.activeSpaceId);
export const activeChannel = () => activeSpace()?.channels.find((channel) => channel.id === state.activeChannelId) ?? null;

export function findChannel(channelId) {
  for (const space of state.spaces) {
    const channel = space.channels.find((item) => item.id === channelId);
    if (channel) return { space, channel };
  }
  return null;
}

export const isUnread = (channel) => channel.lastMessageId !== null && channel.lastMessageId > channel.lastReadId;
export const spaceHasUnread = (space) => space.channels.some(isUnread);
export const unreadChannelCount = () => state.spaces.reduce((total, space) => total + space.channels.filter(isUnread).length, 0);

export function historyOf(channelId) {
  let history = state.history.get(channelId);
  if (!history) {
    history = { items: [], hasMore: true, loaded: false };
    state.history.set(channelId, history);
  }
  return history;
}

/** Nomes de quem está digitando no canal agora. */
export function typingNames(channelId) {
  const space = findChannel(channelId)?.space;
  const typing = state.typing.get(channelId);
  if (!space || !typing) return [];
  return [...typing.keys()]
    .map((userId) => space.members.find((member) => member.id === userId)?.displayName)
    .filter(Boolean);
}

// --- mudanças ----------------------------------------------------------------

function pickChannel(space, preferredId) {
  if (!space) return null;
  const wanted = [preferredId, selection.channels[space.id]];
  for (const id of wanted) {
    const channel = space.channels.find((item) => item.id === id);
    if (channel) return channel;
  }
  return space.channels[0] ?? null;
}

/** Recebe a foto completa do servidor (na abertura e a cada reconexão). */
export function setBootstrap({ user, spaces }) {
  state.user = user;
  state.spaces = spaces;
  const space = findSpace(state.activeSpaceId) ?? findSpace(selection.spaceId) ?? spaces[0] ?? null;
  state.activeSpaceId = space?.id ?? null;
  state.activeChannelId = pickChannel(space, state.activeChannelId)?.id ?? null;
  rememberSelection();
  emit('spaces');
  emit('active');
  emit('members');
  emit('unread');
}

export function resetState() {
  for (const timers of state.typing.values()) for (const timer of timers.values()) clearTimeout(timer);
  state.user = null;
  state.spaces = [];
  state.activeSpaceId = null;
  state.activeChannelId = null;
  state.history.clear();
  state.typing.clear();
  state.connection = 'connecting';
}

export function selectSpace(spaceId) {
  const space = findSpace(spaceId);
  if (!space) return;
  state.activeSpaceId = space.id;
  state.activeChannelId = pickChannel(space, null)?.id ?? null;
  rememberSelection();
  emit('active');
  emit('members');
}

export function selectChannel(channelId) {
  const found = findChannel(channelId);
  if (!found) return;
  state.activeSpaceId = found.space.id;
  state.activeChannelId = found.channel.id;
  rememberSelection();
  emit('active');
  emit('members');
}

export function setConnection(status) {
  if (state.connection === status) return;
  state.connection = status;
  emit('connection');
}

export function addSpace(space) {
  if (findSpace(space.id)) return;
  state.spaces.push(space);
  emit('spaces');
  emit('unread');
}

export function addChannel(channel) {
  const space = findSpace(channel.spaceId);
  if (!space || space.channels.some((item) => item.id === channel.id)) return;
  space.channels.push(channel);
  emit('spaces');
}

export function renameChannel({ id, name }) {
  const channel = findChannel(id)?.channel;
  if (!channel || channel.name === name) return;
  channel.name = name;
  emit('spaces');
}

/** Tira um canal excluído; se era o que estava aberto, passa para outro da mesma roda. */
export function removeChannel(channelId) {
  const found = findChannel(channelId);
  if (!found) return;
  found.space.channels = found.space.channels.filter((channel) => channel.id !== channelId);
  state.history.delete(channelId);
  state.typing.delete(channelId);
  if (state.activeChannelId === channelId) {
    state.activeChannelId = pickChannel(found.space, null)?.id ?? null;
    rememberSelection();
    emit('spaces');
    emit('active');
    emit('members');
  } else {
    emit('spaces');
  }
  emit('unread');
}

/** Troca o histórico do canal pela página mais recente vinda do servidor. */
export function setLatest(channelId, messages, hasMore) {
  const history = historyOf(channelId);
  history.items = messages;
  history.hasMore = hasMore;
  history.loaded = true;
  emit('history', { channelId, reason: 'latest' });
}

export function prependOlder(channelId, messages, hasMore) {
  const history = historyOf(channelId);
  const known = new Set(history.items.map((message) => message.id));
  history.items = [...messages.filter((message) => !known.has(message.id)), ...history.items];
  history.hasMore = hasMore;
  emit('history', { channelId, reason: 'older' });
}

/** Mensagem nova, venha do gateway (`live`) ou da resposta do próprio envio. */
export function addMessage(message, { live }) {
  const found = findChannel(message.channelId);
  if (!found) return;
  const { channel } = found;
  if (channel.lastMessageId === null || message.id > channel.lastMessageId) channel.lastMessageId = message.id;
  if (message.author.id === state.user.id && message.id > channel.lastReadId) channel.lastReadId = message.id;
  stopTyping(message.channelId, message.author.id);

  const history = historyOf(message.channelId);
  const isNew = !history.items.some((item) => item.id === message.id);
  if (history.loaded && isNew) {
    history.items.push(message);
    history.items.sort((a, b) => a.id - b.id);
  }
  // O envio próprio chega duas vezes (resposta e gateway); só a primeira conta.
  if (isNew) emit('message', { message, live });
  emit('unread');
}

export function setRead(channelId, lastReadId) {
  const channel = findChannel(channelId)?.channel;
  if (!channel || lastReadId <= channel.lastReadId) return;
  channel.lastReadId = lastReadId;
  emit('unread');
}

function stopTyping(channelId, userId) {
  const typing = state.typing.get(channelId);
  if (!typing?.has(userId)) return;
  clearTimeout(typing.get(userId));
  typing.delete(userId);
  emit('typing');
}

function noteTyping(channelId, userId) {
  if (userId === state.user.id) return;
  let typing = state.typing.get(channelId);
  if (!typing) state.typing.set(channelId, (typing = new Map()));
  clearTimeout(typing.get(userId));
  typing.set(userId, setTimeout(() => stopTyping(channelId, userId), TYPING_TTL_MS));
  emit('typing');
}

/** Aplica um evento vindo do gateway. */
export function applyEvent(event) {
  if (!state.user) return;
  switch (event.type) {
    case 'message_create':
      addMessage(event.message, { live: true });
      break;
    case 'typing':
      noteTyping(event.channelId, event.userId);
      break;
    case 'presence':
      for (const space of state.spaces) {
        const member = space.members.find((item) => item.id === event.userId);
        if (member) member.online = event.online;
      }
      emit('members');
      break;
    case 'member_join': {
      const space = findSpace(event.spaceId);
      if (space && !space.members.some((member) => member.id === event.member.id)) {
        space.members.push(event.member);
        emit('members');
      }
      break;
    }
    case 'channel_create':
      addChannel(event.channel);
      break;
    case 'space_add':
      addSpace(event.space);
      break;
    case 'read_state':
      setRead(event.channelId, event.lastReadId);
      break;
    case 'channel_update':
      renameChannel(event.channel);
      break;
    case 'channel_delete':
      removeChannel(event.channelId);
      break;
    case 'voice_state': {
      // Quem está na chamada de um canal de voz (a lista inteira, a cada mudança).
      const found = findChannel(event.channelId);
      if (found) {
        found.channel.voice = event.participants;
        emit('voice');
      }
      break;
    }
    case 'resync':
      // O servidor avisa que houve uma mudança grande demais para mandar por aqui.
      emit('resync');
      break;
    default:
      break;
  }
}
