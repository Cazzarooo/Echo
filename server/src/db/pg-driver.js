import pg from 'pg';

const RECONNECT_MS = 2_000;

/**
 * Driver do Postgres de verdade (pacote `pg`).
 *
 * `queryUrl` pode ser um endereço com pool de conexões (pgbouncer); `listenUrl`
 * tem de ser uma conexão direta, porque LISTEN não funciona através de pool em
 * modo de transação. As hospedagens costumam fornecer os dois.
 */
export function createPgDriver({ queryUrl, listenUrl }) {
  // Poucas conexões por instância: numa hospedagem serverless há várias instâncias dividindo o banco.
  const pool = new pg.Pool({ connectionString: queryUrl, max: 3, idleTimeoutMillis: 20_000 });
  pool.on('error', (error) => console.error('[echo] conexão ociosa com o banco caiu:', error.message));

  const listeners = new Map(); // canal -> função
  let listenClient = null;
  let closed = false;

  // A conexão de escuta é uma só e fica aberta; se cair, reconecta e volta a escutar.
  async function connectListener() {
    if (closed || listeners.size === 0) return;
    const client = new pg.Client({ connectionString: listenUrl });
    const retry = () => {
      if (listenClient !== client) return;
      listenClient = null;
      if (!closed) setTimeout(() => connectListener().catch(() => {}), RECONNECT_MS).unref();
    };
    client.on('error', retry);
    client.on('end', retry);
    client.on('notification', (message) => listeners.get(message.channel)?.(message.payload ?? ''));
    listenClient = client;
    try {
      await client.connect();
      for (const channel of listeners.keys()) await client.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
    } catch (error) {
      console.error('[echo] não foi possível escutar eventos do banco:', error.message);
      client.end().catch(() => {});
      retry();
    }
  }

  return {
    async query(sql, params) {
      return (await pool.query(sql, params)).rows;
    },

    async transaction(work) {
      const client = await pool.connect();
      const query = async (sql, params) => (await client.query(sql, params)).rows;
      try {
        await client.query('BEGIN');
        const result = await work(query, (sql) => client.query(sql));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async listen(channel, handler) {
      listeners.set(channel, handler);
      if (listenClient) await listenClient.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
      else await connectListener();
    },

    async close() {
      closed = true;
      await listenClient?.end().catch(() => {});
      await pool.end();
    },
  };
}
