// Roda a mesma bateria de api.test.mjs, mas com o banco Postgres (o do servidor
// hospedado) no lugar do SQLite.
process.env.ECHO_TEST_POSTGRES = '1';
await import('./api.test.mjs');
