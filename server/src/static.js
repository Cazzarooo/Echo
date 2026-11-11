import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function contentSecurityPolicy(host) {
  // O Host entra na política só se tiver cara de host: ele vem do cliente.
  const safeHost = /^[A-Za-z0-9.\-:[\]]+$/.test(host ?? '') ? host : null;
  const connect = safeHost ? `'self' ws://${safeHost} wss://${safeHost}` : "'self'";
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    `connect-src ${connect}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function resolveFile(pathname, webDir) {
  if (pathname === '/app' || pathname === '/app/') return path.join(webDir, 'index.html');
  if (!pathname.startsWith('/app/assets/')) return null;

  let relative;
  try {
    relative = decodeURIComponent(pathname.slice('/app/assets/'.length));
  } catch {
    return null;
  }
  if (relative.includes('\0')) return null;
  const assetsDir = path.join(webDir, 'assets');
  const file = path.resolve(assetsDir, relative);
  // Nada de "../": o arquivo tem de ficar dentro de web/assets.
  return file.startsWith(assetsDir + path.sep) ? file : null;
}

/** Entrega a interface web (/app e /app/assets/...). Devolve false se o caminho não é dela. */
export async function serveWebApp(req, res, pathname, webDir) {
  const file = resolveFile(pathname, webDir);
  const type = file ? CONTENT_TYPES[path.extname(file).toLowerCase()] : null;
  if (!type) return false;

  let stat;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag };
  if (type.startsWith('text/html')) headers['Content-Security-Policy'] = contentSecurityPolicy(req.headers.host);

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  await pipeline(fs.createReadStream(file), res);
  return true;
}
