#!/usr/bin/env node
// Build a plugin archive from an explicit allowlist; never include checkout/config/cache files.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('../plugins/sourcefor-atlas/', import.meta.url));
const output = process.argv[2];
const options = process.argv.slice(3);
if (!output || !output.endsWith('.zip') || options.length && (options.length !== 2 || options[0] !== '--chatgpt-app-id')) throw new Error('Usage: node scripts/package-atlas-plugin.mjs /absolute/path/sourcefor-atlas.zip [--chatgpt-app-id asdk_app_ID]');
const appId = options[1]?.replace(/^plugin_/, '');
if (appId !== undefined && !/^(?:asdk_app_|connector_|templated_apps_)[A-Za-z0-9][A-Za-z0-9_-]*$/.test(appId)) throw new Error('Expected a registered ChatGPT connection ID, not a URL or credential');
const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'));
const mcp = JSON.parse(readFileSync(join(root, 'mcp.json'), 'utf8'));
if (manifest.name !== 'sourcefor-atlas' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid plugin identity/version');
if (Object.keys(mcp.mcpServers).join() !== 'atlas' || mcp.mcpServers.atlas.type !== 'streamable-http' || mcp.mcpServers.atlas.url !== 'https://sourcefor.dev/mcp' || Object.keys(mcp.mcpServers.atlas).sort().join() !== 'type,url') throw new Error('Package requires the public read endpoint and no embedded authentication');
const files = ['plugin.json', ...(appId ? ['.app.json'] : ['mcp.json']), 'README.md', 'skills/understand-atlas/SKILL.md'];
const scratch = mkdtempSync(join(tmpdir(), 'atlas-plugin-package-'));
try {
  for (const file of files) {
    const target = join(scratch, 'sourcefor-atlas', file);
    mkdirSync(dirname(target), { recursive: true });
    if (appId && file === 'plugin.json') {
      manifest.extensions['com.openai'].apps = './.app.json';
      writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
    } else if (file === '.app.json') {
      writeFileSync(target, `${JSON.stringify({ apps: { atlas: { id: appId } } }, null, 2)}\n`);
    } else copyFileSync(join(root, file), target);
  }
  const target = resolve(output);
  mkdirSync(dirname(target), { recursive: true });
  // A fresh archive avoids preserving obsolete files from an earlier packaging run.
  rmSync(target, { force: true });
  execFileSync('zip', ['-X', '-q', target, ...files.map(file => `sourcefor-atlas/${file}`)], { cwd: scratch });
  console.log(`Packaged sourcefor-atlas ${manifest.version}: ${target}`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
