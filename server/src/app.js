import http from 'node:http';
import { createLocalBus, createPostgresBus } from './bus.js';
import { openDatabase } from './db/index.js';
import { createHub } from './hub.js';
import { HttpError, sendJson } from './http-util.js';
import { buildApi } from './routes.js';
import { serveWebApp } from './static.js';

const SESSION_SWEEP_MS = 60 * 60 * 1000;

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

/**
 * Monta o servidor inteiro: banco, API em /api, gateway em /gateway e a
 * interface web em /app. Nada escuta a rede até chamar listen(); numa
 * hospedagem serverless, quem atende é o `server` devolvido aqui.
 */
export async function createApp(config) {
  const { db, driver } = await openDatabase(config);
  const hub = createHub({ db, bus: driver ? createPostgresBus(driver) : createLocalBus(), config });
  await hub.start();
  const api = buildApi({ db, hub, config });

  async function handle(req, res) {
    applySecurityHeaders(res);
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      throw new HttpError(400, 'bad_request', 'Requisição inválida.');
    }

    if (url.pathname.startsWith('/api/')) return api.handle(req, res, url);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new HttpError(405, 'method_not_allowed', 'Método não permitido.');
    }
    if (url.pathname === '/') {
      res.writeHead(302, { Location: '/app' });
      res.end();
      return;
    }
    if (await serveWebApp(req, res, url.pathname, config.webDir)) return;
    throw new HttpError(404, 'not_found', 'Página não encontrada.');
  }

  function fail(req, res, error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error instanceof HttpError) {
      const body = { error: { code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) } };
      sendJson(res, error.status, body, error.headers);
      return;
    }
    console.error(`[echo] erro em ${req.method} ${req.url}:`, error);
    sendJson(res, 500, { error: { code: 'internal', message: 'Erro interno do servidor.' } });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => fail(req, res, error));
  });
  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));

  const sessionSweep = setInterval(() => {
    db.deleteExpiredSessions().catch((error) => console.error('[echo] limpeza de sessões falhou:', error.message));
  }, SESSION_SWEEP_MS);
  sessionSweep.unref();

  return {
    server,
    db,
    hub,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      });
    },
    async close() {
      clearInterval(sessionSweep);
      api.stop();
      await hub.close();
      if (server.listening) {
        await new Promise((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
      await db.close();
    },
  };
}
