import { hashPassword, hashToken, newInviteCode, newSessionToken, sessionCookie, sessionTokenFrom, verifyPassword } from './auth.js';
import { SERVER_NAME, SERVER_VERSION } from './config.js';
import { isUniqueViolation } from './db.js';
import { HttpError, createRateLimiter, createRouter, isSameOrigin, readJsonBody, sendJson } from './http-util.js';
import {
  parseChannelName,
  parseDisplayName,
  parseInviteCode,
  parseMessageContent,
  parsePassword,
  parsePositiveInt,
  parseSpaceName,
  parseUsername,
} from './validation.js';

const FIRST_CHANNEL_NAME = 'geral';

/** Monta a API REST. O estado mora no banco; o hub só espalha os eventos. */
export function buildApi({ db, hub, config }) {
  const router = createRouter();

  const authLimiter = createRateLimiter(config.rateLimits.auth);
  const writeLimiter = createRateLimiter(config.rateLimits.write);
  const messageLimiter = createRateLimiter(config.rateLimits.message);

  // Verificado quando o usuário não existe, para o login levar o mesmo tempo nos dois casos.
  const decoyHash = hashPassword(newSessionToken());

  function throttle(limiter, key) {
    const waitSeconds = limiter.take(key);
    if (waitSeconds > 0) {
      throw new HttpError(429, 'rate_limited', `Muitas tentativas seguidas. Tente de novo em ${waitSeconds} s.`, {
        headers: { 'Retry-After': String(waitSeconds) },
      });
    }
  }

  // Com proxy na frente, a conexão vem sempre dele; o IP de quem acessa é o
  // último item de X-Forwarded-For, que é o que o próprio proxy acrescentou.
  function clientAddress(req) {
    if (config.trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').pop().trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress ?? 'desconhecido';
  }

  function currentSession(req) {
    const token = sessionTokenFrom(req);
    if (!token) return null;
    const tokenHash = hashToken(token);
    const user = db.findSessionUser(tokenHash);
    return user ? { user, tokenHash } : null;
  }

  function requireUser(req) {
    const session = currentSession(req);
    if (!session) throw new HttpError(401, 'unauthenticated', 'Entre na sua conta para continuar.');
    return session.user;
  }

  function startSession(userId) {
    const token = newSessionToken();
    db.createSession(hashToken(token), userId, Date.now() + config.sessionMaxAgeSeconds * 1000);
    return { 'Set-Cookie': sessionCookie(token, { maxAgeSeconds: config.sessionMaxAgeSeconds, secure: config.secureCookies }) };
  }

  const withPresence = (member) => ({ ...member, online: hub.isOnline(member.id) });

  function describeSpace(space, userId) {
    return {
      ...space,
      channels: db.listChannelsForSpace(space.id, userId),
      members: db.listMembers(space.id).map(withPresence),
    };
  }

  // Canal inexistente e canal de uma roda alheia respondem igual, para não revelar o que existe.
  function requireChannel(channelId, userId) {
    const channel = db.findChannel(channelId);
    if (!channel || !db.isMember(channel.spaceId, userId)) {
      throw new HttpError(404, 'channel_not_found', 'Canal não encontrado.');
    }
    return channel;
  }

  function createSpaceWithFreshInvite(name, ownerId) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return db.createSpace({ name, ownerId, inviteCode: newInviteCode(), firstChannelName: FIRST_CHANNEL_NAME });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new Error('não foi possível gerar um código de convite único');
  }

  router.get('/api/health', () => ({
    status: 200,
    body: { ok: true, name: SERVER_NAME, version: SERVER_VERSION },
  }));

  // --- conta -----------------------------------------------------------------

  router.post('/api/auth/register', async ({ req, body }) => {
    throttle(authLimiter, clientAddress(req));
    const input = await body();
    const username = parseUsername(input.username);
    const hasDisplayName = typeof input.displayName === 'string' && input.displayName.trim() !== '';
    const displayName = parseDisplayName(hasDisplayName ? input.displayName : username);
    const passwordHash = await hashPassword(parsePassword(input.password));

    let user;
    try {
      user = db.createUser({ username, displayName, passwordHash });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError(409, 'username_taken', 'Esse nome de usuário já está em uso.', { field: 'username' });
      }
      throw error;
    }
    return { status: 201, body: { user }, headers: startSession(user.id) };
  });

  router.post('/api/auth/login', async ({ req, body }) => {
    throttle(authLimiter, clientAddress(req));
    const input = await body();
    const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
    const password = typeof input.password === 'string' ? input.password : '';

    const record = username ? db.findUserForLogin(username) : undefined;
    const passwordMatches = await verifyPassword(password, record ? record.passwordHash : await decoyHash);
    if (!record || !passwordMatches) {
      throw new HttpError(401, 'invalid_credentials', 'Usuário ou senha incorretos.');
    }
    const { passwordHash: _omitted, ...user } = record;
    return { status: 200, body: { user }, headers: startSession(user.id) };
  });

  router.post('/api/auth/logout', ({ req }) => {
    const session = currentSession(req);
    if (session) {
      db.deleteSession(session.tokenHash);
      hub.disconnectSession(session.tokenHash);
    }
    return { status: 204, headers: { 'Set-Cookie': sessionCookie('', { maxAgeSeconds: 0, secure: config.secureCookies }) } };
  });

  /** Tudo que a interface precisa para abrir: a conta, as rodas, os canais e quem está nelas. */
  router.get('/api/bootstrap', ({ req }) => {
    const user = requireUser(req);
    const channels = db.listChannelsForUser(user.id);
    const spaces = db.listSpacesForUser(user.id).map((space) => ({
      ...space,
      channels: channels.filter((channel) => channel.spaceId === space.id),
      members: db.listMembers(space.id).map(withPresence),
    }));
    return { status: 200, body: { user, spaces } };
  });

  // --- rodas e canais --------------------------------------------------------

  router.post('/api/spaces', async ({ req, body }) => {
    const user = requireUser(req);
    throttle(writeLimiter, user.id);
    const name = parseSpaceName((await body()).name);
    const space = describeSpace(createSpaceWithFreshInvite(name, user.id), user.id);
    hub.sendToUser(user.id, { type: 'space_add', space });
    return { status: 201, body: { space } };
  });

  router.post('/api/spaces/join', async ({ req, body }) => {
    const user = requireUser(req);
    throttle(writeLimiter, user.id);
    const code = parseInviteCode((await body()).code);
    const found = db.findSpaceByInvite(code);
    if (!found) {
      throw new HttpError(404, 'invite_not_found', 'Não encontramos uma roda com esse convite.', { field: 'code' });
    }
    const joinedNow = db.addMember(found.id, user.id);
    const space = describeSpace(found, user.id);
    if (joinedNow) {
      hub.sendToSpace(found.id, { type: 'member_join', spaceId: found.id, member: withPresence(user) }, { exceptUserId: user.id });
      hub.sendToUser(user.id, { type: 'space_add', space });
    }
    return { status: joinedNow ? 201 : 200, body: { space } };
  });

  router.post('/api/spaces/:id/channels', async ({ req, params, body }) => {
    const user = requireUser(req);
    const space = db.findSpace(params.id);
    if (!space || !db.isMember(space.id, user.id)) {
      throw new HttpError(404, 'space_not_found', 'Roda não encontrada.');
    }
    if (space.ownerId !== user.id) {
      throw new HttpError(403, 'forbidden', 'Só quem criou a roda pode abrir canais.');
    }
    throttle(writeLimiter, user.id);
    const name = parseChannelName((await body()).name);

    let channel;
    try {
      channel = db.createChannel(space.id, name);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError(409, 'channel_exists', 'Já existe um canal com esse nome nesta roda.', { field: 'name' });
      }
      throw error;
    }
    hub.sendToSpace(space.id, { type: 'channel_create', channel });
    return { status: 201, body: { channel } };
  });

  // --- mensagens -------------------------------------------------------------

  router.get('/api/channels/:id/messages', ({ req, params, url }) => {
    const user = requireUser(req);
    const channel = requireChannel(params.id, user.id);
    const before = url.searchParams.get('before');
    const limit = url.searchParams.get('limit');
    return {
      status: 200,
      body: db.listMessages(channel.id, {
        before: before === null ? Number.MAX_SAFE_INTEGER : parsePositiveInt(before, 'before'),
        limit: limit === null ? 50 : Math.min(100, parsePositiveInt(limit, 'limit')),
      }),
    };
  });

  router.post('/api/channels/:id/messages', async ({ req, params, body }) => {
    const user = requireUser(req);
    const channel = requireChannel(params.id, user.id);
    throttle(messageLimiter, user.id);
    const content = parseMessageContent((await body()).content);
    const message = db.createMessage({ channelId: channel.id, author: user, content });
    db.markRead(user.id, channel.id, message.id);
    hub.sendToSpace(channel.spaceId, { type: 'message_create', message });
    return { status: 201, body: { message } };
  });

  router.post('/api/channels/:id/ack', async ({ req, params, body }) => {
    const user = requireUser(req);
    const channel = requireChannel(params.id, user.id);
    const messageId = parsePositiveInt((await body()).messageId, 'messageId');
    const lastReadId = db.markRead(user.id, channel.id, messageId);
    // As outras abas da mesma pessoa também deixam de mostrar o canal como não lido.
    hub.sendToUser(user.id, { type: 'read_state', channelId: channel.id, lastReadId });
    return { status: 200, body: { lastReadId } };
  });

  async function handle(req, res, url) {
    const found = router.match(req.method, url.pathname);
    if (!found) throw new HttpError(404, 'not_found', 'Rota não encontrada.');
    if (found.methodNotAllowed) throw new HttpError(405, 'method_not_allowed', 'Método não permitido.');
    if (req.method !== 'GET' && !isSameOrigin(req)) {
      throw new HttpError(403, 'bad_origin', 'Origem não permitida.');
    }

    const result = await found.handler({ req, url, params: found.params, body: () => readJsonBody(req) });
    if (result.status === 204) {
      res.writeHead(204, { 'Cache-Control': 'no-store', ...result.headers });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body, result.headers);
  }

  return {
    handle,
    stop() {
      authLimiter.stop();
      writeLimiter.stop();
      messageLimiter.stop();
    },
  };
}
