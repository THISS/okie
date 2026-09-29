import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { portableIndexHtml } from './portable-html.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync('pnpm', ['--filter', '@okie/web', 'exec', 'vite', 'build', '--base', './', '--outDir', 'dist-portable'], { cwd: root, stdio: 'inherit' });
const index = new URL('../apps/web/dist-portable/index.html', import.meta.url);
writeFileSync(index, portableIndexHtml(readFileSync(index, 'utf8')));
console.log('Portable viewer ready in apps/web/dist-portable. It opens local scans without an application backend.');
