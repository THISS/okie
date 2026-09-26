import { portableSourcePath } from './portable-path.js';

/**
 * Dependency consumer facts (CLA-212). Three evidence kinds stay distinct:
 * a manifest declaration is not an import, and an import is not a resolved
 * symbol reference. Only imports and symbol references make a consumer.
 */
export type DependencyEcosystem = 'npm' | 'cargo';
export type DependencySection =
  | 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies'
  | 'dev-dependencies' | 'build-dependencies';
export type DependencyResolution = 'resolved' | 'local' | 'unresolved' | 'ambiguous';
export type DependencyImportKind = 'static' | 'reexport' | 'dynamic' | 'require' | 'use' | 'externCrate';
export type DependencyEvidenceKind = 'declarations' | 'imports' | 'symbolReferences';

/** A first-party package (npm package.json with any name, or a Cargo crate with `[package]`). */
export interface DependencyPackage {
  ecosystem: DependencyEcosystem;
  name: string;
  /** Repository-relative manifest path; the package's identity in every other fact. */
  manifestPath: string;
  /** Repository-relative directory; '' is the repository root. */
  directory: string;
}

/** (a) A manifest entry. Declaration alone is never evidence of use. */
export interface DependencyDeclaration {
  ecosystem: DependencyEcosystem;
  /** Canonical package name (npm alias target / Cargo `package = "…"`). */
  dependency: string;
  /** The key used in code when it differs from the package name (Cargo rename, npm `npm:` alias). */
  alias?: string;
  /** Manifest path of the declaring package. */
  declaringPackage: string;
  section: DependencySection;
  /** Cargo `[target.<cfg>.…]` selector, verbatim without quotes. */
  target?: string;
  /** Requested spec as written, with URL credentials and token-shaped strings redacted. */
  requested: string;
  /** Resolves inside the repository (`workspace:`/`file:`/`link:`/Cargo `path`). */
  local: boolean;
  /** Cargo `workspace = true`: the spec was inherited from `[workspace.dependencies]`. */
  workspaceInherited?: boolean;
  resolution: DependencyResolution;
  /** One version when resolved; every lockfile candidate when ambiguous; empty otherwise. */
  resolvedVersions: string[];
  lockfilePath?: string;
  /** Why the resolution is unresolved or ambiguous. */
  reason?: string;
  source: { path: string; line?: number };
}

/** (b) A syntactic import of a non-relative, non-builtin module / declared crate root. */
export interface DependencyImport {
  ecosystem: DependencyEcosystem;
  dependency: string;
  /** Full specifier (npm, subpath kept) or Rust root path segment as written. */
  specifier: string;
  path: string;
  startLine: number;
  endLine: number;
  /** Manifest path of the nearest owning package. */
  consumingPackage: string;
  kind: DependencyImportKind;
  /** `import type` / `export type`: never a runtime dependency. */
  typeOnly: boolean;
}

/** (c) An analyzer-resolved reference to a symbol declared by the dependency. */
export interface DependencySymbolReference {
  ecosystem: DependencyEcosystem;
  dependency: string;
  path: string;
  startLine: number;
  endLine: number;
  consumingPackage: string;
  /** Display name, e.g. `useState` or `wgpu::Device::create_buffer`. */
  symbol: string;
  kind: 'uses' | 'calls';
  /** Type position or reached through a type-only import: compile-time only, never runtime use. */
  typeOnly: boolean;
  /** `typescript@5.9.3` / `rust-analyzer@1.87.0`. */
  analyzer: string;
  resolvedVersion?: string;
  /** Package that actually declares the symbol when it differs (`@types/react`, `wgpu-types`). */
  via?: string;
}

export interface DependencyCoverage {
  ecosystem: DependencyEcosystem;
  evidence: DependencyEvidenceKind;
  status: 'complete' | 'partial' | 'unavailable';
  limitations: string[];
  /** Facts dropped by caps; truncation is never silent. */
  dropped: number;
  droppedByDependency: Array<{ dependency: string; dropped: number }>;
}

