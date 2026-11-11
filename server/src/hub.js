import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { hashToken, sessionTokenFrom } from './auth.js';
import { isSameOrigin } from './http-util.js';

const HEARTBEAT_MS = 30_000;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const TYPING_MIN_INTERVAL_MS = 2_000;
/** Quanto uma chamada espera por quem perdeu a conexão antes de dá-lo como saído. */
const VOICE_GRACE_MS = 12_000;
const MAX_EVENTS_PER_SECOND = 80;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Gateway em tempo real (WebSocket em /gateway).
 *
 * O estado vem da API REST; por aqui só passam eventos. Quem publica não fala
 * direto com as conexões: põe um "envelope" no canal (bus.js), e cada instância
 * do servidor entrega aos seus próprios clientes. Assim funciona igual com um
 * servidor só ou com várias instâncias dividindo o banco.
 *
 * Envelopes:
 *   { to: 'users', ids, except?, event }   para pessoas específicas
 *   { to: 'space', id, except?, event }    para quem participa de uma roda
 *   { to: 'message', id, spaceId }         mensagem nova (cada instância a lê do banco)
 *   { to: 'presence', userId, online }     para quem divide alguma roda com a pessoa
 *   { to: 'session', tokenHash }           derruba as conexões de uma sessão encerrada
 *   { to: 'peer', peerId, event }          para uma aba que está numa chamada
 *
 * Chamadas de voz: o servidor não transporta áudio nem vídeo. Ele só guarda
 * quem está em cada canal de voz e repassa, de uma aba para outra, os sinais
 * com que os navegadores combinam a conexão direta entre si (WebRTC). Cada aba
 * numa chamada tem um `peerId`, escolhido por ela, que sobrevive a reconexões.
 */
