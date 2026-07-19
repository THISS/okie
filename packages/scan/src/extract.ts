import ts from "typescript";
import type {
  ArchitectureExtraction,
  ArchitectureExtractionEntity,
  ArchitectureExtractionEntityKind,
  ArchitectureExtractionEvidence,
  ArchitectureExtractionRelation,
  ArchitectureExtractionSourceRef,
} from "@okie/architecture";
import type { Discovery } from "./discover.js";
import { resolveCollisions, typedId } from "./ids.js";

/** Max import sites retained as evidence on one aggregated relation. */
const MAX_EVIDENCE_PER_RELATION = 24;

/**
 * How many externalSystem entities the deterministic scan emits — the top-N most-imported
 * third-party runtime dependencies. Kept small so the L1 system-context band stays legible
 * (the hand-authored golden fixture carries ~3 context nodes); selection is deterministic by
 * (import-site count desc, package name asc). Bumping this only widens the context band.
 */
export const MAX_EXTERNAL_SYSTEMS = 8;

/** Cap on evidence anchors carried by one externalSystem entity (declaration + import sites). */
const MAX_EXTERNAL_SOURCE_REFS = 12;

export interface TopLevelDeclaration {
  name: string;
  startLine: number;
  endLine: number;
  /** Exported from its module (direct modifier, `export {…}` list, `export default`/`export =`). */
  exported: boolean;
}

export interface ModuleImport {
  specifier: string;
  startLine: number;
  endLine: number;
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".mjs") || path.endsWith(".cjs") || path.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS; // .ts, .mts, .cts
}

export function parseSource(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
}

/** Local names exported indirectly: `export { a, b as c }` (no specifier), `export default x`, `export = x`. */
function indirectlyExportedNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier
      && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        names.add((element.propertyName ?? element.name).text);
      }
    } else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      names.add(statement.expression.text);
    }
  }
  return names;
}

function hasExportModifier(statement: ts.Statement): boolean {
  return ts.canHaveModifiers(statement)
    ? (ts.getModifiers(statement) ?? []).some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
    : false;
}

/**
 * Every top-level named declaration — exported OR not. Non-exported top-level
 * symbols matter: e.g. `CanvasViewport` in App.tsx is a local function yet a
 * pinned golden anchor, so an exports-only walk would under-report. Each
 * declaration carries `exported` so a public-API scan (`codeSurface: 'public'`)
 * can keep only the module's export surface.
 */
export function topLevelDeclarations(sourceFile: ts.SourceFile): TopLevelDeclaration[] {
  const declarations: TopLevelDeclaration[] = [];
  const indirect = indirectlyExportedNames(sourceFile);
  const lineOf = (position: number): number => sourceFile.getLineAndCharacterOfPosition(position).line + 1;
  const push = (name: string, node: ts.Node, direct: boolean): void => {
    declarations.push({
      name,
      startLine: lineOf(node.getStart(sourceFile)),
      endLine: lineOf(node.getEnd()),
      exported: direct || indirect.has(name),
    });
  };
  for (const statement of sourceFile.statements) {
    const direct = hasExportModifier(statement);
    if (ts.isFunctionDeclaration(statement) && statement.name) push(statement.name.text, statement, direct);
    else if (ts.isClassDeclaration(statement) && statement.name) push(statement.name.text, statement, direct);
    else if (ts.isInterfaceDeclaration(statement)) push(statement.name.text, statement, direct);
    else if (ts.isTypeAliasDeclaration(statement)) push(statement.name.text, statement, direct);
    else if (ts.isEnumDeclaration(statement)) push(statement.name.text, statement, direct);
    else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) push(statement.name.text, statement, direct);
    else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) push(declaration.name.text, declaration, direct);
      }
    }
  }
  return declarations;
}

