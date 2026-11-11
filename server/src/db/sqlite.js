import { DatabaseSync } from 'node:sqlite';
import { PRESENCE_FRESH_MS, PRESENCE_STALE_MS, toMessage } from './shared.js';

/**
 * Banco em arquivo (SQLite), para uso local: desenvolvimento e o servidor
 * embutido do aplicativo desktop. A interface é a mesma de postgres.js; os
 * métodos são assíncronos só para os dois bancos serem intercambiáveis.
 *
 * Cada item é uma migração; o índice + 1 vira o PRAGMA user_version. Para mudar
 * o esquema, acrescente um item novo (nunca edite um já publicado).
 */
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  -- "spaces" são as rodas da interface.
  CREATE TABLE spaces (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    owner_id    INTEGER NOT NULL REFERENCES users(id),
    invite_code TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE space_members (
    space_id  INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (space_id, user_id)
  ) WITHOUT ROWID;
  CREATE INDEX space_members_user ON space_members(user_id);

  CREATE TABLE channels (
    id         INTEGER PRIMARY KEY,
    space_id   INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (space_id, name)
  );

  -- AUTOINCREMENT garante ids sempre crescentes: o estado de leitura compara ids.
  CREATE TABLE messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id  INTEGER NOT NULL REFERENCES users(id),
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX messages_channel ON messages(channel_id, id);

  CREATE TABLE read_states (
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, channel_id)
  ) WITHOUT ROWID;
  `,
  `
  -- Quem está conectado, por instância do servidor (ver hub.js).
  CREATE TABLE presence (
    instance_id TEXT NOT NULL,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connections INTEGER NOT NULL,
    seen_at     INTEGER NOT NULL,
    PRIMARY KEY (instance_id, user_id)
  ) WITHOUT ROWID;
  `,
];

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

const SPACE_COLUMNS = 'id, name, owner_id AS ownerId, invite_code AS inviteCode';
const USER_COLUMNS = 'u.id, u.username, u.display_name AS displayName';
const CHANNEL_STATE_COLUMNS = `
  c.id, c.space_id AS spaceId, c.name,
  (SELECT MAX(msg.id) FROM messages msg WHERE msg.channel_id = c.id) AS lastMessageId,
  COALESCE(r.last_read_id, 0) AS lastReadId`;
const MESSAGE_SELECT = `
  SELECT msg.id, msg.channel_id AS channelId, msg.content, msg.created_at AS createdAt,
         u.id AS authorId, u.username AS authorUsername, u.display_name AS authorDisplayName
  FROM messages msg JOIN users u ON u.id = msg.author_id`;

export function openSqliteDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  // Um arquivo, um servidor: presença que sobrou de uma execução anterior não vale mais.
  db.exec('DELETE FROM presence');

  const q = {
    insertUser: db.prepare('INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)'),
    userById: db.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?`),
    userAuthByUsername: db.prepare(`SELECT ${USER_COLUMNS}, u.password_hash AS passwordHash FROM users u WHERE u.username = ?`),

    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    sessionUser: db.prepare(`
      SELECT ${USER_COLUMNS} FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteExpiredSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),

    insertSpace: db.prepare('INSERT INTO spaces (name, owner_id, invite_code, created_at) VALUES (?, ?, ?, ?)'),
    spaceById: db.prepare(`SELECT ${SPACE_COLUMNS} FROM spaces WHERE id = ?`),
    spaceByInvite: db.prepare(`SELECT ${SPACE_COLUMNS} FROM spaces WHERE invite_code = ?`),
    spacesForUser: db.prepare(`
      SELECT s.id, s.name, s.owner_id AS ownerId, s.invite_code AS inviteCode
      FROM spaces s JOIN space_members m ON m.space_id = s.id
      WHERE m.user_id = ? ORDER BY m.joined_at, s.id`),

    insertMember: db.prepare('INSERT OR IGNORE INTO space_members (space_id, user_id, joined_at) VALUES (?, ?, ?)'),
    isMember: db.prepare('SELECT 1 AS ok FROM space_members WHERE space_id = ? AND user_id = ?'),
    members: db.prepare(`
      SELECT ${USER_COLUMNS} FROM space_members m JOIN users u ON u.id = m.user_id
      WHERE m.space_id = ? ORDER BY u.display_name COLLATE NOCASE, u.id`),
    memberIds: db.prepare('SELECT user_id AS id FROM space_members WHERE space_id = ?'),
    coMemberIds: db.prepare(`
      SELECT DISTINCT other.user_id AS id
      FROM space_members mine JOIN space_members other ON other.space_id = mine.space_id
      WHERE mine.user_id = ? AND other.user_id <> ?`),

    insertChannel: db.prepare('INSERT INTO channels (space_id, name, created_at) VALUES (?, ?, ?)'),
    channelById: db.prepare('SELECT id, space_id AS spaceId, name FROM channels WHERE id = ?'),
    channelsForUser: db.prepare(`
      SELECT ${CHANNEL_STATE_COLUMNS}
      FROM channels c
      JOIN space_members m ON m.space_id = c.space_id AND m.user_id = ?
      LEFT JOIN read_states r ON r.channel_id = c.id AND r.user_id = m.user_id
      ORDER BY c.space_id, c.id`),
    channelsForSpace: db.prepare(`
      SELECT ${CHANNEL_STATE_COLUMNS}
      FROM channels c
      LEFT JOIN read_states r ON r.channel_id = c.id AND r.user_id = ?
      WHERE c.space_id = ? ORDER BY c.id`),

    insertMessage: db.prepare('INSERT INTO messages (channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?)'),
    messageById: db.prepare(`${MESSAGE_SELECT} WHERE msg.id = ?`),
    messagesBefore: db.prepare(`${MESSAGE_SELECT} WHERE msg.channel_id = ? AND msg.id < ? ORDER BY msg.id DESC LIMIT ?`),
    maxMessageId: db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE channel_id = ?'),

    upsertRead: db.prepare(`
      INSERT INTO read_states (user_id, channel_id, last_read_id) VALUES (?, ?, ?)
      ON CONFLICT (user_id, channel_id)
      DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`),
    readState: db.prepare('SELECT last_read_id AS lastReadId FROM read_states WHERE user_id = ? AND channel_id = ?'),
    // Quem entra numa roda começa com tudo lido, em vez de herdar o histórico como "novo".
    markSpaceRead: db.prepare(`
      INSERT INTO read_states (user_id, channel_id, last_read_id)
      SELECT ?, c.id, COALESCE((SELECT MAX(msg.id) FROM messages msg WHERE msg.channel_id = c.id), 0)
      FROM channels c WHERE c.space_id = ?
      ON CONFLICT (user_id, channel_id) DO NOTHING`),

    isOnline: db.prepare('SELECT 1 AS ok FROM presence WHERE user_id = ? AND seen_at > ? LIMIT 1'),
    presenceUp: db.prepare(`
      INSERT INTO presence (instance_id, user_id, connections, seen_at) VALUES (?, ?, 1, ?)
      ON CONFLICT (instance_id, user_id) DO UPDATE SET connections = connections + 1, seen_at = excluded.seen_at`),
    presenceDown: db.prepare('UPDATE presence SET connections = connections - 1 WHERE instance_id = ? AND user_id = ?'),
    presenceDropEmpty: db.prepare('DELETE FROM presence WHERE instance_id = ? AND user_id = ? AND connections <= 0'),
    presenceTouch: db.prepare('UPDATE presence SET seen_at = ? WHERE instance_id = ?'),
    presenceSweep: db.prepare('DELETE FROM presence WHERE seen_at <= ?'),
    presenceClear: db.prepare('DELETE FROM presence WHERE instance_id = ?'),
    onlineIds: db.prepare('SELECT DISTINCT user_id AS id FROM presence WHERE seen_at > ?'),
  };

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const online = (userId) => q.isOnline.get(userId, Date.now() - PRESENCE_FRESH_MS) !== undefined;

  return {
    async close() {
      db.close();
    },

    // --- usuários e sessões -------------------------------------------------
    async createUser({ username, displayName, passwordHash }) {
      const { lastInsertRowid } = q.insertUser.run(username, displayName, passwordHash, Date.now());
      return q.userById.get(lastInsertRowid);
    },
    /** Inclui passwordHash; só para o fluxo de login. */
    async findUserForLogin(username) {
      return q.userAuthByUsername.get(username);
    },

    async createSession(tokenHash, userId, expiresAt) {
      q.insertSession.run(tokenHash, userId, Date.now(), expiresAt);
    },
    async findSessionUser(tokenHash) {
      return q.sessionUser.get(tokenHash, Date.now());
    },
    async deleteSession(tokenHash) {
      q.deleteSession.run(tokenHash);
    },
    async deleteExpiredSessions() {
      q.deleteExpiredSessions.run(Date.now());
    },

    // --- rodas (spaces) -----------------------------------------------------
    /** Cria a roda, o primeiro canal e a participação do dono, tudo ou nada. */
    async createSpace({ name, ownerId, inviteCode, firstChannelName }) {
      return transaction(() => {
        const now = Date.now();
        const spaceId = q.insertSpace.run(name, ownerId, inviteCode, now).lastInsertRowid;
        q.insertChannel.run(spaceId, firstChannelName, now);
        q.insertMember.run(spaceId, ownerId, now);
        q.markSpaceRead.run(ownerId, spaceId);
        return q.spaceById.get(spaceId);
      });
    },
    async findSpace(id) {
      return q.spaceById.get(id);
    },
    async findSpaceByInvite(code) {
      return q.spaceByInvite.get(code);
    },
    async listSpacesForUser(userId) {
      return q.spacesForUser.all(userId);
    },

    /** Devolve true se a pessoa entrou agora, false se já participava. */
    async addMember(spaceId, userId) {
      return transaction(() => {
        const { changes } = q.insertMember.run(spaceId, userId, Date.now());
        if (changes > 0) q.markSpaceRead.run(userId, spaceId);
        return changes > 0;
      });
    },
    async isMember(spaceId, userId) {
      return q.isMember.get(spaceId, userId) !== undefined;
    },
    async listMembers(spaceId) {
      return q.members.all(spaceId);
    },
    async listMemberIds(spaceId) {
      return q.memberIds.all(spaceId).map((row) => row.id);
    },
    /** Todo mundo que divide ao menos uma roda com a pessoa (para avisos de presença). */
    async listCoMemberIds(userId) {
      return q.coMemberIds.all(userId, userId).map((row) => row.id);
    },

    // --- canais -------------------------------------------------------------
    async createChannel(spaceId, name) {
      const { lastInsertRowid } = q.insertChannel.run(spaceId, name, Date.now());
      return { id: Number(lastInsertRowid), spaceId, name, lastMessageId: null, lastReadId: 0 };
    },
    async findChannel(id) {
      return q.channelById.get(id);
    },
    async listChannelsForUser(userId) {
      return q.channelsForUser.all(userId);
    },
    async listChannelsForSpace(spaceId, userId) {
      return q.channelsForSpace.all(userId, spaceId);
    },

    // --- mensagens ----------------------------------------------------------
    async createMessage({ channelId, author, content, createdAt = Date.now() }) {
      const { lastInsertRowid } = q.insertMessage.run(channelId, author.id, content, createdAt);
      return {
        id: Number(lastInsertRowid),
        channelId,
        content,
        createdAt,
        author: { id: author.id, username: author.username, displayName: author.displayName },
      };
    },
    async findMessage(id) {
      const row = q.messageById.get(id);
      return row ? toMessage(row) : null;
    },
    /** Página de mensagens mais antigas que `before`, em ordem cronológica. */
    async listMessages(channelId, { before, limit }) {
      const rows = q.messagesBefore.all(channelId, before, limit + 1);
      return { messages: rows.slice(0, limit).reverse().map(toMessage), hasMore: rows.length > limit };
    },

    // --- leitura ------------------------------------------------------------
    /** Marca como lido até `messageId` (nunca volta atrás, nunca passa do que existe). */
    async markRead(userId, channelId, messageId) {
      const newest = q.maxMessageId.get(channelId).id;
      q.upsertRead.run(userId, channelId, Math.min(messageId, newest));
      return q.readState.get(userId, channelId).lastReadId;
    },

    // --- presença -----------------------------------------------------------
    /** Registra uma conexão; devolve true se a pessoa acabou de ficar online. */
    async presenceConnect(instanceId, userId) {
      const wasOnline = online(userId);
      q.presenceUp.run(instanceId, userId, Date.now());
      return !wasOnline;
    },
    /** Encerra uma conexão; devolve true se a pessoa ficou offline de vez. */
    async presenceDisconnect(instanceId, userId) {
      q.presenceDown.run(instanceId, userId);
      q.presenceDropEmpty.run(instanceId, userId);
      return !online(userId);
    },
    /** Sinal de vida da instância; também limpa o que ficou para trás de instâncias mortas. */
    async presenceTouch(instanceId) {
      q.presenceTouch.run(Date.now(), instanceId);
      q.presenceSweep.run(Date.now() - PRESENCE_STALE_MS);
    },
    async presenceClear(instanceId) {
      q.presenceClear.run(instanceId);
    },
    async onlineUserIds() {
      return new Set(q.onlineIds.all(Date.now() - PRESENCE_FRESH_MS).map((row) => row.id));
    },
  };
}
