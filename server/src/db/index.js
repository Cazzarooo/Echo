import fs from 'node:fs';
import path from 'node:path';

export { isUniqueViolation } from './shared.js';

/**
 * Abre o banco conforme a configuração e devolve { db, driver }.
 *
 * Com endereço de Postgres (servidor hospedado) usa o Postgres; sem ele, um
 * arquivo SQLite local. `driver` só existe no Postgres e é por ele que as
 * instâncias do servidor trocam eventos (ver bus.js).
 */
export async function openDatabase(config) {
  if (config.postgres) {
    // Nos testes o driver já vem pronto (PGlite); em produção é o `pg`.
    const driver = config.postgres.driver ?? (await import('./pg-driver.js')).createPgDriver(config.postgres);
    const { openPostgresDatabase } = await import('./postgres.js');
    return { db: await openPostgresDatabase(driver), driver };
  }
  fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
  const { openSqliteDatabase } = await import('./sqlite.js');
  return { db: openSqliteDatabase(config.dbFile), driver: null };
}
