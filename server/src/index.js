import http from 'node:http';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();

/** Hospedado sem banco: em vez de perder dados em silêncio, explica o que falta. */
function createSetupNotice() {
  const server = http.createServer((_req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('O Echo ainda não tem banco de dados. No painel da Vercel, adicione um Postgres ao projeto (aba Storage), conecte-o e publique de novo (Redeploy).');
  });
  return {
    listen: () => new Promise((resolve, reject) => server.once('error', reject).listen(config.port, config.host, () => resolve(server.address()))),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

let app;
try {
  const missingDatabase = config.requirePostgres && !config.postgres;
  if (missingDatabase) console.error('[echo] nenhum Postgres configurado (DATABASE_URL); servindo só o aviso de configuração.');
  app = missingDatabase ? createSetupNotice() : await createApp(config);
  const { port } = await app.listen();
  const shownHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  console.log(`[echo] servidor no ar: http://${shownHost}:${port}/app`);
} catch (error) {
  if (error.code === 'EADDRINUSE') {
    console.error(`[echo] a porta ${config.port} já está em uso. Defina ECHO_PORT para usar outra.`);
  } else {
    console.error('[echo] não foi possível iniciar o servidor:', error);
  }
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
