// Entrada do Echo na Vercel. O vercel.json manda todas as rotas para cá, e a
// Vercel usa o servidor HTTP exportado para atender tanto as páginas e a API
// quanto as conexões WebSocket do gateway.
//
// A Vercel não tem disco permanente, então aqui o banco tem de ser um Postgres
// (a integração de banco do Marketplace define DATABASE_URL sozinha).

import http from 'node:http';
import { createApp } from '../server/src/app.js';
import { loadConfig } from '../server/src/config.js';

// Na Vercel há sempre HTTPS e um proxy na frente.
const config = loadConfig({ ECHO_SECURE_COOKIES: '1', ECHO_TRUST_PROXY: '1', ...process.env });

let server;
if (config.postgres) {
  server = (await createApp(config)).server;
} else {
  // Sem banco configurado, explica o que falta em vez de falhar de forma obscura.
  server = http.createServer((_req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('O Echo ainda não tem banco de dados. No painel da Vercel, adicione um Postgres ao projeto (Storage) e publique de novo.');
  });
}

export default server;
