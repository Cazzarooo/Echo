// Gera os ícones PNG da casca desktop a partir da mesma forma do web/assets/icon.svg.
// Sem dependências: desenha por amostragem e escreve o PNG na mão.
// Rode com `npm run icons` depois de mudar o desenho ou as cores.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'assets');
const DEEP = [0x0b, 0x13, 0x2b]; // petróleo profundo: fundo do ícone e os traços
const CYAN = [0x00, 0xe5, 0xff]; // ciano: o balão
const ICE = [0xf0, 0xf4, 0xf8];
const SAMPLES = 4; // amostras por eixo em cada pixel (suaviza as bordas)

// --- formas, num quadro de 64 x 64 -------------------------------------------

function inRoundRect(x, y, left, top, right, bottom, radius) {
  const dx = Math.max(left + radius - x, 0, x - (right - radius));
  const dy = Math.max(top + radius - y, 0, y - (bottom - radius));
  return x >= left && x <= right && y >= top && y <= bottom && dx * dx + dy * dy <= radius * radius;
}

function inTriangle(x, y, [ax, ay], [bx, by], [cx, cy]) {
  const side = (px, py, qx, qy) => (x - qx) * (py - qy) - (px - qx) * (y - qy);
  const d1 = side(ax, ay, bx, by);
  const d2 = side(bx, by, cx, cy);
  const d3 = side(cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** Cor (ou null, transparente) do logotipo no ponto (x, y). */
function logoAt(x, y) {
  if (!inRoundRect(x, y, 0, 0, 64, 64, 15)) return null;
  const inLines = inRoundRect(x, y, 20, 24.5, 44, 28.1, 1.8) || inRoundRect(x, y, 20, 32, 36, 35.6, 1.8);
  const inBubble = inRoundRect(x, y, 13, 17, 51, 43, 8) || inTriangle(x, y, [20, 42], [31, 42], [20, 53]);
  return inBubble && !inLines ? CYAN : DEEP;
}

/** Bolinha de "tem mensagem nova" para a barra de tarefas. */
function badgeAt(x, y) {
  const distance = Math.hypot(x - 32, y - 32);
  if (distance > 30) return null;
  return distance > 24 ? ICE : CYAN;
}

// --- rasterização e PNG ------------------------------------------------------

function render(size, colorAt) {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = 64 / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const color = colorAt((px + (sx + 0.5) / SAMPLES) * scale, (py + (sy + 0.5) / SAMPLES) * scale);
          if (!color) continue;
          red += color[0];
          green += color[1];
          blue += color[2];
          covered += 1;
        }
      }
      const offset = (py * size + px) * 4;
      if (covered > 0) {
        pixels[offset] = Math.round(red / covered);
        pixels[offset + 1] = Math.round(green / covered);
        pixels[offset + 2] = Math.round(blue / covered);
        pixels[offset + 3] = Math.round((covered / (SAMPLES * SAMPLES)) * 255);
      }
    }
  }
  return pixels;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8 bits por canal, RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); // byte 0 da linha = filtro "nenhum"
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const files = [
  ['icon.png', 256, logoAt],
  ['tray.png', 16, logoAt],
  ['tray@2x.png', 32, logoAt],
  ['tray@3x.png', 48, logoAt],
  ['badge.png', 16, badgeAt],
  ['badge@2x.png', 32, badgeAt],
];
for (const [name, size, colorAt] of files) {
  fs.writeFileSync(path.join(OUT_DIR, name), encodePng(size, render(size, colorAt)));
  console.log(`[icons] ${name} (${size}x${size})`);
}
