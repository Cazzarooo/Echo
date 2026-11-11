/** Erro com status HTTP; a mensagem é mostrada para a pessoa, então fica em português. */
export class HttpError extends Error {
  constructor(status, code, message, { headers = {}, field = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
    /** Campo do formulário que causou o erro, quando há um. */
    this.field = field;
  }
}

/**
 * Navegadores mandam Origin em POST e no handshake do WebSocket; se veio, tem
 * de ser o próprio servidor. Clientes que não são navegador não mandam nada.
 */
export function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export async function readJsonBody(req, maxBytes = 64 * 1024) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    throw new HttpError(415, 'unsupported_media_type', 'Envie os dados como JSON.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new HttpError(413, 'payload_too_large', 'O conteúdo enviado é grande demais.', { headers: { Connection: 'close' } });
    }
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'JSON inválido.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'invalid_json', 'O corpo da requisição precisa ser um objeto JSON.');
  }
  return value;
}

export function sendJson(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

/** Roteador mínimo: caminhos fixos com parâmetros numéricos, como /api/channels/:id/messages. */
export function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    const keys = [];
    const source = pattern.replace(/:([a-zA-Z]+)/g, (_, key) => {
      keys.push(key);
      return '(\\d{1,15})';
    });
    routes.push({ method, regex: new RegExp(`^${source}$`), keys, handler });
  }

  function match(method, pathname) {
    let pathExists = false;
    for (const route of routes) {
      const found = route.regex.exec(pathname);
      if (!found) continue;
      pathExists = true;
      if (route.method !== method) continue;
      const params = {};
      route.keys.forEach((key, index) => {
        params[key] = Number(found[index + 1]);
      });
      return { handler: route.handler, params };
    }
    return pathExists ? { methodNotAllowed: true } : null;
  }

  return {
    get: (pattern, handler) => add('GET', pattern, handler),
    post: (pattern, handler) => add('POST', pattern, handler),
    match,
  };
}

/** Janela fixa por chave (IP ou usuário). Suficiente para frear força bruta e flood. */
export function createRateLimiter({ limit, windowMs }) {
  const windows = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of windows) if (entry.resetAt <= now) windows.delete(key);
  }, windowMs);
  sweep.unref();

  return {
    /** Consome uma tentativa; devolve 0 se pode seguir ou os segundos até liberar. */
    take(key) {
      const now = Date.now();
      let entry = windows.get(key);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs };
        windows.set(key, entry);
      }
      entry.count += 1;
      return entry.count <= limit ? 0 : Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    },
    stop: () => clearInterval(sweep),
  };
}
