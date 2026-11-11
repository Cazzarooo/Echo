import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// Parâmetros do scrypt. Ficam gravados junto do hash, então dá para endurecer
// depois sem invalidar as senhas antigas.
const SCRYPT = { N: 32768, r: 8, p: 1 };
const KEY_LENGTH = 64;
const maxmemFor = ({ N, r }) => 128 * N * r * 2;

export const SESSION_COOKIE = 'echo_session';

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH, { ...SCRYPT, maxmem: maxmemFor(SCRYPT) });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, key] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const params = { N: Number(N), r: Number(r), p: Number(p) };
  const expected = Buffer.from(key, 'base64');
  const actual = await scryptAsync(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, {
    ...params,
    maxmem: maxmemFor(params),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** O token vai para o cookie; no banco fica só o hash dele. */
export function newSessionToken() {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

// Sem 0/O, 1/I/L: o código de convite é lido e digitado por gente.
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newInviteCode(length = 8) {
  let code = '';
  for (let i = 0; i < length; i++) code += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  return code;
}

export function parseCookies(header) {
  const cookies = new Map();
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (name && !cookies.has(name)) cookies.set(name, part.slice(index + 1).trim());
  }
  return cookies;
}

export function sessionCookie(token, { maxAgeSeconds, secure }) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Lê o token de sessão de uma requisição HTTP (ou do pedido de upgrade do WebSocket). */
export function sessionTokenFrom(req) {
  return parseCookies(req.headers.cookie).get(SESSION_COOKIE) ?? null;
}