export interface DependencyFacts {
  schemaVersion: 1;
  commitSha: string;
  packages: DependencyPackage[];
  declarations: DependencyDeclaration[];
  imports: DependencyImport[];
  symbolReferences: DependencySymbolReference[];
  coverage: DependencyCoverage[];
}

// ---------------------------------------------------------------------------
// Validation (bundle import boundary)

const ECOSYSTEMS: readonly string[] = ['npm', 'cargo'];
const SECTIONS: readonly string[] = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'dev-dependencies', 'build-dependencies'];
const RESOLUTIONS: readonly string[] = ['resolved', 'local', 'unresolved', 'ambiguous'];
const IMPORT_KINDS: readonly string[] = ['static', 'reexport', 'dynamic', 'require', 'use', 'externCrate'];
const EVIDENCE: readonly string[] = ['declarations', 'imports', 'symbolReferences'];

function fail(path: string, expected: string): never { throw new Error(`${path}: expected ${expected}`); }
function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'an object');
  return value as Record<string, unknown>;
}
function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'an array');
  return value;
}
/** C0/C1 control characters (ANSI/OSC escapes start with ESC or C1 CSI/OSC). */
export const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_CHARACTERS_GLOBAL = /[\u0000-\u001f\u007f-\u009f]/g;
/** Replace control characters so untrusted strings cannot drive a terminal. */
export function sanitizeControlCharacters(value: string): string {
  return value.replace(CONTROL_CHARACTERS_GLOBAL, '\ufffd');
}
function plain(value: unknown, path: string): void {
  if (typeof value !== 'string') fail(path, 'a string');
  if (CONTROL_CHARACTERS.test(value)) fail(path, 'a string without control characters');
}
function text(value: unknown, path: string, optional = false): void {
  if (optional && value === undefined) return;
  if (typeof value !== 'string' || !value.length) fail(path, 'a non-empty string');
  plain(value, path);
}
function oneOf(value: unknown, values: readonly string[], path: string): void {
  if (typeof value !== 'string' || !values.includes(value)) fail(path, values.join(' or '));
}
function repoPath(value: unknown, path: string, optional = false): void {
  if (optional && value === undefined) return;
  if (!portableSourcePath(value) || CONTROL_CHARACTERS.test(value)) fail(path, 'a repository-relative path');
}
function lines(row: Record<string, unknown>, path: string): void {
  const { startLine, endLine } = row;
  if (!Number.isSafeInteger(startLine) || (startLine as number) < 1 || !Number.isSafeInteger(endLine) || (endLine as number) < (startLine as number)) {
    fail(path, 'an ordered 1-based line range');
  }
}

