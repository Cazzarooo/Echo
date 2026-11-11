// Testes de ponta a ponta: sobem o servidor de verdade numa porta livre, com um
// banco temporário, e falam com ele por HTTP e WebSocket como um cliente faria.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const PASSWORD = randomBytes(12).toString('base64url');

let app;
let base;
let dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-test-'));
  const config = loadConfig({});
  config.port = 0;
  config.dbFile = path.join(dataDir, 'echo.sqlite');
  // ECHO_TEST_POSTGRES=1 (ver postgres.test.mjs) roda esta mesma bateria no banco do servidor hospedado.
  if (process.env.ECHO_TEST_POSTGRES === '1') {
    const { createPgliteDriver } = await import('./pglite-driver.mjs');
    config.postgres = { driver: await createPgliteDriver() };
  }
  config.rateLimits.auth.limit = 1000; // todos os testes saem do mesmo IP
  config.voice.maxParticipants = 2; // para o teste de chamada lotada caber em três contas
  app = await createApp(config);
  const { port } = await app.listen();
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Cliente HTTP com "pote de cookies" próprio, como uma aba de navegador. */
function createClient() {
  let cookie = '';

  async function call(method, pathname, body, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (body !== undefined && !('Content-Type' in headers)) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    const response = await fetch(base + pathname, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      redirect: 'manual',
    });
    const [setCookie] = response.headers.getSetCookie();
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: response.status, headers: response.headers, body: parsed };
  }

  return {
    get: (pathname, headers) => call('GET', pathname, undefined, headers),
    post: (pathname, body = {}, headers) => call('POST', pathname, body, headers),
    get cookie() {
      return cookie;
    },
  };
}

let userCounter = 0;

async function signUp(label) {
  const client = createClient();
  const username = `${label}_${(userCounter++).toString(36)}${randomBytes(3).toString('hex')}`;
  const response = await client.post('/api/auth/register', { username, displayName: label, password: PASSWORD });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return { client, user: response.body.user, username };
}

async function createSpace(owner, name = 'Roda de teste') {
  const response = await owner.client.post('/api/spaces', { name });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.space;
}

async function join(member, space) {
  const response = await member.client.post('/api/spaces/join', { code: space.inviteCode });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.space;
}

