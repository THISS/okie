#!/usr/bin/env node
/**
 * Rebuilds the committed raster brand assets in apps/web/public from their SVG sources (CLA-318).
 * Output is metadata-stripped, so a rerun is byte-identical. Not part of the build: run it by hand after editing a source SVG, then commit the PNG/ICO output.
 *
 *   node scripts/generate-brand-assets.mjs
 *
 * Sources → outputs:
 *   apps/web/public/favicon.svg            → favicon-16.png, favicon-32.png, favicon.ico (16/32/48)
 *   docs/brand/og/apple-touch-icon.svg     → apple-touch-icon.png (180×180, opaque RGB)
 *   docs/brand/og/og-default.svg           → og-default.png (1200×630, opaque RGB; `/` and `/new` card)
 *
 * Requires `rsvg-convert` (librsvg) and `magick` (ImageMagick 7) on PATH (Homebrew: /opt/homebrew/bin).
 *
 * Fonts: og-default.svg sets live text in IBM Plex Sans (Regular + SemiBold, family names
 * "IBM Plex Sans" / "IBM Plex Sans SemiBold"). Without them rsvg silently falls back to another face.
 * This script makes them available without installing anything system-wide: it converts the
 * @fontsource/ibm-plex-sans latin 400/600 .woff files (an apps/web dependency, so `pnpm install` first)
 * to .ttf in a temp dir (harfbuzz does not read WOFF), points FONTCONFIG_FILE at it, and sets
 * PANGOCAIRO_BACKEND=fc — on macOS, pango otherwise uses CoreText and ignores fontconfig.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const pub = join(root, 'apps/web/public');
const brand = join(root, 'docs/brand/og');
const plexFiles = join(root, 'apps/web/node_modules/@fontsource/ibm-plex-sans/files');
const GROUND = '#070a0b';

/** WOFF 1.0 → sfnt (TrueType/OpenType): inflate each table and rebuild the table directory. */
function woffToSfnt(woff) {
  const flavor = woff.readUInt32BE(4);
  const numTables = woff.readUInt16BE(12);
  const tables = [];
  for (let i = 0; i < numTables; i += 1) {
    const entry = 44 + i * 20;
    const offset = woff.readUInt32BE(entry + 4);
    const compLength = woff.readUInt32BE(entry + 8);
    const origLength = woff.readUInt32BE(entry + 12);
    const raw = woff.subarray(offset, offset + compLength);
    tables.push({
      tag: woff.readUInt32BE(entry),
      checksum: woff.readUInt32BE(entry + 16),
      data: compLength < origLength ? inflateSync(raw) : Buffer.from(raw),
    });
  }
  let entrySelector = 0;
  while (1 << (entrySelector + 1) <= numTables) entrySelector += 1;
  const searchRange = (1 << entrySelector) * 16;
  const header = Buffer.alloc(12 + 16 * numTables);
  header.writeUInt32BE(flavor, 0);
  header.writeUInt16BE(numTables, 4);
  header.writeUInt16BE(searchRange, 6);
  header.writeUInt16BE(entrySelector, 8);
  header.writeUInt16BE(numTables * 16 - searchRange, 10);
  const parts = [header];
  let offset = header.length;
  tables.forEach((table, i) => {
    const entry = 12 + i * 16;
    header.writeUInt32BE(table.tag, entry);
    header.writeUInt32BE(table.checksum, entry + 4);
    header.writeUInt32BE(offset, entry + 8);
    header.writeUInt32BE(table.data.length, entry + 12);
    const pad = (4 - (table.data.length % 4)) % 4;
    parts.push(table.data, Buffer.alloc(pad));
    offset += table.data.length + pad;
  });
  return Buffer.concat(parts);
}

function run(command, args, env = process.env) {
  execFileSync(command, args, { stdio: ['ignore', 'inherit', 'inherit'], env });
}

function requireTool(command) {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore' });
  } catch {
    throw new Error(`${command} is required on PATH (brew install librsvg imagemagick).`);
  }
}

requireTool('rsvg-convert');
requireTool('magick');

const work = mkdtempSync(join(tmpdir(), 'brand-assets-'));
try {
  const fontDir = join(work, 'fonts');
  mkdirSync(fontDir);
  for (const weight of ['400', '600']) {
    const woff = readFileSync(join(plexFiles, `ibm-plex-sans-latin-${weight}-normal.woff`));
    writeFileSync(join(fontDir, `ibm-plex-sans-${weight}.ttf`), woffToSfnt(woff));
  }
  const fontsConf = join(work, 'fonts.conf');
  writeFileSync(fontsConf, `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontDir}</dir>
  <cachedir>${join(work, 'fc-cache')}</cachedir>
</fontconfig>
`);
  const fontEnv = { ...process.env, FONTCONFIG_FILE: fontsConf, PANGOCAIRO_BACKEND: 'fc' };
  const families = execFileSync('fc-list', [':', 'family'], { env: fontEnv, encoding: 'utf8' });
  if (!/IBM Plex Sans SemiBold/.test(families) || !/^IBM Plex Sans$/m.test(families)) {
    throw new Error(`IBM Plex Sans Regular + SemiBold did not register with fontconfig (got: ${families.trim() || 'nothing'}).`);
  }

  // Favicons: the favicon.svg drawing (dark rounded tile, transparent corners) at each size.
  const favicon = join(pub, 'favicon.svg');
  const sized = size => join(work, `favicon-${size}.png`);
  for (const size of [16, 32, 48]) run('rsvg-convert', ['-w', String(size), '-h', String(size), favicon, '-o', sized(size)]);
  run('magick', [sized(16), '-strip', `PNG32:${join(pub, 'favicon-16.png')}`]);
  run('magick', [sized(32), '-strip', `PNG32:${join(pub, 'favicon-32.png')}`]);
  run('magick', [sized(16), sized(32), sized(48), join(pub, 'favicon.ico')]);

  // Opaque rasters: render on the dark ground, then drop the alpha channel.
  const opaque = (source, width, height, output, env) => {
    const raw = join(work, 'opaque.png');
    run('rsvg-convert', ['-w', String(width), '-h', String(height), '-b', GROUND, source, '-o', raw], env);
    run('magick', [raw, '-alpha', 'off', '-strip', `PNG24:${output}`]);
  };
  opaque(join(brand, 'apple-touch-icon.svg'), 180, 180, join(pub, 'apple-touch-icon.png'));
  opaque(join(brand, 'og-default.svg'), 1200, 630, join(pub, 'og-default.png'), fontEnv);

  console.log(`Brand assets written to ${pub}: ${readdirSync(pub).filter(name => /^(favicon|apple-touch|og-default)/.test(name)).join(', ')}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
