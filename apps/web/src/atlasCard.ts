/**
 * Deterministic Open Graph card for a public atlas (CLA-39).
 *
 * Node-only (PNG via `node:zlib`). Do not import this module from the browser
 * bundle — the share HTML and `/og/` handlers run on Vite / Vercel, not in React.
 *
 * The card is owner/repo + a generated map preview, not a site logo. Bytes are a
 * pure function of owner/repo; no env, tokens, paths, or scan objects.
 */
import { deflateSync } from 'node:zlib';

export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

const BG = [7, 10, 11, 255] as const;
const PANEL = [13, 18, 19, 255] as const;
const TEXT = [241, 247, 244, 255] as const;
const MUTED = [151, 165, 160, 255] as const;
const ACCENT = [217, 255, 112, 255] as const;
const CYAN = [121, 223, 212, 255] as const;
const BLUE = [124, 169, 255, 255] as const;
const PURPLE = [185, 161, 255, 255] as const;
const LINE = [40, 52, 50, 255] as const;

type Rgba = readonly [number, number, number, number];

/** 5×7 glyphs for GitHub-legal names plus a few labels. Rows are 5-bit masks. */
const GLYPHS: Record<string, readonly number[]> = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '-': [0, 0, 0, 0x1f, 0, 0, 0],
  '.': [0, 0, 0, 0, 0, 0, 0x04],
  '/': [0x02, 0x02, 0x04, 0x04, 0x08, 0x08, 0x10],
  0: [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  1: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  2: [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f],
  3: [0x1e, 0x01, 0x01, 0x0e, 0x01, 0x01, 0x1e],
  4: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  5: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  6: [0x0e, 0x10, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  7: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  8: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  9: [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x01, 0x0e],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0e],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x01, 0x01, 0x01, 0x01, 0x11, 0x11, 0x0e],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0e, 0x11, 0x10, 0x0e, 0x01, 0x11, 0x0e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  _: [0, 0, 0, 0, 0, 0, 0x1f],
  a: [0, 0, 0x0e, 0x01, 0x0f, 0x11, 0x0f],
  b: [0x10, 0x10, 0x1e, 0x11, 0x11, 0x11, 0x1e],
  c: [0, 0, 0x0e, 0x11, 0x10, 0x11, 0x0e],
  d: [0x01, 0x01, 0x0f, 0x11, 0x11, 0x11, 0x0f],
  e: [0, 0, 0x0e, 0x11, 0x1f, 0x10, 0x0e],
  f: [0x06, 0x08, 0x08, 0x1e, 0x08, 0x08, 0x08],
  g: [0, 0, 0x0f, 0x11, 0x0f, 0x01, 0x0e],
  h: [0x10, 0x10, 0x1e, 0x11, 0x11, 0x11, 0x11],
  i: [0x04, 0, 0x0c, 0x04, 0x04, 0x04, 0x0e],
  j: [0x02, 0, 0x06, 0x02, 0x02, 0x12, 0x0c],
  k: [0x10, 0x10, 0x12, 0x14, 0x18, 0x14, 0x12],
  l: [0x0c, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  m: [0, 0, 0x1a, 0x15, 0x15, 0x15, 0x15],
  n: [0, 0, 0x1e, 0x11, 0x11, 0x11, 0x11],
  o: [0, 0, 0x0e, 0x11, 0x11, 0x11, 0x0e],
  p: [0, 0, 0x1e, 0x11, 0x1e, 0x10, 0x10],
  q: [0, 0, 0x0f, 0x11, 0x0f, 0x01, 0x01],
  r: [0, 0, 0x16, 0x19, 0x10, 0x10, 0x10],
  s: [0, 0, 0x0f, 0x10, 0x0e, 0x01, 0x1e],
  t: [0x08, 0x08, 0x1e, 0x08, 0x08, 0x08, 0x06],
  u: [0, 0, 0x11, 0x11, 0x11, 0x13, 0x0d],
  v: [0, 0, 0x11, 0x11, 0x11, 0x0a, 0x04],
  w: [0, 0, 0x11, 0x11, 0x15, 0x15, 0x0a],
  x: [0, 0, 0x11, 0x0a, 0x04, 0x0a, 0x11],
  y: [0, 0, 0x11, 0x11, 0x0f, 0x01, 0x0e],
  z: [0, 0, 0x1f, 0x02, 0x04, 0x08, 0x1f],
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u32(value: number): Uint8Array {
  return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(8 + data.length + 4);
  header.set(u32(data.length), 0);
  header[4] = type.charCodeAt(0);
  header[5] = type.charCodeAt(1);
  header[6] = type.charCodeAt(2);
  header[7] = type.charCodeAt(3);
  header.set(data, 8);
  const crcInput = header.subarray(4, 8 + data.length);
  header.set(u32(crc32(crcInput)), 8 + data.length);
  return header;
}

function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = width * 4;
  const filtered = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + stride);
    filtered[row] = 0;
    filtered.set(rgba.subarray(y * stride, (y + 1) * stride), row + 1);
  }
  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width), 0);
  ihdr.set(u32(height), 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = deflateSync(Buffer.from(filtered), { level: 9 });
  const signature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  const parts = [signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

function hash32(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fillRect(
  rgba: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: Rgba,
): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(width, Math.ceil(x + w));
  const y1 = Math.min(height, Math.ceil(y + h));
  for (let py = y0; py < y1; py += 1) {
    let i = (py * width + x0) * 4;
    for (let px = x0; px < x1; px += 1) {
      rgba[i] = color[0];
      rgba[i + 1] = color[1];
      rgba[i + 2] = color[2];
      rgba[i + 3] = color[3];
      i += 4;
    }
  }
}

function fillRoundRect(
  rgba: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  color: Rgba,
): void {
  const r = Math.max(0, Math.min(radius, Math.floor(Math.min(w, h) / 2)));
  fillRect(rgba, width, height, x + r, y, w - 2 * r, h, color);
  fillRect(rgba, width, height, x, y + r, w, h - 2 * r, color);
  const r2 = r * r;
  for (let dy = 0; dy < r; dy += 1) {
    for (let dx = 0; dx < r; dx += 1) {
      if ((dx - r + 0.5) ** 2 + (dy - r + 0.5) ** 2 <= r2) {
        fillRect(rgba, width, height, x + dx, y + dy, 1, 1, color);
        fillRect(rgba, width, height, x + w - 1 - dx, y + dy, 1, 1, color);
        fillRect(rgba, width, height, x + dx, y + h - 1 - dy, 1, 1, color);
        fillRect(rgba, width, height, x + w - 1 - dx, y + h - 1 - dy, 1, 1, color);
      }
    }
  }
}

function drawLine(
  rgba: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: Rgba,
  thickness: number,
): void {
  const steps = Math.max(1, Math.hypot(x1 - x0, y1 - y0));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    fillRect(rgba, width, height, x0 + (x1 - x0) * t - thickness / 2, y0 + (y1 - y0) * t - thickness / 2, thickness, thickness, color);
  }
}

function glyphFor(ch: string): readonly number[] {
  return GLYPHS[ch] ?? GLYPHS[ch.toUpperCase()] ?? GLYPHS['-']!;
}

function drawText(
  rgba: Uint8Array,
  width: number,
  height: number,
  text: string,
  x: number,
  y: number,
  scale: number,
  color: Rgba,
): void {
  let cx = x;
  for (const ch of text) {
    const glyph = glyphFor(ch);
    for (let row = 0; row < 7; row += 1) {
      const bits = glyph[row]!;
      for (let col = 0; col < 5; col += 1) {
        if (bits & (1 << (4 - col))) {
          fillRect(rgba, width, height, cx + col * scale, y + row * scale, scale, scale, color);
        }
      }
    }
    cx += 6 * scale;
  }
}

const NODE_COLORS: readonly Rgba[] = [CYAN, BLUE, PURPLE, ACCENT];

function drawMapPreview(
  rgba: Uint8Array,
  width: number,
  height: number,
  owner: string,
  repo: string,
): void {
  const boardX = 640;
  const boardY = 88;
  const boardW = 496;
  const boardH = 454;
  fillRoundRect(rgba, width, height, boardX, boardY, boardW, boardH, 24, PANEL);
  fillRect(rgba, width, height, boardX, boardY, boardW, 4, ACCENT);

  const rng = mulberry32(hash32(`${owner}/${repo}`));
  const nodes = 8;
  const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
  const inset = 36;
  for (let i = 0; i < nodes; i += 1) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const w = 96 + Math.floor(rng() * 36);
    const h = 42 + Math.floor(rng() * 18);
    const x = boardX + inset + col * 148 + Math.floor(rng() * 18);
    const y = boardY + inset + 28 + row * 120 + Math.floor(rng() * 22);
    placed.push({ x, y, w, h });
  }
  for (let i = 1; i < placed.length; i += 1) {
    const from = placed[i - 1]!;
    const to = placed[i]!;
    drawLine(
      rgba,
      width,
      height,
      from.x + from.w / 2,
      from.y + from.h / 2,
      to.x + to.w / 2,
      to.y + to.h / 2,
      LINE,
      3,
    );
  }
  placed.forEach((node, i) => {
    fillRoundRect(rgba, width, height, node.x, node.y, node.w, node.h, 10, NODE_COLORS[i % NODE_COLORS.length]!);
  });
}