/** Static `import ... from` and `export ... from` module specifiers with line spans. */
export function moduleImports(sourceFile: ts.SourceFile): ModuleImport[] {
  const imports: ModuleImport[] = [];
  const lineOf = (position: number): number => sourceFile.getLineAndCharacterOfPosition(position).line + 1;
  for (const statement of sourceFile.statements) {
    let specifier: ts.Expression | undefined;
    if (ts.isImportDeclaration(statement)) specifier = statement.moduleSpecifier;
    else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) specifier = statement.moduleSpecifier;
    if (specifier && ts.isStringLiteral(specifier)) {
      imports.push({
        specifier: specifier.text,
        startLine: lineOf(statement.getStart(sourceFile)),
        endLine: lineOf(statement.getEnd()),
      });
    }
  }
  return imports;
}

function normalizeRepoPath(baseDir: string, relative: string): string {
  const parts = (baseDir ? baseDir.split("/") : []).concat(relative.split("/"));
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

function relativeCandidates(base: string): string[] {
  const out: string[] = [];
  const add = (candidate: string): void => { if (!out.includes(candidate)) out.push(candidate); };
  const extMatch = /\.(js|jsx|mjs|cjs|ts|tsx)$/.exec(base);
  if (extMatch) {
    const stem = base.slice(0, base.length - extMatch[0].length);
    add(`${stem}.ts`);
    add(`${stem}.tsx`);
    add(`${stem}.mjs`);
    add(base);
  } else {
    add(`${base}.ts`);
    add(`${base}.tsx`);
    add(`${base}.mjs`);
    add(`${base}/index.ts`);
    add(`${base}/index.tsx`);
  }
  return out;
}

/** Resolves a relative specifier to a discovered source file, or undefined. */
export function resolveRelativeImport(fromFile: string, specifier: string, fileSet: ReadonlySet<string>): string | undefined {
  const baseDir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
  const base = normalizeRepoPath(baseDir, specifier);
  return relativeCandidates(base).find(candidate => fileSet.has(candidate));
}

/** Maps a bare `@okie/*` specifier to the owning workspace-member unit dir, or undefined. */
export function resolvePackageImport(specifier: string, unitByPackageName: ReadonlyMap<string, string>): string | undefined {
  for (const [name, dir] of unitByPackageName) {
    if (specifier === name || specifier.startsWith(`${name}/`)) return dir;
  }
  return undefined;
}

/**
 * The npm package name a bare specifier belongs to: `react` and `react-dom/client` map to
 * `react`/`react-dom`; `@scope/pkg/sub` collapses to `@scope/pkg`. Relative specifiers and
 * anything without a name return undefined. Node builtins (`node:fs`, `fs`) fall out later —
 * they are never declared as runtime dependencies, so the allowlist filter drops them.
 */
export function packageNameOfSpecifier(specifier: string): string | undefined {
  if (!specifier || specifier.startsWith(".")) return undefined;
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope && name ? `${scope}/${name}` : undefined;
  }
  const slash = specifier.indexOf("/");
  const name = slash === -1 ? specifier : specifier.slice(0, slash);
  return name || undefined;
}

/**
 * 1-based line numbers of each key inside a package.json `"dependencies"` object (best-effort
 * evidence anchoring; membership itself comes from JSON.parse). Scans only within the
 * dependencies block via brace depth so a name that also appears under devDependencies is not
 * mis-anchored. Keys absent from the map simply anchor the manifest path with no line.
 */
export function runtimeDependencyLines(manifestText: string): Map<string, number> {
  const lines = manifestText.split(/\r?\n/);
  const result = new Map<string, number>();
  let inside = false;
  let depth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const startsHere = !inside && /^\s*"dependencies"\s*:\s*\{/.test(line);
    if (startsHere) inside = true;
    if (!inside) continue;
    for (const character of line) {
      if (character === "{") depth += 1;
      else if (character === "}") depth -= 1;
    }
    if (!startsHere) {
      const match = /^\s*"([^"]+)"\s*:/.exec(line);
      if (match) result.set(match[1]!, index + 1);
    }
    if (depth <= 0) inside = false;
  }
  return result;
}

interface EntityDescriptor {
  naturalKey: string;
  desiredId: string;
  kind: ArchitectureExtractionEntityKind;
  name: string;
  parentKey?: string;
  sourceRefs: ArchitectureExtractionSourceRef[];
}

interface RelationDescriptor {
  naturalKey: string;
  desiredId: string;
  fromKey: string;
  toKey: string;
  evidence: ArchitectureExtractionEvidence[];
}

