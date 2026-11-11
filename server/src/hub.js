import { WebSocket, WebSocketServer } from 'ws';
import { hashToken, sessionTokenFrom } from './auth.js';
import { isSameOrigin } from './http-util.js';

const HEARTBEAT_MS = 30_000;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const TYPING_MIN_INTERVAL_MS = 2_000;

/**
 * Gateway em tempo real (WebSocket em /gateway).
 *
 * O estado vem da API REST; por aqui só passam eventos. O destino de cada
 * evento é decidido pela participação gravada no banco, então não há
 * assinatura por conexão para manter em dia.
 */
export function createHub({ db }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  const clients = new Set();
  /** userId -> Set de conexões abertas (uma pessoa pode ter várias abas/aparelhos). */
  const clientsByUser = new Map();

  function reject(socket, status, reason) {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  function handleUpgrade(req, socket, head) {
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
    const user = tokenHash ? db.findSessionUser(tokenHash) : undefined;
    if (!user) return reject(socket, 401, 'Unauthorized');

    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, user, tokenHash));
  }

  function attach(ws, user, tokenHash) {
    const client = { ws, user, tokenHash, alive: true, typingAt: 0 };
    clients.add(client);

    let ofUser = clientsByUser.get(user.id);
    const cameOnline = !ofUser;
    if (!ofUser) clientsByUser.set(user.id, (ofUser = new Set()));
    ofUser.add(client);

    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) handleClientEvent(client, data);
    });
    ws.on('close', () => detach(client));
    ws.on('error', () => {}); // o 'close' vem em seguida

    if (cameOnline) announcePresence(user.id, true);
  }

  function detach(client) {
    if (!clients.delete(client)) return;
    const ofUser = clientsByUser.get(client.user.id);
    ofUser?.delete(client);
    if (ofUser && ofUser.size === 0) {
      clientsByUser.delete(client.user.id);
      announcePresence(client.user.id, false);
    }
  }

  function handleClientEvent(client, data) {
    let event;
    try {
      event = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    if (event?.type !== 'typing' || !Number.isSafeInteger(event.channelId)) return;

    const now = Date.now();
    if (now - client.typingAt < TYPING_MIN_INTERVAL_MS) return;
    const channel = db.findChannel(event.channelId);
    if (!channel || !db.isMember(channel.spaceId, client.user.id)) return;
    client.typingAt = now;
    sendToSpace(channel.spaceId, { type: 'typing', channelId: channel.id, userId: client.user.id }, { exceptUserId: client.user.id });
  }

  function deliver(client, payload) {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    // Conexão que não dá conta de receber é derrubada em vez de acumular memória.
    if (client.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      client.ws.terminate();
      return;
    }
    client.ws.send(payload);
  }

  function sendToUsers(userIds, event, { exceptUserId = null } = {}) {
    const payload = JSON.stringify(event);
    for (const userId of userIds) {
      if (userId === exceptUserId) continue;
      const ofUser = clientsByUser.get(userId);
      if (ofUser) for (const client of ofUser) deliver(client, payload);
    }
  }

  function sendToSpace(spaceId, event, options) {
    sendToUsers(db.listMemberIds(spaceId), event, options);
  }

  function announcePresence(userId, online) {
    sendToUsers(db.listCoMemberIds(userId), { type: 'presence', userId, online });
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
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    handleUpgrade,
    isOnline: (userId) => clientsByUser.has(userId),
    sendToUser: (userId, event) => sendToUsers([userId], event),
    sendToUsers,
    sendToSpace,
    /** Fecha as conexões abertas com uma sessão que acabou de sair. */
    disconnectSession(tokenHash) {
      for (const client of clients) if (client.tokenHash === tokenHash) client.ws.close(4001, 'logout');
    },
    close() {
      clearInterval(heartbeat);
      for (const client of clients) client.ws.terminate();
      wss.close();
    },
  };
}
