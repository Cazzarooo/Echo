// Testes de ponta a ponta: sobem o servidor de verdade numa porta livre, com um
// banco temporário, e falam com ele por HTTP e WebSocket como um cliente faria.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
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
  config.rateLimits.auth.limit = 1000; // todos os testes saem do mesmo IP
  app = createApp(config);
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
  assert.deepEqual(await channelOf(ana), { id: channelId, spaceId: space.id, name: 'geral', lastMessageId: message.id, lastReadId: message.id });
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