export interface ExtractInput {
  discovery: Discovery;
  readFile: (repoRelativePath: string) => string;
  systemName?: string;
  systemSlug?: string;
  /**
   * Which top-level declarations become L4 code entities. 'all' (default) keeps every
   * top-level declaration — required for the Okie self-scan's golden-anchor coverage.
   * 'public' keeps only the module's export surface: the readable public API of the
   * repo, with private helpers left to the file card (the hosted paste-a-repo posture).
   */
  codeSurface?: "all" | "public";
}

function finalizeEvidence(evidence: readonly ArchitectureExtractionEvidence[]): ArchitectureExtractionEvidence[] {
  const byKey = new Map<string, ArchitectureExtractionEvidence>();
  for (const item of evidence) {
    const source = item.source;
    const key = `${source.path} ${source.startLine ?? ""} ${source.endLine ?? ""}`;
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return [...byKey.values()]
    .sort((left, right) =>
      left.source.path.localeCompare(right.source.path) || (left.source.startLine ?? 0) - (right.source.startLine ?? 0))
    .slice(0, MAX_EVIDENCE_PER_RELATION);
}

interface ExternalEmitInput {
  discovery: Discovery;
  readFile: (repoRelativePath: string) => string;
  externalUsagesByPackage: ReadonlyMap<string, Array<{ container: string; source: ArchitectureExtractionSourceRef }>>;
  entityDescriptors: EntityDescriptor[];
  addRelation: (fromKey: string, toKey: string, desiredId: string, naturalKey: string, evidence: ArchitectureExtractionEvidence) => void;
}

/** package.json manifests that declare runtime deps: the root plus every workspace member. */
function dependencyManifestPaths(discovery: Discovery): string[] {
  const memberManifests = discovery.units
    .filter(unit => unit.kind === "member")
    .map(unit => `${unit.dir}/package.json`)
    .sort();
  return ["package.json", ...memberManifests];
}

/**
 * Aggregates third-party import usage into the top-N externalSystem entities plus
 * container→externalSystem relations. The allowlist is the union of every manifest's runtime
 * `dependencies` (NOT devDependencies) — so a bare import counts only if its package is a
 * declared runtime dependency, which drops node builtins, dev/type-only tooling, and
 * first-party `@okie/*` packages. Selection is deterministic: (import-site count desc, name asc).
 * At L1 the container→external edges collapse to system→external; at L2 they attribute the
 * dependency to the specific container that imports it. Rust crate dependencies (Cargo.toml,
 * e.g. wgpu) are a documented follow-up — R1 does not parse `.rs`, so there is no import evidence.
 */
function emitExternalSystems(input: ExternalEmitInput): void {
  const { discovery, readFile, externalUsagesByPackage, entityDescriptors, addRelation } = input;

  // Declared runtime dependencies (name -> its declaration site(s), best-effort line anchored).
  const declaringRefsByPackage = new Map<string, ArchitectureExtractionSourceRef[]>();
  for (const manifestPath of dependencyManifestPaths(discovery)) {
    let text: string;
    try { text = readFile(manifestPath); } catch { continue; }
    let names: string[];
    try {
      const deps = ((JSON.parse(text) as { dependencies?: Record<string, unknown> }).dependencies) ?? {};
      // Local protocols (`workspace:`, `file:`, `link:`) mark first-party packages — never external,
      // even when they ship no container of their own (e.g. a CSS-only workspace member).
      names = Object.entries(deps)
        .filter(([, spec]) => !/^(workspace|file|link):/.test(String(spec)))
        .map(([name]) => name);
    } catch { continue; }
    const lines = runtimeDependencyLines(text);
    for (const name of names) {
      const line = lines.get(name);
      const ref: ArchitectureExtractionSourceRef = line !== undefined
        ? { path: manifestPath, startLine: line, endLine: line }
        : { path: manifestPath };
      const bucket = declaringRefsByPackage.get(name) ?? [];
      bucket.push(ref);
      declaringRefsByPackage.set(name, bucket);
    }
  }

  // Rank the actually-imported runtime deps and keep the top-N (deterministic tie-break by name).
  const selected = [...externalUsagesByPackage.entries()]
    .filter(([pkg]) => declaringRefsByPackage.has(pkg) && !discovery.unitByPackageName.has(pkg))
    .sort(([leftPkg, leftUses], [rightPkg, rightUses]) =>
      rightUses.length - leftUses.length || leftPkg.localeCompare(rightPkg))
    .slice(0, MAX_EXTERNAL_SYSTEMS);

  for (const [pkg, usages] of selected) {
    const importRefs = usages.map(usage => usage.source)
      .sort((left, right) => left.path.localeCompare(right.path) || (left.startLine ?? 0) - (right.startLine ?? 0));
    const declRefs = (declaringRefsByPackage.get(pkg) ?? []).slice()
      .sort((left, right) => left.path.localeCompare(right.path));
    // Manifest declaration(s) first (grounds "why it is a dependency"), then import sites; capped.
    const seen = new Set<string>();
    const sourceRefs: ArchitectureExtractionSourceRef[] = [];
    for (const ref of [...declRefs, ...importRefs]) {
      const key = `${ref.path} ${ref.startLine ?? ""} ${ref.endLine ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sourceRefs.push(ref);
      if (sourceRefs.length >= MAX_EXTERNAL_SOURCE_REFS) break;
    }
    entityDescriptors.push({
      naturalKey: `ext:${pkg}`,
      desiredId: typedId("external", pkg),
      kind: "externalSystem",
      name: pkg,
      // No parentId: external systems are top-level system context (the extraction gate requires it).
      sourceRefs,
    });

    // One container→external relation per importing container; evidence = that container's imports.
    const byContainer = new Map<string, ArchitectureExtractionEvidence[]>();
    for (const usage of usages) {
      const bucket = byContainer.get(usage.container) ?? [];
      bucket.push({ source: usage.source });
      byContainer.set(usage.container, bucket);
    }
    for (const container of [...byContainer.keys()].sort()) {
      for (const evidence of byContainer.get(container)!) {
        addRelation(container, `ext:${pkg}`, typedId("relation", container, pkg), `ext:${container}->${pkg}`, evidence);
      }
    }
  }
}

/**
 * Deterministic syntax-level extraction: system → containers (workspace members,
 * tooling, opaque Rust crates) → components (one per source file) → code (one per
 * top-level declaration). Relations come from static import/export specifiers.
 * Output is independent of file discovery order.
 */
export function extractArchitecture(input: ExtractInput): ArchitectureExtraction {
  const { discovery, readFile } = input;
  const fileSet = new Set(discovery.sourceFiles);
  const systemName = input.systemName ?? "Okie";
  const systemSlug = input.systemSlug ?? systemName;

  let systemSourceRefs: ArchitectureExtractionSourceRef[] = [];
  try {
    readFile("README.md");
    systemSourceRefs = [{ path: "README.md" }];
  } catch {
    systemSourceRefs = [];
  }

  const entityDescriptors: EntityDescriptor[] = [];
  entityDescriptors.push({
    naturalKey: "system",
    desiredId: typedId("system", systemSlug),
    kind: "softwareSystem",
    name: systemName,
    sourceRefs: systemSourceRefs,
  });
  for (const unit of discovery.units) {
    entityDescriptors.push({
      naturalKey: unit.dir,
      desiredId: typedId("container", unit.dir),
      kind: "container",
      name: unit.name,
      parentKey: "system",
      sourceRefs: [{ path: unit.evidencePath }],
    });
  }

  const relationDescriptors = new Map<string, RelationDescriptor>();
  const addRelation = (
    fromKey: string,
    toKey: string,
    desiredId: string,
    naturalKey: string,
    evidence: ArchitectureExtractionEvidence,
  ): void => {
    let descriptor = relationDescriptors.get(naturalKey);
    if (!descriptor) {
      descriptor = { naturalKey, desiredId, fromKey, toKey, evidence: [] };
      relationDescriptors.set(naturalKey, descriptor);
    }
    descriptor.evidence.push(evidence);
  };

  // Per third-party package: every static import site + the container it lives in. Aggregated
  // after the walk into top-N externalSystem entities (see below).
  const externalUsagesByPackage = new Map<string, Array<{ container: string; source: ArchitectureExtractionSourceRef }>>();

  for (const file of discovery.sourceFiles) {
    const unitDir = discovery.unitByFile.get(file)!;
    entityDescriptors.push({
      naturalKey: file,
      desiredId: typedId("component", file),
      kind: "component",
      name: file,
      parentKey: unitDir,
      sourceRefs: [{ path: file }],
    });

    const sourceFile = parseSource(file, readFile(file));
    const declarations = input.codeSurface === "public"
      ? topLevelDeclarations(sourceFile).filter(declaration => declaration.exported)
      : topLevelDeclarations(sourceFile);
    declarations.forEach((declaration, index) => {
      entityDescriptors.push({
        naturalKey: `${file}#${index}`,
        desiredId: typedId("code", file, declaration.name),
        kind: "code",
        name: declaration.name,
        parentKey: file,
        sourceRefs: [{ path: file, symbol: declaration.name, startLine: declaration.startLine, endLine: declaration.endLine }],
      });
    });

    for (const dependency of moduleImports(sourceFile)) {
      const evidence: ArchitectureExtractionEvidence = {
        source: { path: file, startLine: dependency.startLine, endLine: dependency.endLine },
      };
      if (dependency.specifier.startsWith(".")) {
        const target = resolveRelativeImport(file, dependency.specifier, fileSet);
        if (target && target !== file) {
          addRelation(file, target, typedId("relation", file, target), `comp:${file}->${target}`, evidence);
        }
      } else {
        const targetUnit = resolvePackageImport(dependency.specifier, discovery.unitByPackageName);
        if (targetUnit) {
          if (targetUnit !== unitDir) {
            addRelation(unitDir, targetUnit, typedId("relation", unitDir, targetUnit), `unit:${unitDir}->${targetUnit}`, evidence);
          }
        } else {
          // Bare specifier that is not a workspace package: a candidate third-party import.
          const pkg = packageNameOfSpecifier(dependency.specifier);
          if (pkg) {
            const usages = externalUsagesByPackage.get(pkg) ?? [];
            usages.push({ container: unitDir, source: evidence.source });
            externalUsagesByPackage.set(pkg, usages);
          }
        }
      }
    }
  }

  emitExternalSystems({ discovery, readFile, externalUsagesByPackage, entityDescriptors, addRelation });

  // Assign collision-free IDs in a fully canonical order (independent of discovery order).
  const sortedEntities = [...entityDescriptors].sort((left, right) =>
    left.desiredId.localeCompare(right.desiredId) || left.naturalKey.localeCompare(right.naturalKey));
  const entityIds = resolveCollisions(sortedEntities.map(descriptor => descriptor.desiredId));
  const idByKey = new Map(sortedEntities.map((descriptor, index) => [descriptor.naturalKey, entityIds[index]!]));

  const entities: ArchitectureExtractionEntity[] = sortedEntities.map((descriptor, index) => ({
    id: entityIds[index]!,
    kind: descriptor.kind,
    ...(descriptor.parentKey !== undefined ? { parentId: idByKey.get(descriptor.parentKey)! } : {}),
    name: descriptor.name,
    sourceRefs: descriptor.sourceRefs,
  }));

  const sortedRelations = [...relationDescriptors.values()].sort((left, right) =>
    left.desiredId.localeCompare(right.desiredId) || left.naturalKey.localeCompare(right.naturalKey));
  const relationIds = resolveCollisions(sortedRelations.map(descriptor => descriptor.desiredId));
  const relations: ArchitectureExtractionRelation[] = sortedRelations.map((descriptor, index) => ({
    id: relationIds[index]!,
    from: idByKey.get(descriptor.fromKey)!,
    to: idByKey.get(descriptor.toKey)!,
    kind: "dependsOn",
    evidence: finalizeEvidence(descriptor.evidence),
  }));

  return {
    schemaVersion: 1,
    entities: entities.sort((left, right) => left.id.localeCompare(right.id)),
    relations: relations.sort((left, right) => left.id.localeCompare(right.id)),
  };
}
