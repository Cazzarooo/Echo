import { PRESENCE_FRESH_MS, PRESENCE_STALE_MS, toMessage, toVoiceState } from './shared.js';

/**
 * Banco Postgres, para o servidor hospedado: lá não há disco permanente e pode
 * haver várias instâncias do servidor ao mesmo tempo, todas neste mesmo banco.
 *
 * Recebe um "driver" (ver pg-driver.js): { query(sql, params) -> linhas,
 * transaction(fn(query, exec)), listen(canal, fn), close() }. Nos testes o driver
 * é o PGlite, um Postgres embutido, para este arquivo rodar sem servidor de banco.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at DOUBLE PRECISION NOT NULL,
  expires_at DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS spaces (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  owner_id    INTEGER NOT NULL REFERENCES users(id),
  invite_code TEXT NOT NULL UNIQUE,
  created_at  DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS space_members (
  space_id  INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (space_id, user_id)
);
CREATE INDEX IF NOT EXISTS space_members_user ON space_members(user_id);

CREATE TABLE IF NOT EXISTS channels (
  id         SERIAL PRIMARY KEY,
  space_id   INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at DOUBLE PRECISION NOT NULL,
  UNIQUE (space_id, name)
);

CREATE TABLE IF NOT EXISTS messages (
  id         SERIAL PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id  INTEGER NOT NULL REFERENCES users(id),
  content    TEXT NOT NULL,
  created_at DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel_id, id);

CREATE TABLE IF NOT EXISTS read_states (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE IF NOT EXISTS presence (
  instance_id TEXT NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connections INTEGER NOT NULL,
  seen_at     DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (instance_id, user_id)
);

-- Canais de voz, e quem está em cada chamada. peer_id identifica a aba da
-- pessoa (é com ele que os participantes se conectam entre si).
ALTER TABLE channels ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'text';

CREATE TABLE IF NOT EXISTS voice_states (
  peer_id       TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  instance_id   TEXT NOT NULL,
  channel_id    INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted         BOOLEAN NOT NULL DEFAULT FALSE,
  camera        TEXT,
  screen        TEXT,
  joined_at     DOUBLE PRECISION NOT NULL,
  seen_at       DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS voice_states_channel ON voice_states(channel_id);

-- Avisos grandes demais para o NOTIFY (ver bus.js) passam por aqui.
CREATE TABLE IF NOT EXISTS bus_payloads (
  id         SERIAL PRIMARY KEY,
  body       TEXT NOT NULL,
  created_at DOUBLE PRECISION NOT NULL
);
`;

const SPACE_COLUMNS = 'id, name, owner_id AS "ownerId", invite_code AS "inviteCode"';
const USER_COLUMNS = 'u.id, u.username, u.display_name AS "displayName"';
const CHANNEL_STATE_COLUMNS = `
  c.id, c.space_id AS "spaceId", c.name, c.kind,
  (SELECT MAX(msg.id) FROM messages msg WHERE msg.channel_id = c.id) AS "lastMessageId",
  COALESCE(r.last_read_id, 0) AS "lastReadId"`;
const MESSAGE_SELECT = `
  SELECT msg.id, msg.channel_id AS "channelId", msg.content, msg.created_at AS "createdAt",
         u.id AS "authorId", u.username AS "authorUsername", u.display_name AS "authorDisplayName"
  FROM messages msg JOIN users u ON u.id = msg.author_id`;
// Quem entra numa roda começa com tudo lido, em vez de herdar o histórico como "novo".
const MARK_SPACE_READ = `
  INSERT INTO read_states (user_id, channel_id, last_read_id)
  SELECT $1, c.id, COALESCE((SELECT MAX(msg.id) FROM messages msg WHERE msg.channel_id = c.id), 0)
  FROM channels c WHERE c.space_id = $2
  ON CONFLICT (user_id, channel_id) DO NOTHING`;
const IS_ONLINE = 'SELECT 1 AS ok FROM presence WHERE user_id = $1 AND seen_at > $2 LIMIT 1';

export async function openPostgresDatabase(driver) {
  // Várias instâncias podem nascer ao mesmo tempo; a trava evita duas criando as tabelas juntas.
  await driver.transaction(async (query, exec) => {
    await query('SELECT pg_advisory_xact_lock(3246810)');
    await exec(SCHEMA);
  });

  const all = (sql, params) => driver.query(sql, params);
  const one = async (sql, params) => (await driver.query(sql, params))[0];
  const online = async (userId) => (await one(IS_ONLINE, [userId, Date.now() - PRESENCE_FRESH_MS])) !== undefined;

  return {
    close: () => driver.close(),

    // --- usuários e sessões -------------------------------------------------
    createUser: ({ username, displayName, passwordHash }) =>
      one(
        `INSERT INTO users AS u (username, display_name, password_hash, created_at) VALUES ($1, $2, $3, $4)
         RETURNING ${USER_COLUMNS}`,
        [username, displayName, passwordHash, Date.now()],
      ),
    /** Inclui passwordHash; só para o fluxo de login. */
    findUserForLogin: (username) =>
      one(`SELECT ${USER_COLUMNS}, u.password_hash AS "passwordHash" FROM users u WHERE u.username = $1`, [username]),

    async createSession(tokenHash, userId, expiresAt) {
      await all('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)', [
        tokenHash,
        userId,
        Date.now(),
        expiresAt,
      ]);
    },
    findSessionUser: (tokenHash) =>
      one(
        `SELECT ${USER_COLUMNS} FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > $2`,
        [tokenHash, Date.now()],
      ),
    async deleteSession(tokenHash) {
      await all('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
    },
    async deleteExpiredSessions() {
      await all('DELETE FROM sessions WHERE expires_at <= $1', [Date.now()]);
    },

    // --- rodas (spaces) -----------------------------------------------------
    /** Cria a roda, o primeiro canal e a participação do dono, tudo ou nada. */
    createSpace: ({ name, ownerId, inviteCode, firstChannelName }) =>
      driver.transaction(async (query) => {
        const now = Date.now();
        const [space] = await query(
          `INSERT INTO spaces (name, owner_id, invite_code, created_at) VALUES ($1, $2, $3, $4) RETURNING ${SPACE_COLUMNS}`,
          [name, ownerId, inviteCode, now],
        );
        await query('INSERT INTO channels (space_id, name, created_at) VALUES ($1, $2, $3)', [space.id, firstChannelName, now]);
        await query('INSERT INTO space_members (space_id, user_id, joined_at) VALUES ($1, $2, $3)', [space.id, ownerId, now]);
        await query(MARK_SPACE_READ, [ownerId, space.id]);
        return space;
      }),
    findSpace: (id) => one(`SELECT ${SPACE_COLUMNS} FROM spaces WHERE id = $1`, [id]),
    findSpaceByInvite: (code) => one(`SELECT ${SPACE_COLUMNS} FROM spaces WHERE invite_code = $1`, [code]),
    listSpacesForUser: (userId) =>
      all(
        `SELECT s.id, s.name, s.owner_id AS "ownerId", s.invite_code AS "inviteCode"
         FROM spaces s JOIN space_members m ON m.space_id = s.id
         WHERE m.user_id = $1 ORDER BY m.joined_at, s.id`,
        [userId],
      ),

    /** Devolve true se a pessoa entrou agora, false se já participava. */
    addMember: (spaceId, userId) =>
      driver.transaction(async (query) => {
        const inserted = await query(
          `INSERT INTO space_members (space_id, user_id, joined_at) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING RETURNING user_id`,
          [spaceId, userId, Date.now()],
        );
        if (inserted.length > 0) await query(MARK_SPACE_READ, [userId, spaceId]);
        return inserted.length > 0;
      }),
    isMember: async (spaceId, userId) =>
      (await one('SELECT 1 AS ok FROM space_members WHERE space_id = $1 AND user_id = $2', [spaceId, userId])) !== undefined,
    listMembers: (spaceId) =>
      all(
        `SELECT ${USER_COLUMNS} FROM space_members m JOIN users u ON u.id = m.user_id
         WHERE m.space_id = $1 ORDER BY lower(u.display_name), u.id`,
        [spaceId],
      ),
    listMemberIds: async (spaceId) =>
      (await all('SELECT user_id AS id FROM space_members WHERE space_id = $1', [spaceId])).map((row) => row.id),
    /** Todo mundo que divide ao menos uma roda com a pessoa (para avisos de presença). */
    listCoMemberIds: async (userId) =>
      (
        await all(
          `SELECT DISTINCT other.user_id AS id
           FROM space_members mine JOIN space_members other ON other.space_id = mine.space_id
           WHERE mine.user_id = $1 AND other.user_id <> $1`,
          [userId],
        )
      ).map((row) => row.id),

    // --- canais -------------------------------------------------------------
    async createChannel(spaceId, name, kind = 'text') {
      const { id } = await one('INSERT INTO channels (space_id, name, kind, created_at) VALUES ($1, $2, $3, $4) RETURNING id', [
        spaceId,
        name,
        kind,
        Date.now(),
      ]);
      return { id, spaceId, name, kind, lastMessageId: null, lastReadId: 0 };
    },
    findChannel: (id) => one('SELECT id, space_id AS "spaceId", name, kind FROM channels WHERE id = $1', [id]),
    listChannelsForUser: (userId) =>
      all(
        `SELECT ${CHANNEL_STATE_COLUMNS}
         FROM channels c
         JOIN space_members m ON m.space_id = c.space_id AND m.user_id = $1
         LEFT JOIN read_states r ON r.channel_id = c.id AND r.user_id = m.user_id
         ORDER BY c.space_id, c.id`,
        [userId],
      ),
    listChannelsForSpace: (spaceId, userId) =>
      all(
        `SELECT ${CHANNEL_STATE_COLUMNS}
         FROM channels c
         LEFT JOIN read_states r ON r.channel_id = c.id AND r.user_id = $1
         WHERE c.space_id = $2 ORDER BY c.id`,
        [userId, spaceId],
      ),

    // --- mensagens ----------------------------------------------------------
    async createMessage({ channelId, author, content, createdAt = Date.now() }) {
      const { id } = await one(
        'INSERT INTO messages (channel_id, author_id, content, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
        [channelId, author.id, content, createdAt],
      );
      return {
        id,
        channelId,
        content,
        createdAt,
        author: { id: author.id, username: author.username, displayName: author.displayName },
      };
    },
    async findMessage(id) {
      const row = await one(`${MESSAGE_SELECT} WHERE msg.id = $1`, [id]);
      return row ? toMessage(row) : null;
    },
    /** Página de mensagens mais antigas que `before`, em ordem cronológica. */
    async listMessages(channelId, { before, limit }) {
      // O id é INTEGER; "sem limite" precisa caber nele.
      const rows = await all(`${MESSAGE_SELECT} WHERE msg.channel_id = $1 AND msg.id < $2 ORDER BY msg.id DESC LIMIT $3`, [
        channelId,
        Math.min(before, 2147483647),
        limit + 1,
      ]);
      return { messages: rows.slice(0, limit).reverse().map(toMessage), hasMore: rows.length > limit };
    },

    // --- leitura ------------------------------------------------------------
    /** Marca como lido até `messageId` (nunca volta atrás, nunca passa do que existe). */
    async markRead(userId, channelId, messageId) {
      const row = await one(
        `INSERT INTO read_states (user_id, channel_id, last_read_id)
         VALUES ($1, $2, LEAST($3::bigint, (SELECT COALESCE(MAX(id), 0) FROM messages WHERE channel_id = $2))::integer)
         ON CONFLICT (user_id, channel_id)
         DO UPDATE SET last_read_id = GREATEST(read_states.last_read_id, EXCLUDED.last_read_id)
         RETURNING last_read_id AS "lastReadId"`,
        [userId, channelId, messageId],
      );
      return row.lastReadId;
    },

    // --- presença -----------------------------------------------------------
    /** Registra uma conexão; devolve true se a pessoa acabou de ficar online. */
    async presenceConnect(instanceId, userId) {
      const wasOnline = await online(userId);
      await all(
        `INSERT INTO presence (instance_id, user_id, connections, seen_at) VALUES ($1, $2, 1, $3)
         ON CONFLICT (instance_id, user_id)
         DO UPDATE SET connections = presence.connections + 1, seen_at = EXCLUDED.seen_at`,
        [instanceId, userId, Date.now()],
      );
      return !wasOnline;
    },
    /** Encerra uma conexão; devolve true se a pessoa ficou offline de vez. */
    async presenceDisconnect(instanceId, userId) {
      await all('UPDATE presence SET connections = connections - 1 WHERE instance_id = $1 AND user_id = $2', [instanceId, userId]);
      await all('DELETE FROM presence WHERE instance_id = $1 AND user_id = $2 AND connections <= 0', [instanceId, userId]);
      return !(await online(userId));
    },
    /** Sinal de vida da instância; também limpa o que ficou para trás de instâncias mortas. */
    async presenceTouch(instanceId) {
      await all('UPDATE presence SET seen_at = $1 WHERE instance_id = $2', [Date.now(), instanceId]);
      await all('DELETE FROM presence WHERE seen_at <= $1', [Date.now() - PRESENCE_STALE_MS]);
    },
    async presenceClear(instanceId) {
      await all('DELETE FROM presence WHERE instance_id = $1', [instanceId]);
    },
    async onlineUserIds() {
      const rows = await all('SELECT DISTINCT user_id AS id FROM presence WHERE seen_at > $1', [Date.now() - PRESENCE_FRESH_MS]);
      return new Set(rows.map((row) => row.id));
    },

    // --- chamadas de voz ----------------------------------------------------
    /**
     * Põe (ou repõe, numa reconexão) a aba `peerId` na chamada do canal.
     * Devolve 'ok', 'full' (chamada lotada) ou 'taken' (o peerId é de outra pessoa).
     */
    voiceJoin: ({ peerId, connectionId, instanceId, channelId, userId, limit }) =>
      driver.transaction(async (query) => {
        // Uma entrada por vez em cada canal, para o limite de participantes valer de verdade.
        await query('SELECT pg_advisory_xact_lock(7, $1)', [channelId]);
        const [owner] = await query('SELECT user_id AS "userId" FROM voice_states WHERE peer_id = $1', [peerId]);
        if (owner && owner.userId !== userId) return 'taken';
        const [{ n }] = await query(
          'SELECT COUNT(*)::integer AS n FROM voice_states WHERE channel_id = $1 AND seen_at > $2 AND peer_id <> $3',
          [channelId, Date.now() - PRESENCE_FRESH_MS, peerId],
        );
        if (n >= limit) return 'full';
        const now = Date.now();
        await query(
          `INSERT INTO voice_states (peer_id, connection_id, instance_id, channel_id, user_id, joined_at, seen_at)
           VALUES ($1, $2, $3, $4, $5, $6, $6)
           ON CONFLICT (peer_id) DO UPDATE SET
             connection_id = EXCLUDED.connection_id, instance_id = EXCLUDED.instance_id, seen_at = EXCLUDED.seen_at,
             muted = CASE WHEN voice_states.channel_id = EXCLUDED.channel_id THEN voice_states.muted ELSE FALSE END,
             camera = CASE WHEN voice_states.channel_id = EXCLUDED.channel_id THEN voice_states.camera ELSE NULL END,
             screen = CASE WHEN voice_states.channel_id = EXCLUDED.channel_id THEN voice_states.screen ELSE NULL END,
             joined_at = CASE WHEN voice_states.channel_id = EXCLUDED.channel_id THEN voice_states.joined_at ELSE EXCLUDED.joined_at END,
             channel_id = EXCLUDED.channel_id`,
          [peerId, connectionId, instanceId, channelId, userId, now],
        );
        return 'ok';
      }),
    /** Tira a aba da chamada, se ela ainda pertence a esta conexão. Devolve o canal, ou null. */
    async voiceLeave(peerId, connectionId) {
      const row = await one('DELETE FROM voice_states WHERE peer_id = $1 AND connection_id = $2 RETURNING channel_id AS "channelId"', [
        peerId,
        connectionId,
      ]);
      return row ? row.channelId : null;
    },
    async voiceUpdate(peerId, connectionId, { muted, camera, screen }) {
      const row = await one(
        `UPDATE voice_states SET muted = $1, camera = $2, screen = $3
         WHERE peer_id = $4 AND connection_id = $5 RETURNING channel_id AS "channelId"`,
        [muted, camera, screen, peerId, connectionId],
      );
      return row ? row.channelId : null;
    },
    async voiceParticipants(channelId) {
      const rows = await all(
        `SELECT peer_id AS "peerId", user_id AS "userId", muted, camera, screen
         FROM voice_states WHERE channel_id = $1 AND seen_at > $2 ORDER BY joined_at, peer_id`,
        [channelId, Date.now() - PRESENCE_FRESH_MS],
      );
      return rows.map(toVoiceState);
    },
    /** As duas abas estão na mesma chamada? (Só assim uma pode mandar sinal à outra.) */
    async voicePeersTogether(peerA, peerB) {
      const row = await one(
        `SELECT COUNT(DISTINCT channel_id)::integer AS channels, COUNT(*)::integer AS peers
         FROM voice_states WHERE peer_id IN ($1, $2) AND seen_at > $3`,
        [peerA, peerB, Date.now() - PRESENCE_FRESH_MS],
      );
      return row.peers === 2 && row.channels === 1;
    },
    /** Sinal de vida das chamadas desta instância; devolve os canais de onde saiu gente que sumiu. */
    async voiceTouch(instanceId) {
      await all('UPDATE voice_states SET seen_at = $1 WHERE instance_id = $2', [Date.now(), instanceId]);
      const rows = await all('DELETE FROM voice_states WHERE seen_at <= $1 RETURNING channel_id AS "channelId"', [
        Date.now() - PRESENCE_FRESH_MS,
      ]);
      return [...new Set(rows.map((row) => row.channelId))];
    },
    async voiceClear(instanceId) {
      const rows = await all('DELETE FROM voice_states WHERE instance_id = $1 RETURNING channel_id AS "channelId"', [instanceId]);
      return [...new Set(rows.map((row) => row.channelId))];
    },
    /** Quem está em chamada nos canais que a pessoa enxerga: [{ channelId, peerId, userId, ... }]. */
    async listVoiceStatesForUser(userId) {
      const rows = await all(
        `SELECT v.channel_id AS "channelId", v.peer_id AS "peerId", v.user_id AS "userId", v.muted, v.camera, v.screen
         FROM voice_states v
         JOIN channels c ON c.id = v.channel_id
         JOIN space_members m ON m.space_id = c.space_id AND m.user_id = $1
         WHERE v.seen_at > $2 ORDER BY v.joined_at, v.peer_id`,
        [userId, Date.now() - PRESENCE_FRESH_MS],
      );
      return rows.map((row) => ({ channelId: row.channelId, ...toVoiceState(row) }));
    },
  };
}
