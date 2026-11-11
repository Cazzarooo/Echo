import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await createApp(config);

try {
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
