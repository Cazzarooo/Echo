import { hashPassword, hashToken, newInviteCode, newSessionToken, sessionCookie, sessionTokenFrom, verifyPassword } from './auth.js';
import { SERVER_NAME, SERVER_VERSION } from './config.js';
import { isUniqueViolation } from './db/index.js';
import { HttpError, createRateLimiter, createRouter, isSameOrigin, readJsonBody, sendJson } from './http-util.js';
import {
  parseChannelKind,
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

  async function currentSession(req) {
    const token = sessionTokenFrom(req);
    if (!token) return null;
    const tokenHash = hashToken(token);
    const user = await db.findSessionUser(tokenHash);
    return user ? { user, tokenHash } : null;
  }

  async function requireUser(req) {
    const session = await currentSession(req);
    if (!session) throw new HttpError(401, 'unauthenticated', 'Entre na sua conta para continuar.');
    return session.user;
  }

  async function startSession(userId) {
    const token = newSessionToken();
    await db.createSession(hashToken(token), userId, Date.now() + config.sessionMaxAgeSeconds * 1000);
    return { 'Set-Cookie': sessionCookie(token, { maxAgeSeconds: config.sessionMaxAgeSeconds, secure: config.secureCookies }) };
  }

  const withPresence = (online) => (member) => ({ ...member, online: online.has(member.id) });

  // Cada canal de voz leva a lista de quem está na chamada.
  function withVoice(channels, voiceStates) {
    return channels.map((channel) =>
      channel.kind === 'voice'
        ? { ...channel, voice: voiceStates.filter((state) => state.channelId === channel.id).map(({ channelId: _channel, ...state }) => state) }
        : channel,
    );
  }

  async function describeSpace(space, userId, online) {
    const [channels, members, voiceStates] = await Promise.all([
      db.listChannelsForSpace(space.id, userId),
      db.listMembers(space.id),
      db.listVoiceStatesForUser(userId),
    ]);
    return { ...space, channels: withVoice(channels, voiceStates), members: members.map(withPresence(online)) };
  }

  // Canal inexistente e canal de uma roda alheia respondem igual, para não revelar o que existe.
  // As rotas de mensagem só valem para canais de texto.
  async function requireChannel(channelId, userId) {
    const channel = await db.findChannel(channelId);
    if (!channel || !(await db.isMember(channel.spaceId, userId))) {
      throw new HttpError(404, 'channel_not_found', 'Canal não encontrado.');
    }
    if (channel.kind !== 'text') throw new HttpError(409, 'not_a_text_channel', 'Esse é um canal de voz: não guarda mensagens.');
    return channel;
  }

  async function createSpaceWithFreshInvite(name, ownerId) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await db.createSpace({ name, ownerId, inviteCode: newInviteCode(), firstChannelName: FIRST_CHANNEL_NAME });
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
      user = await db.createUser({ username, displayName, passwordHash });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError(409, 'username_taken', 'Esse nome de usuário já está em uso.', { field: 'username' });
      }
      throw error;
    }
    return { status: 201, body: { user }, headers: await startSession(user.id) };
  });

  router.post('/api/auth/login', async ({ req, body }) => {
    throttle(authLimiter, clientAddress(req));
    const input = await body();
    const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
    const password = typeof input.password === 'string' ? input.password : '';

    const record = username ? await db.findUserForLogin(username) : undefined;
    const passwordMatches = await verifyPassword(password, record ? record.passwordHash : await decoyHash);
    if (!record || !passwordMatches) {
      throw new HttpError(401, 'invalid_credentials', 'Usuário ou senha incorretos.');
    }
    const { passwordHash: _omitted, ...user } = record;
    return { status: 200, body: { user }, headers: await startSession(user.id) };
  });

  router.post('/api/auth/logout', async ({ req }) => {
    const session = await currentSession(req);
    if (session) {
      await db.deleteSession(session.tokenHash);
      await hub.disconnectSession(session.tokenHash);
    }
    return { status: 204, headers: { 'Set-Cookie': sessionCookie('', { maxAgeSeconds: 0, secure: config.secureCookies }) } };
  });

  /** Tudo que a interface precisa para abrir: a conta, as rodas, os canais e quem está nelas. */
  router.get('/api/bootstrap', async ({ req }) => {
    const user = await requireUser(req);
    const [spaces, plainChannels, online, voiceStates] = await Promise.all([
      db.listSpacesForUser(user.id),
      db.listChannelsForUser(user.id),
      db.onlineUserIds(),
      db.listVoiceStatesForUser(user.id),
    ]);
    const channels = withVoice(plainChannels, voiceStates);
    const memberLists = await Promise.all(spaces.map((space) => db.listMembers(space.id)));
    return {
      status: 200,
      body: {
        user,
        spaces: spaces.map((space, index) => ({
          ...space,
          channels: channels.filter((channel) => channel.spaceId === space.id),
          members: memberLists[index].map(withPresence(online)),
        })),
      },
    };
  });

  // --- rodas e canais --------------------------------------------------------

  router.post('/api/spaces', async ({ req, body }) => {
    const user = await requireUser(req);
    throttle(writeLimiter, user.id);
    const name = parseSpaceName((await body()).name);
    const created = await createSpaceWithFreshInvite(name, user.id);
    const space = await describeSpace(created, user.id, await db.onlineUserIds());
    await hub.toUser(user.id, { type: 'space_add', space });
    return { status: 201, body: { space } };
  });

  router.post('/api/spaces/join', async ({ req, body }) => {
    const user = await requireUser(req);
    throttle(writeLimiter, user.id);
    const code = parseInviteCode((await body()).code);
    const found = await db.findSpaceByInvite(code);
    if (!found) {
      throw new HttpError(404, 'invite_not_found', 'Não encontramos uma roda com esse convite.', { field: 'code' });
    }
    const joinedNow = await db.addMember(found.id, user.id);
    const online = await db.onlineUserIds();
    const space = await describeSpace(found, user.id, online);
    if (joinedNow) {
      await hub.toSpace(found.id, { type: 'member_join', spaceId: found.id, member: withPresence(online)(user) }, { exceptUserId: user.id });
      await hub.toUser(user.id, { type: 'space_add', space });
    }
    return { status: joinedNow ? 201 : 200, body: { space } };
  });

  router.post('/api/spaces/:id/channels', async ({ req, params, body }) => {
    const user = await requireUser(req);
    const space = await db.findSpace(params.id);
    if (!space || !(await db.isMember(space.id, user.id))) {
      throw new HttpError(404, 'space_not_found', 'Roda não encontrada.');
    }
    if (space.ownerId !== user.id) {
      throw new HttpError(403, 'forbidden', 'Só quem criou a roda pode abrir canais.');
    }
    throttle(writeLimiter, user.id);
    const input = await body();
    const name = parseChannelName(input.name);
    const kind = parseChannelKind(input.kind);

    let channel;
    try {
      channel = await db.createChannel(space.id, name, kind);
      if (kind === 'voice') channel.voice = [];
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError(409, 'channel_exists', 'Já existe um canal com esse nome nesta roda.', { field: 'name' });
      }
      throw error;
    }
    await hub.toSpace(space.id, { type: 'channel_create', channel });
    return { status: 201, body: { channel } };
  });

  // Renomear e excluir canal: só quem criou a roda.
  async function requireOwnedChannel(channelId, user) {
    const channel = await db.findChannel(channelId);
    if (!channel || !(await db.isMember(channel.spaceId, user.id))) {
      throw new HttpError(404, 'channel_not_found', 'Canal não encontrado.');
    }
    const space = await db.findSpace(channel.spaceId);
    if (space.ownerId !== user.id) throw new HttpError(403, 'forbidden', 'Só quem criou a roda pode mudar os canais.');
    return channel;
  }

  router.patch('/api/channels/:id', async ({ req, params, body }) => {
    const user = await requireUser(req);
    const channel = await requireOwnedChannel(params.id, user);
    throttle(writeLimiter, user.id);
    const name = parseChannelName((await body()).name);
    try {
      await db.renameChannel(channel.id, name);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HttpError(409, 'channel_exists', 'Já existe um canal com esse nome nesta roda.', { field: 'name' });
      }
      throw error;
    }
    const renamed = { id: channel.id, spaceId: channel.spaceId, name, kind: channel.kind };
    await hub.toSpace(channel.spaceId, { type: 'channel_update', channel: renamed });
    return { status: 200, body: { channel: renamed } };
  });

  router.delete('/api/channels/:id', async ({ req, params }) => {
    const user = await requireUser(req);
    const channel = await requireOwnedChannel(params.id, user);
    throttle(writeLimiter, user.id);
    // Toda roda mantém ao menos um canal de texto, senão não sobra onde conversar.
    if (channel.kind === 'text' && (await db.countTextChannels(channel.spaceId)) <= 1) {
      throw new HttpError(409, 'last_channel', 'Esse é o único canal de texto da roda; crie outro antes de excluir este.');
    }
    await db.deleteChannel(channel.id);
    await hub.toSpace(channel.spaceId, { type: 'channel_delete', channelId: channel.id, spaceId: channel.spaceId });
    return { status: 204 };
  });

  // --- mensagens -------------------------------------------------------------

  router.get('/api/channels/:id/messages', async ({ req, params, url }) => {
    const user = await requireUser(req);
    const channel = await requireChannel(params.id, user.id);
    const before = url.searchParams.get('before');
    const limit = url.searchParams.get('limit');
    return {
      status: 200,
      body: await db.listMessages(channel.id, {
        before: before === null ? Number.MAX_SAFE_INTEGER : parsePositiveInt(before, 'before'),
        limit: limit === null ? 50 : Math.min(100, parsePositiveInt(limit, 'limit')),
      }),
    };
  });

  router.post('/api/channels/:id/messages', async ({ req, params, body }) => {
    const user = await requireUser(req);
    const channel = await requireChannel(params.id, user.id);
    throttle(messageLimiter, user.id);
    const content = parseMessageContent((await body()).content);
    const message = await db.createMessage({ channelId: channel.id, author: user, content });
    await db.markRead(user.id, channel.id, message.id);
    await hub.messageCreated(channel.spaceId, message.id);
    return { status: 201, body: { message } };
  });

  router.post('/api/channels/:id/ack', async ({ req, params, body }) => {
    const user = await requireUser(req);
    const channel = await requireChannel(params.id, user.id);
    const messageId = parsePositiveInt((await body()).messageId, 'messageId');
    const lastReadId = await db.markRead(user.id, channel.id, messageId);
    // As outras abas da mesma pessoa também deixam de mostrar o canal como não lido.
    await hub.toUser(user.id, { type: 'read_state', channelId: channel.id, lastReadId });
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
