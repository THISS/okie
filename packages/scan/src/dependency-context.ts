import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Read installed dependency declarations without exposing working-tree source. */
export function dependencyContext(root: string, installationRoot?: string): { path: (path: string) => string; limitation?: string } {
  const identity = (path: string) => path;
  if (!installationRoot || resolve(root) === resolve(installationRoot)) return { path: identity };
  installationRoot = realpathSync(installationRoot);
  const manifests: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !['node_modules', '.git', 'target', 'dist', 'build'].includes(entry.name)) walk(resolve(directory, entry.name));
      else if (entry.isFile() && (entry.name === 'package.json' || /^(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|pnpm-workspace\.yaml)$/.test(entry.name))) manifests.push(relative(root, resolve(directory, entry.name)));
    }
  };
  walk(root);
  if (manifests.some(path => !existsSync(resolve(installationRoot, path)) || !readFileSync(resolve(root, path)).equals(readFileSync(resolve(installationRoot, path))))) {
    return { path: identity, limitation: 'Local dependency context not reused: working-tree package manifests or lockfiles differ from the scanned commit.' };
  }
  return {
    limitation: 'Installed dependency types reused read-only from the local checkout after matching committed manifests and lockfiles; installation contents are not verified against the lockfile.',
    path: path => {
      const rel = relative(root, path);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !rel.split(sep).includes('node_modules')) return path;
      const candidate = resolve(installationRoot, rel);
      try {
        const actual = realpathSync(candidate);
        const actualRel = relative(installationRoot, actual);
        // Workspace symlinks must resolve through the committed-project mapping,
        // never to dirty workspace files. External linked packages are omitted.
        if (isAbsolute(actualRel) || actualRel.startsWith(`..${sep}`) || !actualRel.split(sep).includes('node_modules')) return path;
        return actual;
      } catch { return path; }
    },
  };
}
