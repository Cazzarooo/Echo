import { DatabaseSync } from 'node:sqlite';

/**
 * Cada item é uma migração; o índice + 1 vira o PRAGMA user_version.
 * Para mudar o esquema, acrescente um item novo (nunca edite um já publicado).
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

export function isUniqueViolation(error) {
  return error instanceof Error && /UNIQUE constraint failed/.test(error.message);
}

const SPACE_COLUMNS = 'id, name, owner_id AS ownerId, invite_code AS inviteCode';
const USER_COLUMNS = 'u.id, u.username, u.display_name AS displayName';
const CHANNEL_STATE_COLUMNS = `
  c.id, c.space_id AS spaceId, c.name,
  (SELECT MAX(msg.id) FROM messages msg WHERE msg.channel_id = c.id) AS lastMessageId,
  COALESCE(r.last_read_id, 0) AS lastReadId`;

function toMessage(row) {
  return {
    id: row.id,
    channelId: row.channelId,
    content: row.content,
    createdAt: row.createdAt,
    author: { id: row.authorId, username: row.authorUsername, displayName: row.authorDisplayName },
  };
}

/** Abre (e migra) o banco. Todas as consultas do servidor passam por este objeto. */
export function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);

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
    messagesBefore: db.prepare(`
      SELECT msg.id, msg.channel_id AS channelId, msg.content, msg.created_at AS createdAt,
             u.id AS authorId, u.username AS authorUsername, u.display_name AS authorDisplayName
      FROM messages msg JOIN users u ON u.id = msg.author_id
      WHERE msg.channel_id = ? AND msg.id < ?
      ORDER BY msg.id DESC LIMIT ?`),
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

  return {
    close: () => db.close(),

    // --- usuários e sessões -------------------------------------------------
    createUser({ username, displayName, passwordHash }) {
      const { lastInsertRowid } = q.insertUser.run(username, displayName, passwordHash, Date.now());
      return q.userById.get(lastInsertRowid);
    },
    findUserById: (id) => q.userById.get(id),
    /** Inclui passwordHash; só para o fluxo de login. */
    findUserForLogin: (username) => q.userAuthByUsername.get(username),

    createSession(tokenHash, userId, expiresAt) {
      q.insertSession.run(tokenHash, userId, Date.now(), expiresAt);
    },
    findSessionUser: (tokenHash) => q.sessionUser.get(tokenHash, Date.now()),
    deleteSession: (tokenHash) => q.deleteSession.run(tokenHash),
    deleteExpiredSessions: () => q.deleteExpiredSessions.run(Date.now()),

    // --- rodas (spaces) -----------------------------------------------------
    /** Cria a roda, o primeiro canal e a participação do dono, tudo ou nada. */
    createSpace({ name, ownerId, inviteCode, firstChannelName }) {
      return transaction(() => {
        const now = Date.now();
        const spaceId = q.insertSpace.run(name, ownerId, inviteCode, now).lastInsertRowid;
        q.insertChannel.run(spaceId, firstChannelName, now);
        q.insertMember.run(spaceId, ownerId, now);
        q.markSpaceRead.run(ownerId, spaceId);
        return q.spaceById.get(spaceId);
      });
    },
    findSpace: (id) => q.spaceById.get(id),
    findSpaceByInvite: (code) => q.spaceByInvite.get(code),
    listSpacesForUser: (userId) => q.spacesForUser.all(userId),

    /** Devolve true se a pessoa entrou agora, false se já participava. */
    addMember(spaceId, userId) {
      return transaction(() => {
        const { changes } = q.insertMember.run(spaceId, userId, Date.now());
        if (changes > 0) q.markSpaceRead.run(userId, spaceId);
        return changes > 0;
      });
    },
    isMember: (spaceId, userId) => q.isMember.get(spaceId, userId) !== undefined,
    listMembers: (spaceId) => q.members.all(spaceId),
    listMemberIds: (spaceId) => q.memberIds.all(spaceId).map((row) => row.id),
    /** Todo mundo que divide ao menos uma roda com a pessoa (para avisos de presença). */
    listCoMemberIds: (userId) => q.coMemberIds.all(userId, userId).map((row) => row.id),

    // --- canais -------------------------------------------------------------
    createChannel(spaceId, name) {
      const { lastInsertRowid } = q.insertChannel.run(spaceId, name, Date.now());
      return { id: Number(lastInsertRowid), spaceId, name, lastMessageId: null, lastReadId: 0 };
    },
    findChannel: (id) => q.channelById.get(id),
    listChannelsForUser: (userId) => q.channelsForUser.all(userId),
    listChannelsForSpace: (spaceId, userId) => q.channelsForSpace.all(userId, spaceId),

    // --- mensagens ----------------------------------------------------------
    createMessage({ channelId, author, content, createdAt = Date.now() }) {
      const { lastInsertRowid } = q.insertMessage.run(channelId, author.id, content, createdAt);
      return {
        id: Number(lastInsertRowid),
        channelId,
        content,
        createdAt,
        author: { id: author.id, username: author.username, displayName: author.displayName },
      };
    },
    /** Página de mensagens mais antigas que `before`, em ordem cronológica. */
    listMessages(channelId, { before, limit }) {
      const rows = q.messagesBefore.all(channelId, before, limit + 1);
      const hasMore = rows.length > limit;
      return { messages: rows.slice(0, limit).reverse().map(toMessage), hasMore };
    },

    // --- leitura ------------------------------------------------------------
    /** Marca como lido até `messageId` (nunca volta atrás, nunca passa do que existe). */
    markRead(userId, channelId, messageId) {
      const newest = q.maxMessageId.get(channelId).id;
      q.upsertRead.run(userId, channelId, Math.min(messageId, newest));
      return q.readState.get(userId, channelId).lastReadId;
    },
  };
}
