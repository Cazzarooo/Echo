import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Raiz do projeto: a pasta que contém server/, web/ e desktop/. */
export const PROJECT_ROOT = path.resolve(here, '..', '..');

export const SERVER_NAME = 'echo';
export const SERVER_VERSION = '0.1.0';

const DEFAULT_ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

function parseIceServers(json) {
  if (!json) return DEFAULT_ICE_SERVERS;
  try {
    const servers = JSON.parse(json);
    if (Array.isArray(servers) && servers.every((server) => server && typeof server === 'object' && server.urls)) return servers;
  } catch {
    /* cai no aviso abaixo */
  }
  console.error('[echo] ECHO_ICE_SERVERS não é uma lista JSON válida; usando o padrão.');
  return DEFAULT_ICE_SERVERS;
}

/**
 * Lê a configuração do ambiente.
 *
 * ECHO_HOST            endereço de escuta (padrão 127.0.0.1; use 0.0.0.0 para a rede local)
 * ECHO_PORT            porta (padrão 3210; 0 escolhe uma porta livre; também aceita PORT)
 * ECHO_DATA_DIR        pasta do banco de dados
 * ECHO_DATABASE_URL    endereço de um Postgres (também aceita DATABASE_URL e POSTGRES_URL)
 * ECHO_SECURE_COOKIES  "1" quando o servidor fica atrás de HTTPS
 * ECHO_ICE_SERVERS     lista JSON de servidores STUN/TURN para as chamadas de voz
 * ECHO_TRUST_PROXY     "1" quando há um proxy na frente (para limitar tentativas pelo IP real)
 */
export function loadConfig(env = process.env) {
  // PORT é o nome que as hospedagens usam; ECHO_PORT tem preferência.
  const port = Number(env.ECHO_PORT ?? env.PORT ?? 3210);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Porta inválida: ${env.ECHO_PORT ?? env.PORT}`);
  }
  const dataDir = env.ECHO_DATA_DIR ?? path.join(PROJECT_ROOT, 'server', 'data');
  // Endereço de Postgres: o do Echo ou os nomes que as hospedagens costumam definir.
  const queryUrl = env.ECHO_DATABASE_URL ?? env.DATABASE_URL ?? env.POSTGRES_URL ?? null;
  return {
    /**
     * Na Vercel o disco some a cada reinício: sem Postgres o servidor perderia
     * as contas, então ele se recusa a rodar com o arquivo SQLite.
     */
    requirePostgres: env.VERCEL === '1' || env.ECHO_REQUIRE_POSTGRES === '1',
    /**
     * Com Postgres configurado, o servidor usa esse banco (e pode ter várias
     * instâncias); sem ele, usa o arquivo SQLite em `dbFile`. `listenUrl`
     * precisa ser uma conexão direta, sem pool.
     */
    postgres: queryUrl
      ? { queryUrl, listenUrl: env.ECHO_DATABASE_LISTEN_URL ?? env.DATABASE_URL_UNPOOLED ?? env.POSTGRES_URL_NON_POOLING ?? queryUrl }
      : null,
    host: env.ECHO_HOST ?? '127.0.0.1',
    port,
    dataDir,
    /** Arquivo do banco SQLite. */
    dbFile: path.join(dataDir, 'echo.sqlite'),
    webDir: path.join(PROJECT_ROOT, 'web'),
    secureCookies: env.ECHO_SECURE_COOKIES === '1',
    /** Atrás de um proxy (hospedagem com HTTPS), o IP de quem acessa vem no cabeçalho X-Forwarded-For. */
    trustProxy: env.ECHO_TRUST_PROXY === '1',
    sessionMaxAgeSeconds: 30 * 24 * 60 * 60,
    voice: {
      /** As chamadas são diretas entre os participantes; com muita gente a qualidade cai. */
      maxParticipants: 8,
      /**
       * Servidores que ajudam os navegadores a se encontrarem. O padrão é um
       * STUN público; ECHO_ICE_SERVERS (JSON) permite acrescentar um TURN,
       * que faz a chamada funcionar também em redes mais fechadas.
       */
      iceServers: parseIceServers(env.ECHO_ICE_SERVERS),
    },
    rateLimits: {
      // Cadastro e login, por endereço IP.
      auth: { limit: 20, windowMs: 5 * 60_000 },
      // Criar roda, entrar por convite e abrir canal, por conta.
      write: { limit: 30, windowMs: 60_000 },
      // Envio de mensagens, por conta.
      message: { limit: 10, windowMs: 5_000 },
    },
  };
}
