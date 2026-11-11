// O que os dois bancos (sqlite.js e postgres.js) têm em comum.

/** Uma presença vale enquanto a instância deu sinal de vida há menos que isto. */
export const PRESENCE_FRESH_MS = 75_000;
/** Depois disto, registros de presença de instâncias que sumiram são apagados. */
export const PRESENCE_STALE_MS = 10 * 60_000;

/** Uma pessoa numa chamada, como a interface recebe. */
export function toVoiceState(row) {
  return {
    peerId: row.peerId,
    userId: row.userId,
    muted: row.muted === true || row.muted === 1,
    camera: row.camera ?? null,
    screen: row.screen ?? null,
  };
}

export function toMessage(row) {
  return {
    id: row.id,
    channelId: row.channelId,
    content: row.content,
    createdAt: row.createdAt,
    author: { id: row.authorId, username: row.authorUsername, displayName: row.authorDisplayName },
  };
}

/** Violação de unicidade, no SQLite (pela mensagem) ou no Postgres (código 23505). */
export function isUniqueViolation(error) {
  return error instanceof Error && (error.code === '23505' || /UNIQUE constraint failed/.test(error.message));
}
