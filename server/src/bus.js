// Canal por onde os avisos em tempo real chegam ao gateway.
//
// Com um servidor só (SQLite), é uma fila em memória. Hospedado, pode haver
// várias instâncias, cada uma com as suas conexões; aí o aviso passa pelo
// Postgres (NOTIFY/LISTEN) e toda instância o recebe, inclusive a que publicou.

const CHANNEL = 'echo_events';
/** O Postgres aceita até 8000 bytes por aviso. */
export const MAX_ENVELOPE_BYTES = 7000;

export function createLocalBus() {
  const handlers = new Set();
  return {
    async subscribe(handler) {
      handlers.add(handler);
    },
    async publish(envelope) {
      // Passa por JSON como passaria pelo banco, para os dois modos se comportarem igual.
      const copy = JSON.parse(JSON.stringify(envelope));
      queueMicrotask(() => {
        for (const handler of handlers) handler(copy);
      });
    },
  };
}

export function createPostgresBus(driver) {
  return {
    async subscribe(handler) {
      await driver.listen(CHANNEL, (payload) => {
        let envelope;
        try {
          envelope = JSON.parse(payload);
        } catch {
          return;
        }
        handler(envelope);
      });
    },
    async publish(envelope) {
      await driver.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify(envelope)]);
    },
  };
}