/** Throws on malformed facts, a revision mismatch, or a non-portable path. */
export function validateDependencyFacts(raw: unknown, commitSha: string): asserts raw is DependencyFacts {
  const facts = object(raw, 'dependencies');
  if (facts.schemaVersion !== 1) fail('dependencies.schemaVersion', '1');
  if (facts.commitSha !== commitSha) throw new Error('dependencies.commitSha differs from the bundle revision.');
  const manifests = new Set<string>();
  array(facts.packages, 'dependencies.packages').forEach((value, index) => {
    const path = `dependencies.packages[${index}]`;
    const row = object(value, path);
    oneOf(row.ecosystem, ECOSYSTEMS, `${path}.ecosystem`);
    text(row.name, `${path}.name`);
    repoPath(row.manifestPath, `${path}.manifestPath`);
    if (row.directory !== '') repoPath(row.directory, `${path}.directory`);
    manifests.add(row.manifestPath as string);
  });
  const owner = (value: unknown, path: string): void => {
    repoPath(value, path);
    if (!manifests.has(value as string)) fail(path, 'a manifest listed in dependencies.packages');
  };
  array(facts.declarations, 'dependencies.declarations').forEach((value, index) => {
    const path = `dependencies.declarations[${index}]`;
    const row = object(value, path);
    oneOf(row.ecosystem, ECOSYSTEMS, `${path}.ecosystem`);
    text(row.dependency, `${path}.dependency`);
    text(row.alias, `${path}.alias`, true);
    owner(row.declaringPackage, `${path}.declaringPackage`);
    oneOf(row.section, SECTIONS, `${path}.section`);
    text(row.target, `${path}.target`, true);
    plain(row.requested, `${path}.requested`);
    if (typeof row.local !== 'boolean') fail(`${path}.local`, 'a boolean');
    if (row.workspaceInherited !== undefined && typeof row.workspaceInherited !== 'boolean') fail(`${path}.workspaceInherited`, 'a boolean');
    oneOf(row.resolution, RESOLUTIONS, `${path}.resolution`);
    if (!Array.isArray(row.resolvedVersions) || !row.resolvedVersions.every(item => typeof item === 'string' && item.length > 0 && !CONTROL_CHARACTERS.test(item))) fail(`${path}.resolvedVersions`, 'a list of versions');
    repoPath(row.lockfilePath, `${path}.lockfilePath`, true);
    text(row.reason, `${path}.reason`, true);
    const source = object(row.source, `${path}.source`);
    repoPath(source.path, `${path}.source.path`);
    if (source.line !== undefined && (!Number.isSafeInteger(source.line) || (source.line as number) < 1)) fail(`${path}.source.line`, 'a positive integer');
  });
  array(facts.imports, 'dependencies.imports').forEach((value, index) => {
    const path = `dependencies.imports[${index}]`;
    const row = object(value, path);
    oneOf(row.ecosystem, ECOSYSTEMS, `${path}.ecosystem`);
    text(row.dependency, `${path}.dependency`);
    text(row.specifier, `${path}.specifier`);
    repoPath(row.path, `${path}.path`);
    lines(row, path);
    owner(row.consumingPackage, `${path}.consumingPackage`);
    oneOf(row.kind, IMPORT_KINDS, `${path}.kind`);
    if (typeof row.typeOnly !== 'boolean') fail(`${path}.typeOnly`, 'a boolean');
  });
  array(facts.symbolReferences, 'dependencies.symbolReferences').forEach((value, index) => {
    const path = `dependencies.symbolReferences[${index}]`;
    const row = object(value, path);
    oneOf(row.ecosystem, ECOSYSTEMS, `${path}.ecosystem`);
    text(row.dependency, `${path}.dependency`);
    repoPath(row.path, `${path}.path`);
    lines(row, path);
    owner(row.consumingPackage, `${path}.consumingPackage`);
    text(row.symbol, `${path}.symbol`);
    oneOf(row.kind, ['uses', 'calls'], `${path}.kind`);
    if (typeof row.typeOnly !== 'boolean') fail(`${path}.typeOnly`, 'a boolean');
    text(row.analyzer, `${path}.analyzer`);
    text(row.resolvedVersion, `${path}.resolvedVersion`, true);
    text(row.via, `${path}.via`, true);
  });
  array(facts.coverage, 'dependencies.coverage').forEach((value, index) => {
    const path = `dependencies.coverage[${index}]`;
    const row = object(value, path);
    oneOf(row.ecosystem, ECOSYSTEMS, `${path}.ecosystem`);
    oneOf(row.evidence, EVIDENCE, `${path}.evidence`);
    oneOf(row.status, ['complete', 'partial', 'unavailable'], `${path}.status`);
    if (!Array.isArray(row.limitations) || !row.limitations.every(item => typeof item === 'string' && !CONTROL_CHARACTERS.test(item))) fail(`${path}.limitations`, 'a list of strings without control characters');
    if (!Number.isSafeInteger(row.dropped) || (row.dropped as number) < 0) fail(`${path}.dropped`, 'a non-negative integer');
    array(row.droppedByDependency, `${path}.droppedByDependency`).forEach((item, itemIndex) => {
      const entry = object(item, `${path}.droppedByDependency[${itemIndex}]`);
      text(entry.dependency, `${path}.droppedByDependency[${itemIndex}].dependency`);
      if (!Number.isSafeInteger(entry.dropped) || (entry.dropped as number) < 0) fail(`${path}.droppedByDependency[${itemIndex}].dropped`, 'a non-negative integer');
    });
  });
}

