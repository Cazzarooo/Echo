const { app, utilityProcess } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Servidor Echo embutido: o mesmo código de server/, rodando num processo
 * auxiliar do aplicativo. É o que faz o Echo instalado funcionar sozinho, sem
 * ninguém precisar subir um servidor à parte. Escuta só em 127.0.0.1 e guarda
 * o banco na pasta de dados do usuário.
 */
function createLocalServer() {
  let child = null;

  // Instalado, o servidor fica ao lado do aplicativo (resources/server); em
  // desenvolvimento, na pasta do projeto.
  function entryFile() {
    const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..', '..');
    const entry = path.join(base, 'server', 'src', 'index.js');
    return fs.existsSync(entry) ? entry : null;
  }

  return {
    /** ECHO_NO_LOCAL_SERVER=1 desliga o servidor embutido (a casca só se conecta a um que já exista). */
    isAvailable: () => process.env.ECHO_NO_LOCAL_SERVER !== '1' && entryFile() !== null,
    isRunning: () => child !== null,

    start(port) {
      if (child) return;
      const started = utilityProcess.fork(entryFile(), [], {
        serviceName: 'Servidor local do Echo',
        stdio: 'pipe',
        env: {
          ...process.env,
          ECHO_HOST: '127.0.0.1',
          ECHO_PORT: String(port),
          ECHO_DATA_DIR: path.join(app.getPath('userData'), 'servidor'),
        },
      });
      child = started;
      started.stdout?.on('data', (chunk) => process.stdout.write(chunk));
      started.stderr?.on('data', (chunk) => process.stderr.write(chunk));
      started.once('exit', () => {
        if (child === started) child = null;
      });
    },

    stop() {
      child?.kill();
      child = null;
    },
  };
}

module.exports = { createLocalServer };