export function createHub({ db, bus, config }) {
  const instanceId = randomUUID();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const clients = new Set();
  /** userId -> Set de conexões abertas nesta instância. */
  const clientsByUser = new Map();
  /** peerId -> conexão desta instância que está numa chamada. */
  const clientsByPeer = new Map();
  const graceTimers = new Set();

  const warn = (what) => (error) => console.error(`[echo] gateway: ${what}:`, error.message);

  function reject(socket, status, reason) {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  async function handleUpgrade(req, socket, head) {
    socket.on('error', () => {});
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return reject(socket, 400, 'Bad Request');
    }
    if (pathname !== '/gateway') return reject(socket, 404, 'Not Found');
    if (!isSameOrigin(req)) return reject(socket, 403, 'Forbidden');

    const token = sessionTokenFrom(req);
    const tokenHash = token ? hashToken(token) : null;
    let user;
    try {
      user = tokenHash ? await db.findSessionUser(tokenHash) : undefined;
    } catch (error) {
      warn('falha ao validar a sessão')(error);
      return reject(socket, 503, 'Service Unavailable');
    }
    if (!user) return reject(socket, 401, 'Unauthorized');
    if (socket.destroyed) return;

    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, user, tokenHash));
  }

  function attach(ws, user, tokenHash) {
    const client = {
      id: randomUUID(),
      ws,
      user,
      tokenHash,
      alive: true,
      typingAt: 0,
      voicePeerId: null,
      voiceChannelId: null,
      windowStart: 0,
      windowCount: 0,
      // Os eventos de uma conexão são tratados em fila, na ordem em que chegaram.
      queue: Promise.resolve(),
    };
    clients.add(client);
    let ofUser = clientsByUser.get(user.id);
    if (!ofUser) clientsByUser.set(user.id, (ofUser = new Set()));
    ofUser.add(client);

    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary || isFlooding(client)) return;
      client.queue = client.queue.then(() => handleClientEvent(client, data)).catch(warn('evento do cliente'));
    });
    ws.on('close', () => detach(client));
    ws.on('error', () => {}); // o 'close' vem em seguida

    db.presenceConnect(instanceId, user.id)
      .then((cameOnline) => cameOnline && bus.publish({ to: 'presence', userId: user.id, online: true }))
      .catch(warn('registrar presença'));
  }

  function detach(client) {
    if (!clients.delete(client)) return;
    const ofUser = clientsByUser.get(client.user.id);
    ofUser?.delete(client);
    if (ofUser && ofUser.size === 0) clientsByUser.delete(client.user.id);

    db.presenceDisconnect(instanceId, client.user.id)
      .then((wentOffline) => wentOffline && bus.publish({ to: 'presence', userId: client.user.id, online: false }))
      .catch(warn('encerrar presença'));

    // Quem estava numa chamada ganha um tempo para reconectar (a conexão com o
    // servidor cai de tempos em tempos; a chamada entre os navegadores, não).
    const peerId = client.voicePeerId;
    if (peerId) {
      if (clientsByPeer.get(peerId) === client) clientsByPeer.delete(peerId);
      const timer = setTimeout(() => {
        graceTimers.delete(timer);
        leaveVoice(peerId, client.id).catch(warn('saída de chamada'));
      }, VOICE_GRACE_MS);
      timer.unref();
      graceTimers.add(timer);
    }
  }

  function isFlooding(client) {
    const now = Date.now();
    if (now - client.windowStart >= 1000) {
      client.windowStart = now;
      client.windowCount = 0;
    }
    client.windowCount += 1;
    return client.windowCount > MAX_EVENTS_PER_SECOND;
  }

  // --- eventos vindos do cliente ----------------------------------------------

  async function handleClientEvent(client, data) {
    let event;
    try {
      event = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (event === null || typeof event !== 'object') return;
    switch (event.type) {
      case 'typing':
        return onTyping(client, event);
      case 'voice_join':
        return onVoiceJoin(client, event);
      case 'voice_leave':
        return onVoiceLeave(client);
      case 'voice_update':
        return onVoiceUpdate(client, event);
      case 'voice_signal':
        return onVoiceSignal(client, event);
      default:
        return undefined;
    }
  }

  async function onTyping(client, event) {
    if (!Number.isSafeInteger(event.channelId)) return;
    const now = Date.now();
    if (now - client.typingAt < TYPING_MIN_INTERVAL_MS) return;
    client.typingAt = now;
    const channel = await db.findChannel(event.channelId);
    if (!channel || !(await db.isMember(channel.spaceId, client.user.id))) return;
    await toSpace(channel.spaceId, { type: 'typing', channelId: channel.id, userId: client.user.id }, { exceptUserId: client.user.id });
  }

  const sendTo = (client, event) => deliver(client, JSON.stringify(event));

  async function announceVoice(channelId) {
    const channel = await db.findChannel(channelId);
    if (!channel) return;
    await toSpace(channel.spaceId, { type: 'voice_state', channelId, participants: await db.voiceParticipants(channelId) });
  }

  async function onVoiceJoin(client, event) {
    if (!Number.isSafeInteger(event.channelId) || typeof event.peerId !== 'string' || !UUID.test(event.peerId)) return;
    const channel = await db.findChannel(event.channelId);
    if (!channel || channel.kind !== 'voice' || !(await db.isMember(channel.spaceId, client.user.id))) {
      return sendTo(client, { type: 'voice_error', reason: 'not_found' });
    }
    // Uma conexão fica em uma chamada só, com um peerId só.
    if (client.voicePeerId && client.voicePeerId !== event.peerId) await onVoiceLeave(client);

    const outcome = await db.voiceJoin({
      peerId: event.peerId,
      connectionId: client.id,
      instanceId,
      channelId: channel.id,
      userId: client.user.id,
      limit: config.voice.maxParticipants,
    });
    if (outcome !== 'ok') return sendTo(client, { type: 'voice_error', reason: outcome });

    const previousChannelId = client.voiceChannelId;
    client.voicePeerId = event.peerId;
    client.voiceChannelId = channel.id;
    clientsByPeer.set(event.peerId, client);

    sendTo(client, {
      type: 'voice_ready',
      channelId: channel.id,
      peerId: event.peerId,
      participants: await db.voiceParticipants(channel.id),
      iceServers: config.voice.iceServers,
    });
    await announceVoice(channel.id);
    if (previousChannelId && previousChannelId !== channel.id) await announceVoice(previousChannelId);
  }

  async function leaveVoice(peerId, connectionId) {
    const channelId = await db.voiceLeave(peerId, connectionId);
    if (channelId !== null) await announceVoice(channelId);
  }

  async function onVoiceLeave(client) {
    const peerId = client.voicePeerId;
    if (!peerId) return;
    client.voicePeerId = null;
    client.voiceChannelId = null;
    if (clientsByPeer.get(peerId) === client) clientsByPeer.delete(peerId);
    await leaveVoice(peerId, client.id);
  }

  // Identificador de um fluxo de câmera ou de tela, como o navegador o gera.
  const streamId = (value) => (typeof value === 'string' && /^[\w{}-]{1,80}$/.test(value) ? value : null);

  async function onVoiceUpdate(client, event) {
    if (!client.voicePeerId) return;
    const channelId = await db.voiceUpdate(client.voicePeerId, client.id, {
      muted: event.muted === true,
      camera: streamId(event.camera),
      screen: streamId(event.screen),
    });
    if (channelId !== null) await announceVoice(channelId);
  }

  async function onVoiceSignal(client, event) {
    if (!client.voicePeerId || typeof event.to !== 'string' || !UUID.test(event.to)) return;
    if (event.data === null || typeof event.data !== 'object') return;
    // Só entre abas que estão na mesma chamada.
    if (!(await db.voicePeersTogether(client.voicePeerId, event.to))) return;
    await bus.publish({ to: 'peer', peerId: event.to, event: { type: 'voice_signal', from: client.voicePeerId, data: event.data } });
  }

  // --- entrega às conexões desta instância ------------------------------------

  function deliver(client, payload) {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    // Conexão que não dá conta de receber é derrubada em vez de acumular memória.
    if (client.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      client.ws.terminate();
      return;
    }
    client.ws.send(payload);
  }

  function deliverToUsers(userIds, event, exceptUserId = null) {
    const payload = JSON.stringify(event);
    for (const userId of userIds) {
      if (userId === exceptUserId) continue;
      const ofUser = clientsByUser.get(userId);
      if (ofUser) for (const client of ofUser) deliver(client, payload);
    }
  }

  async function onEnvelope(envelope) {
    if (clients.size === 0) return; // ninguém conectado aqui: nada a entregar
    switch (envelope.to) {
      case 'users':
        deliverToUsers(envelope.ids, envelope.event, envelope.except);
        break;
      case 'space':
        deliverToUsers(await db.listMemberIds(envelope.id), envelope.event, envelope.except);
        break;
      case 'message': {
        const [message, memberIds] = await Promise.all([db.findMessage(envelope.id), db.listMemberIds(envelope.spaceId)]);
        if (message) deliverToUsers(memberIds, { type: 'message_create', message });
        break;
      }
      case 'presence':
        deliverToUsers(await db.listCoMemberIds(envelope.userId), { type: 'presence', userId: envelope.userId, online: envelope.online });
        break;
      case 'session':
        for (const client of clients) if (client.tokenHash === envelope.tokenHash) client.ws.close(4001, 'logout');
        break;
      case 'peer': {
        const client = clientsByPeer.get(envelope.peerId);
        if (client) sendTo(client, envelope.event);
        break;
      }
      default:
        break;
    }
  }

  // --- publicação -------------------------------------------------------------

  function toSpace(spaceId, event, { exceptUserId = null } = {}) {
    return bus.publish({ to: 'space', id: spaceId, except: exceptUserId, event });
  }

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.ws.terminate();
        continue;
      }
      client.alive = false;
      client.ws.ping();
    }
    if (clients.size === 0) return;
    db.presenceTouch(instanceId).catch(warn('sinal de vida'));
    // Renova as chamadas desta instância e avisa de quem sumiu sem se despedir.
    db.voiceTouch(instanceId)
      .then((channelIds) => Promise.all(channelIds.map(announceVoice)))
      .catch(warn('sinal de vida das chamadas'));
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    /** Começa a ouvir o canal de eventos. Chamar uma vez, antes de atender conexões. */
    start: () => bus.subscribe((envelope) => onEnvelope(envelope).catch(warn('entrega de evento'))),
    handleUpgrade: (req, socket, head) => handleUpgrade(req, socket, head).catch(warn('abertura de conexão')),
    toUser: (userId, event) => bus.publish({ to: 'users', ids: [userId], event }),
    toSpace,
    /** Mensagem nova: vai por referência; cada instância busca o texto no banco. */
    messageCreated: (spaceId, messageId) => bus.publish({ to: 'message', id: messageId, spaceId }),
    /** Fecha as conexões abertas com uma sessão que acabou de sair, em qualquer instância. */
    disconnectSession: (tokenHash) => bus.publish({ to: 'session', tokenHash }),
    async close() {
      clearInterval(heartbeat);
      for (const timer of graceTimers) clearTimeout(timer);
      for (const client of clients) client.ws.terminate();
      clients.clear();
      clientsByUser.clear();
      clientsByPeer.clear();
      wss.close();
      await db.presenceClear(instanceId).catch(() => {});
      const channelIds = await db.voiceClear(instanceId).catch(() => []);
      await Promise.all(channelIds.map((channelId) => announceVoice(channelId).catch(() => {})));
    },
  };
}