// ---------------------------------------------------------------------------
// Query

export interface DependencyConsumerOptions {
  ecosystem?: DependencyEcosystem;
  /** Include `import type` / `export type` evidence (default true; always labelled). */
  includeTypeOnly?: boolean;
}

export interface DependencyConsumerFile {
  path: string;
  imports: DependencyImport[];
  symbolReferences: DependencySymbolReference[];
  /** Every piece of evidence in this file is type-only (no runtime import, no symbol reference). */
  typeOnly: boolean;
}

export interface DependencyConsumer {
  package: { name: string; manifestPath: string; ecosystem: DependencyEcosystem };
  /** This package's own declarations of the dependency; empty means undeclared here. */
  declared: DependencyDeclaration[];
  /** Used without a declaration in this package's manifest (it may resolve via hoisting or a parent). */
  undeclared: boolean;
  /** Only type-only imports were observed. */
  typeOnly: boolean;
  files: DependencyConsumerFile[];
}

export const DECLARATION_ONLY_LABEL = 'declaration only — not evidence of use';

export interface DependencyDeclarationOnly {
  package: { name: string; manifestPath: string; ecosystem: DependencyEcosystem };
  declarations: DependencyDeclaration[];
  label: typeof DECLARATION_ONLY_LABEL;
}

export interface DependencyConsumerReport {
  /** The dependency as queried. */
  dependency: string;
  /** Canonical dependency names that matched (Rust ident / rename / `@types` forms included). */
  matchedNames: string[];
  ecosystems: DependencyEcosystem[];
  /** False when the bundle predates dependency capture. */
  factsAvailable: boolean;
  includeTypeOnly: boolean;
  declarations: DependencyDeclaration[];
  consumers: DependencyConsumer[];
  declaredWithoutObservedUse: DependencyDeclarationOnly[];
  /** Human-readable limits applicable to this answer. */
  coverage: string[];
  /** Close declared names when nothing matched. */
  suggestions: string[];
  summary: {
    declarations: number;
    consumers: number;
    files: number;
    imports: number;
    typeOnlyImports: number;
    excludedTypeOnlyImports: number;
    symbolReferences: number;
    typeOnlySymbolReferences: number;
    excludedTypeOnlySymbolReferences: number;
    calls: number;
  };
}

export const FACTS_UNAVAILABLE_LIMIT = 'This bundle predates dependency capture; rescan to query consumers.';
/**
 * Coverage limitation carried by a facts object whose rows were all removed to keep the
 * bundle under its size limit. Such a bundle did capture dependencies; queries must say so.
 */
export const DEPENDENCY_FACTS_OMITTED_LIMIT = 'Dependency facts omitted: bundle size limit. Declarations, imports and symbol references were captured but did not fit in this bundle.';
/** True when `facts` is the minimal stand-in left after every row was dropped for size. */
export function dependencyFactsOmitted(facts: DependencyFacts): boolean {
  return !facts.declarations.length && !facts.imports.length && !facts.symbolReferences.length
    && facts.coverage.some(row => row.limitations.includes(DEPENDENCY_FACTS_OMITTED_LIMIT));
}

const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const rustIdent = (name: string): string => name.replace(/-/g, '_');
function typesTarget(name: string): string | undefined {
  const match = /^@types\/(.+)$/.exec(name);
  if (!match) return undefined;
  const inner = match[1]!;
  const scoped = /^([^_]+)__(.+)$/.exec(inner);
  return scoped ? `@${scoped[1]}/${scoped[2]}` : inner;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const saved = previous[j]!;
      previous[j] = Math.min(previous[j]! + 1, previous[j - 1]! + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = saved;
    }
  }
  return previous[right.length]!;
}

