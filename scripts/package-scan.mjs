import { build } from 'esbuild';
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Bundle workspace code, retaining native parsers and language tooling as npm
// dependencies. The resulting directory can be installed or packed independently.
const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'dist/okie-cli');
const scan = JSON.parse(readFileSync(join(root, 'packages/scan/package.json'), 'utf8'));
const dependencies = Object.fromEntries(Object.entries(scan.dependencies).filter(([name]) => !name.startsWith('@okie/')));
mkdirSync(join(output, 'bin'), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['packages/scan/src/cli.ts'],
  outfile: join(output, 'bin/cli.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: Object.keys(dependencies),
  alias: {
    '@okie/architecture': join(root, 'packages/architecture/src/index.ts'),
    '@okie/scene-compiler': join(root, 'packages/scene-compiler/src/index.ts'),
  },
});
chmodSync(join(output, 'bin/cli.mjs'), 0o755);
for (const name of ['enrichment-prompt.md', 'enrichment-prompt-v3.md']) {
  copyFileSync(join(root, 'packages/scan', name), join(output, name));
}
cpSync(join(root, 'skills'), join(output, 'skills'), { recursive: true });
writeFileSync(join(output, 'package.json'), JSON.stringify({
  name: '@okie/scan', version: scan.version, type: 'module',
  description: 'Committed-source architecture scanning and portable atlas packaging',
  engines: { node: '>=22' }, bin: { 'okie-scan': 'bin/cli.mjs' },
  files: ['bin', 'skills', 'enrichment-prompt.md', 'enrichment-prompt-v3.md'], dependencies,
}, null, 2) + '\n');
console.log(`CLI package prepared at ${output}. Use npm pack in that directory to create a local distribution tarball.`);
