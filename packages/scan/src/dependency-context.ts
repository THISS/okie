import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Read installed dependency declarations without exposing working-tree source. */
export function dependencyContext(root: string, installationRoot?: string, compilerLibraryDirectories: readonly string[] = []): { path: (path: string) => string; limitation?: string } {
  const identity = (path: string) => path;
  if (!installationRoot || resolve(root) === resolve(installationRoot)) return { path: identity };
  root = resolve(root);
  installationRoot = realpathSync(installationRoot);
  const inside = (base: string, path: string): boolean => {
    const rel = relative(base, path);
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  const physical = (path: string): string => {
    try { return realpathSync(path); } catch { return path; }
  };
  const trustedCompilerLibraries = compilerLibraryDirectories.map(physical);
  const unavailable = (): string => resolve(root, '.okie-unavailable-dependency');
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
      // Compiler resolution starts at the committed root, then continues from
      // physical declaration files in the local installation.  Treat both
      // spellings as inputs to this boundary: a physical relative import must
      // never fall through to a dirty file beside the installation.
      const physicalPath = physical(path);
      const fromCommittedRoot = inside(root, path) || inside(physical(root), physicalPath);
      const fromInstallation = inside(installationRoot, path) || inside(installationRoot, physicalPath);
      if (!fromCommittedRoot && !fromInstallation) {
        // The compiler's own lib.*.d.ts files are supplied explicitly by the
        // analyzer. Do not grant the rest of the process's node_modules tree.
        return trustedCompilerLibraries.some(directory => inside(directory, physicalPath)) ? physicalPath : unavailable();
      }
      const rel = relative(fromCommittedRoot ? (inside(root, path) ? root : physical(root)) : installationRoot,
        fromInstallation && !inside(installationRoot, path) ? physicalPath : path);
      if (!rel.split(sep).includes('node_modules')) {
        // A declaration's ../../ escape can only read its committed counterpart.
        // Returning the corresponding path even when it is absent lets normal
        // module resolution report it as unresolved without reading the working tree.
        return fromInstallation ? resolve(root, rel) : path;
      }
      const candidate = fromCommittedRoot ? resolve(installationRoot, rel) : path;
      try {
        const actual = realpathSync(candidate);
        const actualRel = relative(installationRoot, actual);
        // Workspace symlinks must resolve through the committed-project mapping,
        // never to dirty workspace files. External linked packages are omitted.
        if (!inside(installationRoot, actual) || !actualRel.split(sep).includes('node_modules')) return unavailable();
        return actual;
      } catch { return fromCommittedRoot ? path : unavailable(); }
    },
  };
}