function emptyReport(dependency: string, includeTypeOnly: boolean, factsAvailable: boolean, coverage: string[], suggestions: string[] = []): DependencyConsumerReport {
  return {
    dependency, matchedNames: [], ecosystems: [], factsAvailable, includeTypeOnly,
    declarations: [], consumers: [], declaredWithoutObservedUse: [], coverage, suggestions,
    summary: { declarations: 0, consumers: 0, files: 0, imports: 0, typeOnlyImports: 0, excludedTypeOnlyImports: 0, symbolReferences: 0, typeOnlySymbolReferences: 0, excludedTypeOnlySymbolReferences: 0, calls: 0 },
  };
}

const EVIDENCE_LABEL: Record<DependencyEvidenceKind, string> = {
  declarations: 'Declarations', imports: 'Imports', symbolReferences: 'Symbol references',
};

/** Who consumes `dependency`? Pure and deterministically ordered. */
export function queryDependencyConsumers(
  facts: DependencyFacts | undefined,
  dependency: string,
  options: DependencyConsumerOptions = {},
): DependencyConsumerReport {
  const includeTypeOnly = options.includeTypeOnly ?? true;
  const query = dependency.trim();
  if (!facts) return emptyReport(query, includeTypeOnly, false, [FACTS_UNAVAILABLE_LIMIT]);
  if (dependencyFactsOmitted(facts)) return emptyReport(query, includeTypeOnly, false, [DEPENDENCY_FACTS_OMITTED_LIMIT]);
  const inEcosystem = (ecosystem: DependencyEcosystem): boolean => !options.ecosystem || options.ecosystem === ecosystem;
  const typesName = typesTarget(query);
  const matches = (ecosystem: DependencyEcosystem, name: string | undefined): boolean => {
    if (!name || !inEcosystem(ecosystem)) return false;
    if (name === query || (typesName !== undefined && name === typesName)) return true;
    return ecosystem === 'cargo' && rustIdent(name) === rustIdent(query);
  };
  const declarations = facts.declarations.filter(row => matches(row.ecosystem, row.dependency) || matches(row.ecosystem, row.alias));
  // A query by an alias key (`"s": "npm:left-pad@…"`, Cargo rename) reaches the canonical package,
  // so both names answer with the same consumers.
  const canonical = new Set(declarations.map(row => `${row.ecosystem}\u0000${row.dependency}`));
  const selected = (ecosystem: DependencyEcosystem, name: string | undefined): boolean =>
    matches(ecosystem, name) || (name !== undefined && canonical.has(`${ecosystem}\u0000${name}`));
  const allImports = facts.imports.filter(row => selected(row.ecosystem, row.dependency));
  const allReferences = facts.symbolReferences.filter(row => selected(row.ecosystem, row.dependency) || matches(row.ecosystem, row.via));
  const imports = includeTypeOnly ? allImports : allImports.filter(row => !row.typeOnly);
  const references = includeTypeOnly ? allReferences : allReferences.filter(row => !row.typeOnly);
  const matchedNames = [...new Set([...declarations, ...allImports, ...allReferences].map(row => row.dependency))].sort(compare);
  const ecosystems = [...new Set([...declarations, ...allImports, ...allReferences].map(row => row.ecosystem))].sort(compare) as DependencyEcosystem[];

  if (!matchedNames.length) {
    const known = [...new Set([...facts.declarations.flatMap(row => [row.dependency, ...(row.alias ? [row.alias] : [])]), ...facts.imports.map(row => row.dependency)]
      .filter(name => facts.declarations.some(row => (row.dependency === name || row.alias === name) && inEcosystem(row.ecosystem))
        || facts.imports.some(row => row.dependency === name && inEcosystem(row.ecosystem))))];
    const lower = query.toLowerCase();
    const suggestions = known
      .map(name => ({ name, distance: editDistance(lower, name.toLowerCase()) }))
      .filter(item => item.distance <= Math.max(2, Math.floor(query.length / 3)) || item.name.toLowerCase().includes(lower) || (lower.length >= 3 && lower.includes(item.name.toLowerCase())))
      .sort((left, right) => left.distance - right.distance || compare(left.name, right.name))
      .slice(0, 5).map(item => item.name);
    return emptyReport(query, includeTypeOnly, true, [`No declaration, import or symbol reference of “${query}” was captured${options.ecosystem ? ` in ${options.ecosystem}` : ''}.`, ...coverageLines(facts, options.ecosystem ? [options.ecosystem] : ['npm', 'cargo'], [])], suggestions);
  }

  const packages = new Map(facts.packages.map(row => [row.manifestPath, row]));
  const packageRef = (manifestPath: string, ecosystem: DependencyEcosystem) => {
    const row = packages.get(manifestPath);
    return { name: row?.name ?? manifestPath, manifestPath, ecosystem: row?.ecosystem ?? ecosystem };
  };
  const byPackage = new Map<string, { ecosystem: DependencyEcosystem; files: Map<string, DependencyConsumerFile> }>();
  const fileOf = (manifestPath: string, ecosystem: DependencyEcosystem, path: string): DependencyConsumerFile => {
    const entry = byPackage.get(manifestPath) ?? { ecosystem, files: new Map() };
    byPackage.set(manifestPath, entry);
    const file = entry.files.get(path) ?? { path, imports: [], symbolReferences: [], typeOnly: false };
    entry.files.set(path, file);
    return file;
  };
  for (const row of imports) fileOf(row.consumingPackage, row.ecosystem, row.path).imports.push(row);
  for (const row of references) fileOf(row.consumingPackage, row.ecosystem, row.path).symbolReferences.push(row);
  const byLine = <T extends { startLine: number; endLine: number }>(left: T, right: T): number =>
    left.startLine - right.startLine || left.endLine - right.endLine || compare(JSON.stringify(left), JSON.stringify(right));
  const declarationsOf = (manifestPath: string): DependencyDeclaration[] => declarations.filter(row => row.declaringPackage === manifestPath);
  const consumers: DependencyConsumer[] = [...byPackage.entries()]
    .sort(([left], [right]) => compare(left, right))
    .map(([manifestPath, entry]) => {
      const files = [...entry.files.values()].sort((left, right) => compare(left.path, right.path)).map(file => {
        file.imports.sort(byLine);
        file.symbolReferences.sort(byLine);
        file.typeOnly = file.imports.every(row => row.typeOnly) && file.symbolReferences.every(row => row.typeOnly);
        return file;
      });
      const declared = declarationsOf(manifestPath);
      return {
        package: packageRef(manifestPath, entry.ecosystem), declared, undeclared: declared.length === 0,
        typeOnly: files.every(file => file.typeOnly), files,
      };
    });
  const consumerManifests = new Set(consumers.map(row => row.package.manifestPath));
  const declaringManifests = [...new Set(declarations.map(row => row.declaringPackage))].sort(compare);
  // A package whose only evidence was filtered out (type-only) is still not "without observed use".
  const observed = new Set([...consumerManifests, ...allImports.map(row => row.consumingPackage), ...allReferences.map(row => row.consumingPackage)]);
  const declaredWithoutObservedUse: DependencyDeclarationOnly[] = declaringManifests
    .filter(manifestPath => !observed.has(manifestPath))
    .map(manifestPath => ({ package: packageRef(manifestPath, declarationsOf(manifestPath)[0]!.ecosystem), declarations: declarationsOf(manifestPath), label: DECLARATION_ONLY_LABEL }));

  const coverage = coverageLines(facts, ecosystems, matchedNames);
  const excludedTypeOnlyImports = allImports.length - imports.length;
  const excludedTypeOnlySymbolReferences = allReferences.length - references.length;
  if (excludedTypeOnlyImports || excludedTypeOnlySymbolReferences) coverage.push(`${excludedTypeOnlyImports} type-only import(s) and ${excludedTypeOnlySymbolReferences} type-only symbol reference(s) excluded by request.`);
  const undeclared = consumers.filter(row => row.undeclared);
  if (undeclared.length) coverage.push(`${undeclared.length} consuming package(s) do not declare ${query} in their own manifest (hoisted, inherited, or missing declaration).`);
  const firstParty = facts.packages.filter(row => matchedNames.includes(row.name) && ecosystems.includes(row.ecosystem));
  for (const row of firstParty) {
    coverage.push(`${row.name} is a first-party package (${row.manifestPath}); its symbol-level use is captured as code relations in the architecture graph, not as dependency symbol references.`);
  }
  const symbolCoverage = facts.coverage.filter(row => row.evidence === 'symbolReferences' && ecosystems.includes(row.ecosystem) && row.status !== 'unavailable');
  for (const ecosystem of ecosystems) {
    if (!symbolCoverage.some(row => row.ecosystem === ecosystem)) continue;
    const ecosystemImports = allImports.filter(row => row.ecosystem === ecosystem && !row.typeOnly);
    if (ecosystemImports.length && !allReferences.some(row => row.ecosystem === ecosystem) && !firstParty.some(row => row.ecosystem === ecosystem)) {
      coverage.push(`No ${ecosystem} symbol references resolved for ${query} despite ${ecosystemImports.length} runtime import(s); the analyzer could not see its declarations (not installed, untyped, or outside analyzed targets). Import evidence stands on its own.`);
    }
  }
  const allFiles = consumers.flatMap(row => row.files);
  return {
    dependency: query, matchedNames, ecosystems, factsAvailable: true, includeTypeOnly,
    declarations: [...declarations], consumers, declaredWithoutObservedUse, coverage, suggestions: [],
    summary: {
      declarations: declarations.length,
      consumers: consumers.length,
      files: allFiles.length,
      imports: imports.length,
      typeOnlyImports: imports.filter(row => row.typeOnly).length,
      excludedTypeOnlyImports,
      symbolReferences: references.length,
      typeOnlySymbolReferences: references.filter(row => row.typeOnly).length,
      excludedTypeOnlySymbolReferences,
      calls: references.filter(row => row.kind === 'calls').length,
    },
  };
}

