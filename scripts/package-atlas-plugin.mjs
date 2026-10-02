#!/usr/bin/env node
// Build a plugin archive from an explicit allowlist; never include checkout/config/cache files.
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('../plugins/sourcefor-atlas/', import.meta.url));
const output = process.argv[2];
if (!output || !output.endsWith('.zip')) throw new Error('Usage: node scripts/package-atlas-plugin.mjs /absolute/path/sourcefor-atlas.zip');
const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'));
const mcp = JSON.parse(readFileSync(join(root, 'mcp.json'), 'utf8'));
if (manifest.name !== 'sourcefor-atlas' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid plugin identity/version');
if (Object.keys(mcp.mcpServers).join() !== 'atlas' || mcp.mcpServers.atlas.type !== 'streamable-http' || mcp.mcpServers.atlas.url !== 'https://sourcefor.dev/mcp' || Object.keys(mcp.mcpServers.atlas).sort().join() !== 'type,url') throw new Error('Package requires the public read endpoint and no embedded authentication');
const files = ['plugin.json', 'mcp.json', 'README.md', 'skills/understand-atlas/SKILL.md'];
const scratch = mkdtempSync(join(tmpdir(), 'atlas-plugin-package-'));
try {
  for (const file of files) {
    const target = join(scratch, 'sourcefor-atlas', file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, file), target);
  }
  const target = resolve(output);
  mkdirSync(dirname(target), { recursive: true });
  // A fresh archive avoids preserving obsolete files from an earlier packaging run.
  rmSync(target, { force: true });
  execFileSync('zip', ['-X', '-q', target, ...files.map(file => `sourcefor-atlas/${file}`)], { cwd: scratch });
  console.log(`Packaged sourcefor-atlas ${manifest.version}: ${target}`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
