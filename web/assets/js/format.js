const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

export const formatTime = (timestamp) => timeFormat.format(timestamp);

export function dayKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function formatDay(timestamp) {
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey(timestamp) === dayKey(today)) return 'Hoje';
  if (dayKey(timestamp) === dayKey(yesterday)) return 'Ontem';
  const text = dayFormat.format(timestamp);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

/**
 * Transforma o texto de uma mensagem em nós de DOM: texto puro, com os
 * endereços http(s) virando links. Nunca interpreta HTML.
 */
export function renderContent(text) {
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const candidate = match[0].replace(TRAILING_PUNCTUATION, '');
    let url;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;

    fragment.append(text.slice(cursor, match.index));
    const link = document.createElement('a');
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = candidate;
    fragment.append(link);
    cursor = match.index + candidate.length;
  }
  fragment.append(text.slice(cursor));
  return fragment;
}

/** "Ana", "Ana e Beto", "Ana, Beto e mais 2". */
export function joinNames(names) {
  if (names.length <= 2) return names.join(' e ');
  return `${names[0]}, ${names[1]} e mais ${names.length - 2}`;
}
