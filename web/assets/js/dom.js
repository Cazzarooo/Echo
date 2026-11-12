// Ajudantes de DOM. Nada aqui usa innerHTML: texto de usuário entra sempre como texto.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Cria um elemento: h('button', { class: 'x', onclick: fn }, 'texto', outroElemento). */
export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined) continue;
    if (key === 'class') element.className = value;
    else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2), value);
    else if (key.startsWith('aria-') || key.startsWith('data-') || key === 'role' || key === 'spellcheck') {
      element.setAttribute(key, String(value));
    } else element[key] = value;
  }
  element.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}

export function clear(element) {
  element.replaceChildren();
  return element;
}

const ICON_PATHS = {
  hash: ['M5 9h15', 'M4 15h15', 'M10 4 8 20', 'M16 4l-2 16'],
  plus: ['M12 5v14', 'M5 12h14'],
  chevron: ['m6 9 6 6 6-6'],
  send: ['M4.5 11.5 20 4l-6.5 16-2.8-6.7z', 'm10.7 13.3 4-4'],
  people: ['M3 20v-1.5A4.5 4.5 0 0 1 7.5 14h3a4.5 4.5 0 0 1 4.5 4.5V20', 'M9 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M16 4a3.5 3.5 0 0 1 0 6.4', 'M18 14.3a4.5 4.5 0 0 1 3 4.2V20'],
  invite: ['M2.5 20v-1.5A4.5 4.5 0 0 1 7 14h3.5a4.5 4.5 0 0 1 4.5 4.5V20', 'M8.8 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M19 8v6', 'M16 11h6'],
  leave: ['M9.5 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3.5', 'm15 16 4-4-4-4', 'M19 12H9.5'],
  copy: ['M9 9h10v11H9z', 'M15 9V5H5v11h4'],
  sliders: ['M4 7h8', 'M18 7h2', 'M12 7a3 3 0 1 0 6 0 3 3 0 0 0-6 0z', 'M4 17h2', 'M12 17h8', 'M6 17a3 3 0 1 0 6 0 3 3 0 0 0-6 0z'],
  check: ['m5 12.5 4.5 4.5L19 7.5'],
  pencil: ['M4 20h4L19 9l-4-4L4 16z', 'm13.5 6.5 4 4'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13', 'M10 11v5', 'M14 11v5'],
  mic: ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M6 11a6 6 0 0 0 12 0', 'M12 17v4'],
  micOff: ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M6 11a6 6 0 0 0 12 0', 'M12 17v4', 'M4 4l16 16'],
  camera: ['M4 7h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z', 'm16 11 6-3v8l-6-3'],
  cameraOff: ['M4 7h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z', 'm16 11 6-3v8l-6-3', 'M3 4l17 17'],
  screen: ['M3 5h18v11H3z', 'M8 20h8', 'M12 16v4'],
  hangup: ['M3 13.5c5-5 13-5 18 0l-2.4 2.4-3.6-1.6v-2.4a10 10 0 0 0-6 0v2.4l-3.6 1.6z'],
  speaker: ['M4 10v4h3l5 4V6l-5 4z', 'M16 9a4 4 0 0 1 0 6', 'M18.5 6.5a8 8 0 0 1 0 11'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  down: ['M12 5v14', 'm6 13 6 6 6-6'],
  ticket: ['M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z', 'M14 6v12'],
};

export function icon(name, size = 18) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  for (const d of ICON_PATHS[name] ?? []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

export function avatar(person, small = false) {
  const element = h('span', { class: small ? 'avatar avatar--small' : 'avatar', 'aria-hidden': 'true' }, initials(person.displayName));
  // Cada pessoa ganha uma cor estável; o ângulo áureo espalha bem os matizes vizinhos.
  element.style.setProperty('--hue', String(Math.round((person.id * 137.508) % 360)));
  return element;
}

function initials(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : [words[0] ?? '?'];
  return letters.map((word) => [...word][0]).join('').toUpperCase();
}

export function toast(message, kind = 'info') {
  const host = document.getElementById('toasts');
  const element = h('div', { class: kind === 'error' ? 'toast toast--error' : 'toast' }, message);
  host.append(element);
  setTimeout(() => element.remove(), 4500);
}
