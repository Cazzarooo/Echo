// Canal por onde os avisos em tempo real chegam ao gateway.
//
// Com um servidor só (SQLite), é uma fila em memória. Hospedado, pode haver
// várias instâncias, cada uma com as suas conexões; aí o aviso passa pelo
// Postgres (NOTIFY/LISTEN) e toda instância o recebe, inclusive a que publicou.

const CHANNEL = 'echo_events';
/** O Postgres aceita até 8000 bytes por aviso; acima disso o conteúdo vai por uma tabela. */
const MAX_NOTIFY_BYTES = 7000;
const PAYLOAD_TTL_MS = 60_000;

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
      await driver.listen(CHANNEL, async (payload) => {
        try {
          let envelope = JSON.parse(payload);
          if (envelope.ref !== undefined) {
            const [row] = await driver.query('SELECT body FROM bus_payloads WHERE id = $1', [envelope.ref]);
            if (!row) return;
            envelope = JSON.parse(row.body);
          }
          handler(envelope);
        } catch (error) {
          console.error('[echo] aviso entre instâncias ilegível:', error.message);
        }
      });
    },
    async publish(envelope) {
      const body = JSON.stringify(envelope);
      if (Buffer.byteLength(body) <= MAX_NOTIFY_BYTES) {
        await driver.query('SELECT pg_notify($1, $2)', [CHANNEL, body]);
        return;
      }
      // Grande demais (por exemplo a negociação de uma chamada de vídeo): guarda
      // o conteúdo e avisa só a referência. As sobras antigas saem na mesma viagem.
      const now = Date.now();
      await driver.query('DELETE FROM bus_payloads WHERE created_at < $1', [now - PAYLOAD_TTL_MS]);
      const [{ id }] = await driver.query('INSERT INTO bus_payloads (body, created_at) VALUES ($1, $2) RETURNING id', [body, now]);
      await driver.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify({ ref: id })]);
    },
  };
}