export type AtlasCardInput = {
  owner: string;
  repo: string;
};

/**
 * Pixel layout used by the PNG encoder. Exported so tests can assert the card
 * carries owner/repo rather than only a generic mark.
 */
export function atlasCardLayout(input: AtlasCardInput): {
  brand: string;
  title: string;
  subtitle: string;
  width: number;
  height: number;
} {
  const title = `${input.owner}/${input.repo}`;
  return {
    brand: 'OKIE',
    title: title.length > 22 ? `${title.slice(0, 21)}…` : title,
    subtitle: 'Architecture atlas',
    width: OG_IMAGE_WIDTH,
    height: OG_IMAGE_HEIGHT,
  };
}

/** PNG bytes for a public atlas card. No secrets, env, or scan payload. */
export function renderAtlasCardPng(input: AtlasCardInput): Uint8Array {
  const { width, height } = { width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT };
  const rgba = new Uint8Array(width * height * 4);
  fillRect(rgba, width, height, 0, 0, width, height, BG);
  const layout = atlasCardLayout(input);
  drawText(rgba, width, height, layout.brand, 64, 72, 7, ACCENT);
  const titleScale = layout.title.length > 16 ? 5 : 6;
  drawText(rgba, width, height, layout.title, 64, 250, titleScale, TEXT);
  drawText(rgba, width, height, layout.subtitle, 64, 250 + 7 * titleScale + 28, 4, MUTED);
  drawMapPreview(rgba, width, height, input.owner, input.repo);
  return encodePng(width, height, rgba);
}

export function pngSignatureOk(bytes: Uint8Array): boolean {
  return bytes.length > 8
    && bytes[0] === 137
    && bytes[1] === 80
    && bytes[2] === 78
    && bytes[3] === 71
    && bytes[4] === 13
    && bytes[5] === 10
    && bytes[6] === 26
    && bytes[7] === 10;
}

export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24 || !pngSignatureOk(bytes)) return undefined;
  const width = (bytes[16]! << 24) | (bytes[17]! << 16) | (bytes[18]! << 8) | bytes[19]!;
  const height = (bytes[20]! << 24) | (bytes[21]! << 16) | (bytes[22]! << 8) | bytes[23]!;
  return { width, height };
}
