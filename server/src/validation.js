import { HttpError } from './http-util.js';

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

function invalid(field, message) {
  return new HttpError(422, 'invalid_field', message, { field });
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

export function parseUsername(value) {
  const username = text(value).trim().toLowerCase();
  if (!/^[a-z0-9_.]{3,24}$/.test(username)) {
    throw invalid('username', 'O nome de usuário precisa ter de 3 a 24 caracteres: letras sem acento, números, ponto ou sublinhado.');
  }
  return username;
}

export function parseDisplayName(value) {
  const name = text(value).trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 32 || CONTROL_CHARS.test(name)) {
    throw invalid('displayName', 'O nome de exibição precisa ter de 1 a 32 caracteres.');
  }
  return name;
}

export function parsePassword(value) {
  const password = text(value);
  if (password.length < 8 || password.length > 200) {
    throw invalid('password', 'A senha precisa ter pelo menos 8 caracteres.');
  }
  return password;
}

export function parseSpaceName(value) {
  const name = text(value).trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 40 || CONTROL_CHARS.test(name)) {
    throw invalid('name', 'O nome da roda precisa ter de 2 a 40 caracteres.');
  }
  return name;
}

/** "Reuniões de Sexta" vira "reuniões-de-sexta". */
export function parseChannelName(value) {
  const name = text(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (name.length < 1 || name.length > 32) {
    throw invalid('name', 'O nome do canal precisa ter de 1 a 32 caracteres: letras, números, hífen ou sublinhado.');
  }
  return name;
}

export const MESSAGE_MAX_LENGTH = 4000;

export function parseMessageContent(value) {
  const content = text(value).replace(/\r\n?/g, '\n').trimEnd();
  if (content.trim().length === 0) throw invalid('content', 'A mensagem está vazia.');
  if (content.length > MESSAGE_MAX_LENGTH) {
    throw invalid('content', `A mensagem passou do limite de ${MESSAGE_MAX_LENGTH} caracteres.`);
  }
  return content;
}

export function parseInviteCode(value) {
  const code = text(value).trim().toUpperCase();
  if (!/^[A-Z0-9]{6,16}$/.test(code)) throw invalid('code', 'Esse código de convite não parece válido.');
  return code;
}

export function parsePositiveInt(value, field) {
  const number = typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number <= 0) throw invalid(field, `Valor inválido em "${field}".`);
  return number;
}
