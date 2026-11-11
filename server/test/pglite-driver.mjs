// Driver de Postgres para os testes: o PGlite é um Postgres de verdade rodando
// dentro do próprio processo, então o código de db/postgres.js e o canal de
// eventos (LISTEN/NOTIFY) são exercitados sem precisar de um servidor de banco.
import { PGlite } from '@electric-sql/pglite';

export async function createPgliteDriver() {
  const db = await PGlite.create();
  return {
    async query(sql, params) {
      return (await db.query(sql, params)).rows;
    },
    transaction: (work) =>
      db.transaction((tx) =>
        work(
          async (sql, params) => (await tx.query(sql, params)).rows,
          (sql) => tx.exec(sql),
        ),
      ),
    async listen(channel, handler) {
      await db.listen(channel, handler);
    },
    close: () => db.close(),
  };
}