function coverageLines(facts: DependencyFacts, ecosystems: readonly DependencyEcosystem[], names: readonly string[]): string[] {
  const result: string[] = [];
  for (const row of facts.coverage) {
    if (!ecosystems.includes(row.ecosystem)) continue;
    const label = `${EVIDENCE_LABEL[row.evidence]} (${row.ecosystem}${row.status === 'complete' ? '' : `, ${row.status}`})`;
    if (!row.limitations.length && row.status !== 'complete') result.push(`${label}: no further detail recorded.`);
    for (const limitation of row.limitations) result.push(`${label}: ${limitation}`);
    const dropped = row.droppedByDependency.filter(item => names.includes(item.dependency));
    for (const item of dropped) result.push(`${label}: ${item.dropped} fact(s) for ${item.dependency} dropped by size caps.`);
    if (row.dropped && !dropped.length && names.length === 0) result.push(`${label}: ${row.dropped} fact(s) dropped by size caps.`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Plain-text rendering (CLI + agents)

function declarationLine(row: DependencyDeclaration): string {
  const version = row.resolution === 'resolved' ? row.resolvedVersions[0]
    : row.resolution === 'local' ? 'local'
      : row.resolution === 'ambiguous' ? `ambiguous: ${row.resolvedVersions.join(' | ')}` : 'unresolved';
  const name = row.alias ? `${row.alias} → ${row.dependency}` : row.dependency;
  const target = row.target ? ` [target ${row.target}]` : '';
  const inherited = row.workspaceInherited ? ' (workspace)' : '';
  const reason = row.reason ? ` — ${row.reason}` : '';
  const at = `${row.source.path}${row.source.line ? `:${row.source.line}` : ''}`;
  return `${name} ${row.requested || '(no spec)'}${inherited} → ${version}  ${row.section}${target}  ${at}${reason}`;
}

export function formatDependencyConsumerReport(report: DependencyConsumerReport): string {
  const out: string[] = [];
  const names = report.matchedNames.length && report.matchedNames.join(', ') !== report.dependency ? ` (matched: ${report.matchedNames.join(', ')})` : '';
  out.push(`Consumers of ${report.dependency}${names}${report.ecosystems.length ? ` [${report.ecosystems.join(', ')}]` : ''}`);
  const s = report.summary;
  out.push(`${s.consumers} consuming package(s), ${s.files} file(s), ${s.imports} import(s)${s.typeOnlyImports ? ` (${s.typeOnlyImports} type-only)` : ''}, ${s.symbolReferences} symbol reference(s) (${s.calls} call(s)${s.typeOnlySymbolReferences ? `, ${s.typeOnlySymbolReferences} type-only` : ''}), ${s.declarations} declaration(s)`);
  if (!report.factsAvailable) {
    out.push('', 'Coverage limits', ...report.coverage.map(line => `  - ${line}`));
    return `${out.map(sanitizeControlCharacters).join('\n')}\n`;
  }
  if (report.suggestions.length) out.push(`Did you mean: ${report.suggestions.join(', ')}?`);
  out.push('', 'Declarations');
  if (!report.declarations.length) out.push('  (none captured)');
  for (const row of report.declarations) out.push(`  ${declarationLine(row)}`);
  out.push('', 'Consumers');
  if (!report.consumers.length) out.push('  (no import or symbol-reference evidence)');
  for (const consumer of report.consumers) {
    const flags = [consumer.undeclared ? 'undeclared here' : '', consumer.typeOnly ? 'type-only' : ''].filter(Boolean);
    const declared = consumer.declared.length ? ` — declares ${[...new Set(consumer.declared.map(row => row.section + (row.target ? ` [${row.target}]` : '')))].join(', ')}` : '';
    out.push(`  ${consumer.package.name} (${consumer.package.manifestPath})${declared}${flags.length ? ` [${flags.join(', ')}]` : ''}`);
    for (const file of consumer.files) {
      out.push(`    ${file.path}${file.typeOnly ? '  (type-only)' : ''}`);
      const rows = [
        ...file.imports.map(row => ({ line: row.startLine, text: `${row.path}:${row.startLine}  ${row.kind === 'static' ? 'import' : row.kind}  '${row.specifier}'${row.typeOnly ? ' (type-only)' : ''}` })),
        ...file.symbolReferences.map(row => ({ line: row.startLine, text: `${row.path}:${row.startLine}  ${row.kind} ${row.symbol}${row.typeOnly ? ' (type-only)' : ''}${row.via ? `  (via ${row.via})` : ''}` })),
      ].sort((left, right) => left.line - right.line || compare(left.text, right.text));
      for (const row of rows) out.push(`      ${row.text}`);
    }
  }
  out.push('', 'Declared without observed use');
  if (!report.declaredWithoutObservedUse.length) out.push('  (none)');
  for (const row of report.declaredWithoutObservedUse) {
    out.push(`  ${row.package.name} (${row.package.manifestPath}) — ${row.label}`);
    for (const declaration of row.declarations) out.push(`    ${declarationLine(declaration)}`);
  }
  out.push('', 'Coverage limits');
  if (!report.coverage.length) out.push('  (none reported)');
  for (const line of report.coverage) out.push(`  - ${line}`);
  // Every line carries untrusted names, specs and paths: never emit raw control bytes.
  return `${out.map(sanitizeControlCharacters).join('\n')}\n`;
}