/** Conexão com o gateway que guarda os eventos e deixa esperar por um específico. */
function openGateway(client) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/gateway`, { headers: { Cookie: client.cookie } });
  const events = [];
  const waiters = new Set();

  ws.on('message', (data) => {
    events.push(JSON.parse(data.toString()));
    for (const check of [...waiters]) check();
  });

  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('unexpected-response', (_request, response) => reject(new Error(`gateway recusou com ${response.statusCode}`)));
  });

  function next(predicate, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const index = events.findIndex(predicate);
        if (index === -1) return false;
        const [event] = events.splice(index, 1);
        settle();
        resolve(event);
        return true;
      };
      const timer = setTimeout(() => {
        settle();
        reject(new Error('o evento esperado não chegou a tempo'));
      }, timeoutMs);
      const settle = () => {
        clearTimeout(timer);
        waiters.delete(check);
      };
      if (!check()) waiters.add(check);
    });
  }

  const close = () =>
    new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      ws.once('close', resolve);
      ws.close();
    });

  return { ws, opened, next, events, close };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('health identifica o servidor', async () => {
  const { status, body } = await createClient().get('/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.name, 'echo');
});

test('cadastro, sessão, login e saída', async () => {
  const { client, user, username } = await signUp('ana');
  assert.equal(user.username, username);
  assert.equal(user.displayName, 'ana');
  assert.equal('passwordHash' in user, false);

  const boot = await client.get('/api/bootstrap');
  assert.equal(boot.status, 200);
  assert.deepEqual(boot.body, { user, spaces: [] });

  const duplicate = await createClient().post('/api/auth/register', { username: username.toUpperCase(), password: PASSWORD });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.field, 'username');

  const weak = await createClient().post('/api/auth/register', { username: 'outra_pessoa', password: 'curta' });
  assert.equal(weak.status, 422);
  assert.equal(weak.body.error.field, 'password');

  const wrong = await createClient().post('/api/auth/login', { username, password: `${PASSWORD}x` });
  assert.equal(wrong.status, 401);
  const unknown = await createClient().post('/api/auth/login', { username: 'ninguem_aqui', password: PASSWORD });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error.message, wrong.body.error.message);

  const second = createClient();
  const login = await second.post('/api/auth/login', { username: ` ${username.toUpperCase()} `, password: PASSWORD });
  assert.equal(login.status, 200);
  assert.deepEqual(login.body.user, user);
  assert.match(login.headers.getSetCookie()[0], /HttpOnly; SameSite=Strict/);

  assert.equal((await second.post('/api/auth/logout')).status, 204);
  assert.equal((await second.get('/api/bootstrap')).status, 401);
  // A sessão da primeira aba continua valendo.
  assert.equal((await client.get('/api/bootstrap')).status, 200);
});

test('sem sessão, a API e o gateway recusam', async () => {
  const anonymous = createClient();
  assert.equal((await anonymous.get('/api/bootstrap')).status, 401);
  assert.equal((await anonymous.post('/api/spaces', { name: 'Não pode' })).status, 401);
  await assert.rejects(openGateway(anonymous).opened, /401/);
});

test('roda nova vem com canal e convite; o convite dá acesso', async () => {
  const ana = await signUp('ana');
  const beto = await signUp('beto');
  const carla = await signUp('carla');

  const space = await createSpace(ana, '  Vizinhos   da  rua ');
  assert.equal(space.name, 'Vizinhos da rua');
  assert.equal(space.ownerId, ana.user.id);
  assert.match(space.inviteCode, /^[A-Z0-9]{8}$/);
  assert.deepEqual(space.channels.map((channel) => channel.name), ['geral']);
  assert.deepEqual(space.members.map((member) => member.id), [ana.user.id]);

  const channelId = space.channels[0].id;
  assert.equal((await beto.client.get(`/api/channels/${channelId}/messages`)).status, 404);

  const joined = await beto.client.post('/api/spaces/join', { code: space.inviteCode.toLowerCase() });
  assert.equal(joined.status, 201);
  assert.equal(joined.body.space.members.length, 2);
  const again = await beto.client.post('/api/spaces/join', { code: space.inviteCode });
  assert.equal(again.status, 200);
  assert.equal(again.body.space.members.length, 2);

  assert.equal((await beto.client.get(`/api/channels/${channelId}/messages`)).status, 200);
  assert.equal((await carla.client.get(`/api/channels/${channelId}/messages`)).status, 404);
  assert.equal((await carla.client.post(`/api/channels/${channelId}/messages`, { content: 'oi?' })).status, 404);
  assert.equal((await carla.client.post('/api/spaces/join', { code: 'ZZZZZZZZ' })).status, 404);
});

test('mensagem chega em tempo real e controla o que está lido', async () => {
  const ana = await signUp('ana');
  const beto = await signUp('beto');
  const space = await createSpace(ana);
  await join(beto, space);
  const channelId = space.channels[0].id;

  const anaGateway = openGateway(ana.client);
  const betoGateway = openGateway(beto.client);
  await Promise.all([anaGateway.opened, betoGateway.opened]);

  const sent = await ana.client.post(`/api/channels/${channelId}/messages`, { content: 'Bom dia, roda!\r\nTudo certo?  ' });
  assert.equal(sent.status, 201);
  const message = sent.body.message;
  assert.equal(message.content, 'Bom dia, roda!\nTudo certo?');
  assert.deepEqual(message.author, ana.user);

  const forBeto = await betoGateway.next((event) => event.type === 'message_create');
  assert.deepEqual(forBeto.message, message);
  await anaGateway.next((event) => event.type === 'message_create' && event.message.id === message.id);

  const channelOf = async (person) => {
    const boot = await person.client.get('/api/bootstrap');
    return boot.body.spaces[0].channels[0];
  };
  assert.deepEqual(await channelOf(ana), { id: channelId, spaceId: space.id, name: 'geral', kind: 'text', lastMessageId: message.id, lastReadId: message.id });
  const unreadForBeto = await channelOf(beto);
  assert.equal(unreadForBeto.lastMessageId, message.id);
  assert.ok(unreadForBeto.lastReadId < message.id, 'para o Beto a mensagem ainda é nova');

  // Marcar além do que existe não "lê o futuro".
  const ack = await beto.client.post(`/api/channels/${channelId}/ack`, { messageId: message.id + 500 });
  assert.equal(ack.status, 200);
  assert.equal(ack.body.lastReadId, message.id);
  assert.equal((await betoGateway.next((event) => event.type === 'read_state')).lastReadId, message.id);
  assert.equal((await channelOf(beto)).lastReadId, message.id);

  for (const content of ['dois', 'três', 'quatro']) {
    assert.equal((await beto.client.post(`/api/channels/${channelId}/messages`, { content })).status, 201);
  }
  const newest = await ana.client.get(`/api/channels/${channelId}/messages?limit=2`);
  assert.deepEqual(newest.body.messages.map((item) => item.content), ['três', 'quatro']);
  assert.equal(newest.body.hasMore, true);
  const older = await ana.client.get(`/api/channels/${channelId}/messages?limit=2&before=${newest.body.messages[0].id}`);
  assert.deepEqual(older.body.messages.map((item) => item.content), ['Bom dia, roda!\nTudo certo?', 'dois']);
  assert.equal(older.body.hasMore, false);

  await Promise.all([anaGateway.close(), betoGateway.close()]);
});

test('presença e "digitando" vão só para quem divide uma roda', async () => {
  const ana = await signUp('ana');
  const beto = await signUp('beto');
  const carla = await signUp('carla');
  const space = await createSpace(ana);
  await join(beto, space);
  const channelId = space.channels[0].id;

  const anaGateway = openGateway(ana.client);
  const carlaGateway = openGateway(carla.client);
  await Promise.all([anaGateway.opened, carlaGateway.opened]);

  const betoGateway = openGateway(beto.client);
  await betoGateway.opened;
  assert.deepEqual(await anaGateway.next((event) => event.type === 'presence'), { type: 'presence', userId: beto.user.id, online: true });

  const boot = await ana.client.get('/api/bootstrap');
  assert.deepEqual(
    boot.body.spaces[0].members.map((member) => [member.id, member.online]).sort(),
    [[ana.user.id, true], [beto.user.id, true]].sort(),
  );

  betoGateway.ws.send(JSON.stringify({ type: 'typing', channelId }));
  assert.deepEqual(await anaGateway.next((event) => event.type === 'typing'), { type: 'typing', channelId, userId: beto.user.id });

  // A Carla não está na roda: tentar "digitar" num canal alheio não chega a ninguém.
  carlaGateway.ws.send(JSON.stringify({ type: 'typing', channelId }));
  await betoGateway.close();
  assert.deepEqual(await anaGateway.next((event) => event.type === 'presence'), { type: 'presence', userId: beto.user.id, online: false });
  await pause(100);
  assert.deepEqual(anaGateway.events, [], 'nada além do esperado chegou para a Ana');
  assert.deepEqual(carlaGateway.events, [], 'a Carla não recebe nada da roda');

  await Promise.all([anaGateway.close(), carlaGateway.close()]);
});

test('só quem criou a roda abre canais', async () => {
  const ana = await signUp('ana');
  const beto = await signUp('beto');
  const space = await createSpace(ana);
  await join(beto, space);
  const betoGateway = openGateway(beto.client);
  await betoGateway.opened;

  assert.equal((await beto.client.post(`/api/spaces/${space.id}/channels`, { name: 'bagunça' })).status, 403);

  const created = await ana.client.post(`/api/spaces/${space.id}/channels`, { name: '  Reuniões de Sexta! ' });
  assert.equal(created.status, 201);
  assert.equal(created.body.channel.name, 'reuniões-de-sexta');
  assert.deepEqual((await betoGateway.next((event) => event.type === 'channel_create')).channel, created.body.channel);

  const duplicate = await ana.client.post(`/api/spaces/${space.id}/channels`, { name: 'reuniões de sexta' });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.field, 'name');
  assert.equal((await ana.client.post(`/api/spaces/${space.id}/channels`, { name: '!!!' })).status, 422);

  await betoGateway.close();
});

test('entradas inválidas e origem de outro site são recusadas', async () => {
  const ana = await signUp('ana');
  const space = await createSpace(ana);
  const messages = `/api/channels/${space.channels[0].id}/messages`;

  assert.equal((await ana.client.post(messages, { content: '   \n ' })).status, 422);
  assert.equal((await ana.client.post(messages, { content: 'a'.repeat(4001) })).status, 422);
  assert.equal((await ana.client.post(messages, { content: 42 })).status, 422);
  assert.equal((await ana.client.post(messages, '{"content":')).status, 400);
  assert.equal((await ana.client.post(messages, '[1]')).status, 400);
  assert.equal((await ana.client.post(messages, 'content=oi', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await ana.client.get(`${messages}?limit=abc`)).status, 422);

  const crossSite = await ana.client.post(messages, { content: 'vindo de outro site' }, { Origin: 'https://outro-site.example' });
  assert.equal(crossSite.status, 403);
  const sameSite = await ana.client.post(messages, { content: 'da própria página' }, { Origin: base });
  assert.equal(sameSite.status, 201);

  assert.equal((await ana.client.get('/api/nao-existe')).status, 404);
  assert.equal((await ana.client.get('/api/auth/login')).status, 405);
});

test('envio em rajada é freado', async () => {
  const ana = await signUp('ana');
  const space = await createSpace(ana);
  const messages = `/api/channels/${space.channels[0].id}/messages`;

  const statuses = [];
  let lastResponse;
  for (let index = 0; index < 11; index++) {
    lastResponse = await ana.client.post(messages, { content: `mensagem ${index}` });
    statuses.push(lastResponse.status);
  }
  assert.deepEqual(statuses, [...Array(10).fill(201), 429]);
  assert.ok(Number(lastResponse.headers.get('retry-after')) >= 1);
});

test('a interface web sai com CSP e não deixa escapar da pasta', async () => {
  const client = createClient();

  const root = await client.get('/');
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/app');

  const page = await client.get('/app');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');

  for (const escape of [
    '/app/assets/..%2F..%2Fserver%2Fsrc%2Findex.js',
    '/app/assets/..%5C..%5Cpackage.json',
    '/app/assets/js/..%2F..%2F..%2Fpackage.json',
    '/app/assets/nao-existe.js',
    '/app/../package.json',
  ]) {
    assert.equal((await client.get(escape)).status, 404, escape);
  }
});

test('canal de voz: entrar, ver quem está, combinar a conexão e sair', async () => {
  const ana = await signUp('ana');
  const beto = await signUp('beto');
  const carla = await signUp('carla');
  const dora = await signUp('dora');
  const space = await createSpace(ana);
  await join(beto, space);
  await join(dora, space);

  const created = await ana.client.post(`/api/spaces/${space.id}/channels`, { name: 'Bate-papo', kind: 'voice' });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.channel, { id: created.body.channel.id, spaceId: space.id, name: 'bate-papo', kind: 'voice', lastMessageId: null, lastReadId: 0, voice: [] });
  const voiceId = created.body.channel.id;
  assert.equal((await ana.client.post(`/api/spaces/${space.id}/channels`, { name: 'outro', kind: 'video' })).status, 422);
  // Canal de voz não guarda mensagens.
  assert.equal((await ana.client.post(`/api/channels/${voiceId}/messages`, { content: 'oi' })).status, 409);
  assert.equal((await ana.client.get(`/api/channels/${voiceId}/messages`)).status, 409);

  const [anaGw, betoGw, carlaGw, doraGw] = [ana, beto, carla, dora].map((person) => openGateway(person.client));
  await Promise.all([anaGw.opened, betoGw.opened, carlaGw.opened, doraGw.opened]);
  const send = (gateway, event) => gateway.ws.send(JSON.stringify(event));
  const anaPeer = randomUUID();
  const betoPeer = randomUUID();
  const person = (peerId, user, extra = {}) => ({ peerId, userId: user.id, muted: false, camera: null, screen: null, ...extra });
  const stateWith = (count) => (event) => event.type === 'voice_state' && event.channelId === voiceId && event.participants.length === count;

  // Num canal de texto, ou com identificador inválido, não há chamada.
  send(anaGw, { type: 'voice_join', channelId: space.channels[0].id, peerId: anaPeer });
  assert.equal((await anaGw.next((event) => event.type === 'voice_error')).reason, 'not_found');
  send(anaGw, { type: 'voice_join', channelId: voiceId, peerId: 'nao-e-uuid' });

  send(anaGw, { type: 'voice_join', channelId: voiceId, peerId: anaPeer });
  const anaReady = await anaGw.next((event) => event.type === 'voice_ready');
  assert.equal(anaReady.channelId, voiceId);
  assert.deepEqual(anaReady.participants, [person(anaPeer, ana.user)]);
  assert.ok(Array.isArray(anaReady.iceServers) && anaReady.iceServers.length > 0);

  send(betoGw, { type: 'voice_join', channelId: voiceId, peerId: betoPeer });
  const betoReady = await betoGw.next((event) => event.type === 'voice_ready');
  assert.deepEqual(betoReady.participants, [person(anaPeer, ana.user), person(betoPeer, beto.user)]);
  assert.deepEqual((await anaGw.next(stateWith(2))).participants, betoReady.participants);
  // Quem é da roda mas não está na chamada também vê quem entrou.
  await doraGw.next(stateWith(2));

  // A chamada está no limite (2 neste teste): a Dora não cabe; a Carla nem é da roda.
  send(doraGw, { type: 'voice_join', channelId: voiceId, peerId: randomUUID() });
  assert.equal((await doraGw.next((event) => event.type === 'voice_error')).reason, 'full');
  const carlaPeer = randomUUID();
  send(carlaGw, { type: 'voice_join', channelId: voiceId, peerId: carlaPeer });
  assert.equal((await carlaGw.next((event) => event.type === 'voice_error')).reason, 'not_found');
  // Ninguém toma o lugar de outra pessoa usando o identificador dela.
  send(doraGw, { type: 'voice_join', channelId: voiceId, peerId: anaPeer });
  assert.equal((await doraGw.next((event) => event.type === 'voice_error')).reason, 'taken');

  // Sinais de conexão passam de uma aba à outra, inclusive os grandes (ofertas com vídeo).
  const offer = { description: { type: 'offer', sdp: 'v=0\r\n' + 'a=candidate '.repeat(1500) } };
  send(betoGw, { type: 'voice_signal', to: anaPeer, data: offer });
  assert.deepEqual(await anaGw.next((event) => event.type === 'voice_signal'), { type: 'voice_signal', from: betoPeer, data: offer });
  send(anaGw, { type: 'voice_signal', to: betoPeer, data: { candidate: { candidate: 'x' } } });
  assert.equal((await betoGw.next((event) => event.type === 'voice_signal')).from, anaPeer);
  // Quem está fora da chamada não consegue mandar sinal para dentro dela.
  send(carlaGw, { type: 'voice_signal', to: anaPeer, data: { description: { type: 'offer', sdp: 'intruso' } } });
  send(doraGw, { type: 'voice_signal', to: anaPeer, data: { description: { type: 'offer', sdp: 'intruso' } } });

  // Microfone, câmera e tela aparecem para todos.
  send(anaGw, { type: 'voice_update', muted: true, camera: 'stream-camera-1', screen: '<script>' });
  const updated = await betoGw.next((event) => event.type === 'voice_state' && event.participants.some((item) => item.muted));
  assert.deepEqual(updated.participants, [person(anaPeer, ana.user, { muted: true, camera: 'stream-camera-1' }), person(betoPeer, beto.user)]);

  const boot = await dora.client.get('/api/bootstrap');
  assert.deepEqual(boot.body.spaces[0].channels.find((channel) => channel.id === voiceId).voice, updated.participants);

  // Queda de conexão não derruba a chamada: ao reconectar com o mesmo identificador, o lugar continua lá.
  await betoGw.close();
  const betoAgain = openGateway(beto.client);
  await betoAgain.opened;
  send(betoAgain, { type: 'voice_join', channelId: voiceId, peerId: betoPeer });
  assert.equal((await betoAgain.next((event) => event.type === 'voice_ready')).participants.length, 2);
  send(anaGw, { type: 'voice_signal', to: betoPeer, data: { candidate: { candidate: 'depois-da-reconexao' } } });
  assert.equal((await betoAgain.next((event) => event.type === 'voice_signal')).data.candidate.candidate, 'depois-da-reconexao');

  send(betoAgain, { type: 'voice_leave' });
  const afterLeave = (event) => stateWith(1)(event) && event.participants[0].muted; // o estado de 1 pessoa do começo ainda está na fila
  assert.deepEqual((await anaGw.next(afterLeave)).participants, [person(anaPeer, ana.user, { muted: true, camera: 'stream-camera-1' })]);

  await pause(150);
  assert.equal(anaGw.events.some((event) => event.type === 'voice_signal'), false, 'sinais de quem está fora não chegam');
  assert.equal(carlaGw.events.some((event) => event.type.startsWith('voice_') && event.type !== 'voice_error'), false, 'quem não é da roda não vê a chamada');

  await Promise.all([anaGw.close(), betoAgain.close(), carlaGw.close(), doraGw.close()]);
});
