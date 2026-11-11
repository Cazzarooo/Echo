import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Raiz do projeto: a pasta que contém server/, web/ e desktop/. */
export const PROJECT_ROOT = path.resolve(here, '..', '..');

export const SERVER_NAME = 'echo';
export const SERVER_VERSION = '0.1.0';

/**
 * Lê a configuração do ambiente.
 *
 * ECHO_HOST            endereço de escuta (padrão 127.0.0.1; use 0.0.0.0 para a rede local)
 * ECHO_PORT            porta (padrão 3210; 0 escolhe uma porta livre)
 * ECHO_DATA_DIR        pasta do banco de dados
 * ECHO_SECURE_COOKIES  "1" quando o servidor fica atrás de HTTPS
 * ECHO_TRUST_PROXY     "1" quando há um proxy na frente (para limitar tentativas pelo IP real)
 */
export function loadConfig(env = process.env) {
  const port = Number(env.ECHO_PORT ?? 3210);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`ECHO_PORT inválida: ${env.ECHO_PORT}`);
  }
  const dataDir = env.ECHO_DATA_DIR ?? path.join(PROJECT_ROOT, 'server', 'data');
  return {
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
