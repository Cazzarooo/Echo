// Dados de demonstração para desenvolvimento: três contas, uma roda e um pouco
// de conversa. Rode com `npm run seed`. Não faz nada se as contas já existirem.
//
// ATENÇÃO: a senha abaixo é pública (está neste arquivo). Serve só para testar
// na sua máquina; não use este seed num servidor exposto à rede.

import fs from 'node:fs';
import path from 'node:path';
import { hashPassword, newInviteCode } from '../server/src/auth.js';
import { loadConfig } from '../server/src/config.js';
import { openDatabase } from '../server/src/db.js';

const DEMO_PASSWORD = 'echo-demo-2026';

const PEOPLE = [
  { username: 'ana', displayName: 'Ana Ribeiro' },
  { username: 'beto', displayName: 'Beto Nogueira' },
  { username: 'carla', displayName: 'Carla Menezes' },
];

// [canal, autor, minutos atrás, texto]
const CONVERSATION = [
  ['geral', 'ana', 1580, 'Pessoal, sábado tem mutirão pra arrumar a pracinha. Quem topa?'],
  ['geral', 'beto', 1577, 'Eu vou! Levo as luvas e os sacos de lixo.'],
  ['geral', 'carla', 1560, 'Posso levar café e bolo de fubá pra depois.'],
  ['geral', 'ana', 52, 'Fechado então: sábado às 8h na pracinha.'],
  ['geral', 'ana', 51, 'A prefeitura mandou o guia de descarte: https://example.org/guia-de-descarte'],
  ['geral', 'beto', 47, 'Boa. Alguém tem carrinho de mão?'],
  ['avisos', 'ana', 300, 'A coleta de recicláveis passa às terças e sextas, a partir das 7h.'],
];

const config = loadConfig();
fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
const db = openDatabase(config.dbFile);

try {
  if (db.findUserForLogin(PEOPLE[0].username)) {
    console.log('[seed] os dados de demonstração já existem; nada a fazer.');
  } else {
    const passwordHash = await hashPassword(DEMO_PASSWORD);
    const users = {};
    for (const person of PEOPLE) users[person.username] = db.createUser({ ...person, passwordHash });

    const space = db.createSpace({
      name: 'Vizinhos da rua',
      ownerId: users.ana.id,
      inviteCode: newInviteCode(),
      firstChannelName: 'geral',
    });
    db.addMember(space.id, users.beto.id);
    db.addMember(space.id, users.carla.id);
    db.createChannel(space.id, 'avisos');
    db.createChannel(space.id, 'festa-junina');

    const channelByName = Object.fromEntries(db.listChannelsForSpace(space.id, users.ana.id).map((channel) => [channel.name, channel]));
    const now = Date.now();
    for (const [channelName, author, minutesAgo, content] of CONVERSATION) {
      const message = db.createMessage({
        channelId: channelByName[channelName].id,
        author: users[author],
        content,
        createdAt: now - minutesAgo * 60_000,
      });
      db.markRead(users[author].id, message.channelId, message.id);
    }

    console.log(`[seed] roda "${space.name}" criada, convite ${space.inviteCode}.`);
    console.log(`[seed] contas: ${PEOPLE.map((person) => person.username).join(', ')} (a senha está em scripts/seed.mjs).`);
  }
} finally {
  db.close();
}
