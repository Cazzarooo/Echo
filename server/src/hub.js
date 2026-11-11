import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { hashToken, sessionTokenFrom } from './auth.js';
import { MAX_ENVELOPE_BYTES } from './bus.js';
import { isSameOrigin } from './http-util.js';

const HEARTBEAT_MS = 30_000;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const TYPING_MIN_INTERVAL_MS = 2_000;

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
 */
export function createHub({ db, bus }) {
  const instanceId = randomUUID();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  const clients = new Set();
  /** userId -> Set de conexões abertas nesta instância. */
  const clientsByUser = new Map();

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
    const client = { ws, user, tokenHash, alive: true, typingAt: 0 };
    clients.add(client);
    let ofUser = clientsByUser.get(user.id);
    if (!ofUser) clientsByUser.set(user.id, (ofUser = new Set()));
    ofUser.add(client);

    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) handleClientEvent(client, data).catch(warn('evento do cliente'));
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
  }

  async function handleClientEvent(client, data) {
    let event;
    try {
      event = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (event?.type !== 'typing' || !Number.isSafeInteger(event.channelId)) return;

    const now = Date.now();
    if (now - client.typingAt < TYPING_MIN_INTERVAL_MS) return;
    client.typingAt = now;
    const channel = await db.findChannel(event.channelId);
    if (!channel || !(await db.isMember(channel.spaceId, client.user.id))) return;
    await toSpace(channel.spaceId, { type: 'typing', channelId: channel.id, userId: client.user.id }, { exceptUserId: client.user.id });
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
      default:
        break;
    }
  }

  // --- publicação -------------------------------------------------------------

  // Evento grande demais para o canal vira um pedido de "busque tudo de novo".
  function publishEvent(envelope) {
    const fits = Buffer.byteLength(JSON.stringify(envelope)) <= MAX_ENVELOPE_BYTES;
    return bus.publish(fits ? envelope : { ...envelope, event: { type: 'resync' } });
  }

  function toSpace(spaceId, event, { exceptUserId = null } = {}) {
    return publishEvent({ to: 'space', id: spaceId, except: exceptUserId, event });
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
    if (clients.size > 0) db.presenceTouch(instanceId).catch(warn('sinal de vida'));
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    /** Começa a ouvir o canal de eventos. Chamar uma vez, antes de atender conexões. */
    start: () => bus.subscribe((envelope) => onEnvelope(envelope).catch(warn('entrega de evento'))),
    handleUpgrade: (req, socket, head) => handleUpgrade(req, socket, head).catch(warn('abertura de conexão')),
    toUser: (userId, event) => publishEvent({ to: 'users', ids: [userId], event }),
    toSpace,
    /** Mensagem nova: vai por referência, porque o texto pode não caber no canal. */
    messageCreated: (spaceId, messageId) => bus.publish({ to: 'message', id: messageId, spaceId }),
    /** Fecha as conexões abertas com uma sessão que acabou de sair, em qualquer instância. */
    disconnectSession: (tokenHash) => bus.publish({ to: 'session', tokenHash }),
    async close() {
      clearInterval(heartbeat);
      for (const client of clients) client.ws.terminate();
      clients.clear();
      clientsByUser.clear();
      wss.close();
      await db.presenceClear(instanceId).catch(() => {});
    },
  };
}
