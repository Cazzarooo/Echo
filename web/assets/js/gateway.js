const MAX_DELAY_MS = 15_000;

/**
 * Conexão em tempo real com o servidor. Reconecta sozinha, com espera
 * crescente; quem usa só precisa reagir a onStatus ('connecting' | 'online' | 'offline').
 */
export function createGateway({ onEvent, onStatus }) {
  let socket = null;
  let attempt = 0;
  let retryTimer = null;
  let stopped = false;

  function connect() {
    if (stopped) return;
    onStatus('connecting');
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${scheme}://${location.host}/gateway`);

    socket.addEventListener('open', () => {
      attempt = 0;
      onStatus('online');
    });
    socket.addEventListener('message', (message) => {
      let event;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      onEvent(event);
    });
    socket.addEventListener('close', () => {
      socket = null;
      if (stopped) return;
      onStatus('offline');
      const delay = Math.min(MAX_DELAY_MS, 1000 * 2 ** attempt) + Math.random() * 400;
      attempt += 1;
      retryTimer = setTimeout(connect, delay);
    });
  }

  return {
    connect,
    send(event) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
    },
    close() {
      stopped = true;
      clearTimeout(retryTimer);
      socket?.close();
    },
  };
}
