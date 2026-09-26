import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  formatDependencyConsumerReport, parsePortableAtlas, queryDependencyConsumers, serializePortableAtlas, validateDependencyFacts,
  type DependencyFacts, type PortableAtlas,
} from "@okie/architecture";
import { analyzeTypeScript } from "./analyze-typescript.js";
import { runConsumersQuery } from "./consumers-cli.js";
import {
  buildDependencyFacts, cargoRequirementMatches, collectDependencyInputs, fitDependencyFacts, normalizeLockVersion,
  parseCargoManifest, parsePnpmLockImporters, redactSpec, stripTomlComment, type DependencyFactsInput,
} from "./dependency-facts.js";
import type { LanguageAnalysis } from "./language-analysis.js";
import { portableAtlasFromScan } from "./portable.js";
import { scanRepository } from "./scan.js";

const SHA = "a".repeat(40);
const reader = (files: Record<string, string>) => (path: string): string => {
  const text = files[path];
  if (text === undefined) throw new Error(`ENOENT ${path}`);
  return text;
};
const facts = (files: Record<string, string>, extra: Partial<DependencyFactsInput> = {}) => buildDependencyFacts({
  commitSha: SHA, sourceFiles: Object.keys(files).filter(path => /\.(rs|[cm]?[jt]sx?)$/.test(path)), readFile: reader(files), analysisMode: "quick", ...extra,
});
function tree(files: Record<string, string>, git = false): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "okie-deps-hard-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x", "--no-gpg-sign"], { cwd: root });
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const RAW_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/; // everything but \n

// --- item 1 -----------------------------------------------------------------

test("item 1: type-position and `import type` references are typeOnly and --runtime-only filters them", () => {
  const repo = tree({
    "package.json": '{"name":"app","dependencies":{"pkg":"1","other":"1"}}',
    "tsconfig.json": '{"compilerOptions":{"strict":true,"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext","types":[]},"include":["src/**/*.ts"]}',
    "node_modules/pkg/package.json": '{"name":"pkg","types":"index.d.ts"}',
    "node_modules/pkg/index.d.ts": "export interface Opts { size: number }\nexport declare function run(): void;\nexport { Thing } from 'other';\n",
    "node_modules/other/package.json": '{"name":"other","types":"index.d.ts"}',
    "node_modules/other/index.d.ts": "export interface Thing { a: number }\n",
    "src/types.ts": "import type { Opts } from 'pkg';\nexport function size(o: Opts): number { return o.size; }\n",
    "src/b.ts": "import { Thing, run } from 'pkg';\nexport const t: Thing = { a: 1 };\ntype R = typeof run;\nexport const r: R = run;\nrun();\n",
  });
  try {
    const analysis = analyzeTypeScript(repo.root);
    const rows = (analysis.externalReferences ?? []).map(row => [row.path, row.startLine, row.package, row.symbol, row.kind, row.typeOnly]);
    assert.deepEqual(rows, [
      ["src/b.ts", 2, "other", "Thing", "uses", true],
      ["src/b.ts", 3, "pkg", "run", "uses", true],
      ["src/b.ts", 4, "pkg", "run", "uses", false],
      ["src/b.ts", 5, "pkg", "run", "calls", false],
      ["src/types.ts", 2, "pkg", "Opts", "uses", true],
      ["src/types.ts", 2, "pkg", "Opts.size", "uses", true],
    ], JSON.stringify(rows));
    const dependencyFacts = buildDependencyFacts({ commitSha: SHA, sourceFiles: ["src/b.ts", "src/types.ts"], readFile: path => readFileSync(join(repo.root, path), "utf8"), analysisMode: "full", languageAnalysis: analysis });
    const all = queryDependencyConsumers(dependencyFacts, "pkg");
    const types = all.consumers[0]!.files.find(file => file.path === "src/types.ts")!;
    assert.equal(types.typeOnly, true, "import type + type-position refs make the file type-only");
    const runtime = queryDependencyConsumers(dependencyFacts, "pkg", { includeTypeOnly: false });
    const refs = runtime.consumers.flatMap(row => row.files.flatMap(file => file.symbolReferences));
    assert.deepEqual(refs.map(row => [row.path, row.startLine, row.symbol, row.typeOnly]), [["src/b.ts", 4, "run", false], ["src/b.ts", 5, "run", false]]);
    assert.ok(!runtime.consumers[0]!.files.some(file => file.path === "src/types.ts"));
    assert.equal(runtime.summary.excludedTypeOnlySymbolReferences, 3);
    assert.equal(queryDependencyConsumers(dependencyFacts, "other", { includeTypeOnly: false }).consumers.length, 0, "a type-only re-export use is not runtime");
  } finally { repo.cleanup(); }
});

// --- item 2 -----------------------------------------------------------------

test("item 2: a nested marker package.json does not own files; the nearest real package does", () => {
  const result = facts({
    "package.json": JSON.stringify({ name: "app", dependencies: { react: "^18" } }),
    "src/esm/package.json": '{"type":"module"}',
    "src/esm/a.ts": "import 'react';",
  });
  assert.deepEqual(result.packages.map(row => row.manifestPath), ["package.json"]);
  const report = queryDependencyConsumers(result, "react");
  assert.deepEqual(report.consumers.map(row => [row.package.manifestPath, row.undeclared]), [["package.json", false]]);
  assert.deepEqual(report.declaredWithoutObservedUse, []);
  // A nameless workspace member with no dependency section is still a package.
  const member = facts({ "package.json": '{"name":"root","workspaces":["apps/*"]}', "apps/x/package.json": '{"private":true}', "apps/x/a.ts": "import 'react';" }, { workspaceDirectories: ["apps/x"] });
  assert.deepEqual(member.imports.map(row => row.consumingPackage), ["apps/x/package.json"]);
});

// --- item 3 -----------------------------------------------------------------

test("item 3: a crate renamed at two versions resolves each by its requested range; an unselectable range is ambiguous", () => {
  const lock = ["[[package]]", 'name = "app"', 'version = "0.1.0"', "dependencies = [", ' "rand 0.7.3",', ' "rand 0.8.5",', "]", "",
    "[[package]]", 'name = "rand"', 'version = "0.7.3"', 'source = "registry+x"', "", "[[package]]", 'name = "rand"', 'version = "0.8.5"', 'source = "registry+x"'].join("\n");
  const result = facts({
    "Cargo.toml": '[package]\nname = "app"\n[dependencies]\nrand07 = { package = "rand", version = "0.7" }\nrand = "0.8"\n[dev-dependencies]\nrand-any = { package = "rand", version = "*" }\n',
    "Cargo.lock": lock, "src/lib.rs": "use rand07::Rng;\nuse rand::thread_rng;\n",
  });
  assert.deepEqual(result.declarations.map(row => [row.alias ?? row.dependency, row.resolution, row.resolvedVersions]), [
    ["rand", "resolved", ["0.8.5"]],
    ["rand07", "resolved", ["0.7.3"]],
    ["rand-any", "ambiguous", ["0.7.3", "0.8.5"]],
  ]);
  assert.equal(cargoRequirementMatches("0.7", "0.8.5"), false);
  assert.equal(cargoRequirementMatches("^0.7", "0.7.3"), true);
  assert.equal(cargoRequirementMatches("~1.2", "1.2.9"), true);
  assert.equal(cargoRequirementMatches(">=1, <2", "2.0.0"), false);
  assert.equal(cargoRequirementMatches("=1.2.3", "1.2.3"), true);
  assert.equal(cargoRequirementMatches("1.*", "1.9.0"), true);
  assert.equal(cargoRequirementMatches("git junk", "1.0.0"), undefined);
});

// --- item 4 -----------------------------------------------------------------

const CSI = "\u001b[31m";
const CLEAR = "\u001b[2J";
const OSC52 = "\u001b]52;c;cm0gLXJmIH4=\u0007";

function portableBundle(dependencies?: DependencyFacts): string {
  const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../fixtures/architecture/demo-${name}.json`, import.meta.url), "utf8")
    .replaceAll("golden-worktree-okie-2026-07-14-v1", SHA));
  const bundle: PortableAtlas = { format: "okie-atlas", version: 1, repository: { commitSha: SHA, treeHash: "b".repeat(40) },
    snapshot: read("snapshot"), view: read("view"), story: read("story"), stories: [], analysis: { mode: "quick", adapters: [] },
    ...(dependencies ? { dependencies } : {}) };
  return JSON.stringify(bundle);
}

test("item 4a: consumers CLI never emits raw ESC/BEL/C1 bytes for hostile names, specs and paths", () => {
  // Scanned fixture: escapes in a dependency name, a requested spec, an import specifier and a file path.
  const scanned = facts({
    "package.json": JSON.stringify({ name: "app", dependencies: { [`evil${CSI}`]: "1", x: `1.0.0${OSC52}${CLEAR}` } }),
    "a.ts": `import 'x/${CSI}red';\n`,
    [`b${CLEAR}.ts`]: "import 'x';\n",
  });
  validateDependencyFacts(scanned, SHA); // capture never produces a bundle the loader rejects
  assert.ok(!scanned.declarations.some(row => row.dependency.startsWith("evil")), "control-character name skipped at capture");
  assert.ok(!scanned.imports.some(row => row.path.startsWith("b")), "control-character path skipped at capture");
  const bundlePath = "bundle.okie.json";
  const read = (path: string) => { assert.equal(path, bundlePath); return portableBundle(scanned); };
  for (const query of ["x", `x${CSI}`, "x\u009b2J"]) {
    const text = runConsumersQuery([query, "--bundle", bundlePath], read);
    assert.doesNotMatch(text, RAW_CONTROL, `human output for ${JSON.stringify(query)}`);
    assert.ok(text.includes("\ufffd"), "neutralized escapes stay visible");
    const json = runConsumersQuery([query, "--bundle", bundlePath, "--json"], read);
    assert.doesNotMatch(json, RAW_CONTROL, `json output for ${JSON.stringify(query)}`);
    JSON.parse(json);
  }
  assert.match(runConsumersQuery(["x\u009b2J", "--bundle", bundlePath, "--json"], read), /\\u009b2J/, "C1 CSI is JSON-escaped");
  // A hand-crafted bundle carrying raw escapes is rejected at load, before any output.
  const hostile = structuredClone(scanned);
  hostile.imports[0]!.specifier = `x${OSC52}`;
  hostile.declarations[0]!.requested = `1${CSI}`;
  assert.throws(() => runConsumersQuery(["x", "--bundle", bundlePath], () => portableBundle(hostile)), /control characters/);
  // And the formatter itself neutralizes an unvalidated in-memory report.
  const text = formatDependencyConsumerReport(queryDependencyConsumers(hostile, "x"));
  assert.doesNotMatch(text, RAW_CONTROL);
});

// --- item 5 -----------------------------------------------------------------

test("item 5: redactSpec strips userinfo (incl. a raw slash), queries, credential fragments, tokens and absolute paths", () => {
  const cases: Array<[string, string]> = [
    ["https://user:s3cr3t/pa@ss@example.com/v.tgz", "https://[redacted]@example.com/v.tgz"],
    ["https://deploy:hunter2@registry.example.com/r.tgz", "https://[redacted]@registry.example.com/r.tgz"],
    ["https://npm.example.com/t.tgz?token=abc123", "https://npm.example.com/t.tgz?[redacted]"],
    ["git+https://github.com/x/y.git#token=abc", "git+https://github.com/x/y.git#[redacted]"],
    ["git+https://github.com/x/y.git#v1.2.3", "git+https://github.com/x/y.git#v1.2.3"],
    ["git+ssh://git@github.com/x/u.git", "git+ssh://git@github.com/x/u.git"],
    ["https://host:8443/a@b", "https://host:8443/a@b"],
    ["file:/Users/alice/private/pkg", "file:<absolute path>"],
    ["link:/home/alice/x", "link:<absolute path>"],
    ["path:/Users/alice/crate", "path:<absolute path>"],
    ["/opt/x", "<absolute path>"],
    ["~/x", "<absolute path>"],
    ["C:\\Users\\alice\\x", "<absolute path>"],
    ["file:../local", "file:../local"],
    ["git+https://ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@github.com/x/z.git", "git+https://[redacted]@github.com/x/z.git"],
    ["npm:left-pad@^1.3.0", "npm:left-pad@^1.3.0"],
  ];
  for (const [input, expected] of cases) assert.equal(redactSpec(input), expected, input);
  assert.deepEqual(normalizeLockVersion("https://deploy:x@registry/x.tgz"), { kind: "source" });
  assert.deepEqual(normalizeLockVersion("github.com/x/y/abc123"), { kind: "source" });
  assert.deepEqual(normalizeLockVersion("/react@18.2.0"), { kind: "version", version: "18.2.0" });
  assert.deepEqual(normalizeLockVersion("link:../x"), { kind: "local" });
});

test("item 5b: no credential, query token, absolute path or lockfile URL version reaches the serialized bundle", () => {
  const secrets = ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "s3cr3t", "pa@ss", "QUERYSECRET123", "secretuser", "LOCKSECRET", "glpat-abcdefghijklmnopqrst", "hunter2", "FRAGSECRET"];
  const repo = tree({
    "package.json": JSON.stringify({ name: "redact-demo", dependencies: {
      y: "git+https://user:ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@github.com/x/y.git",
      v: "https://user:s3cr3t/pa@ss@example.com/v.tgz",
      t: "https://npm.example.com/t.tgz?token=QUERYSECRET123",
      f: "git+https://github.com/x/f.git#auth=FRAGSECRET",
      p: "file:/Users/secretuser/private/pkg",
      l: "^1.0.0",
    } }, null, 2),
    "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/l": { version: "https://deploy:LOCKSECRET@registry.example.com/l.tgz" }, "node_modules/r": { version: "1.0.0", resolved: "https://deploy:hunter2@registry.example.com/r.tgz" } } }),
    "src/index.ts": "import y from 'y';\nimport l from 'l';\nexport const x = [y, l];\n",
    "crates/c/Cargo.toml": '[package]\nname = "c"\nversion = "0.1.0"\n\n[dependencies]\nfoo = { git = "https://oauth2:glpat-abcdefghijklmnopqrst@gitlab.com/x/foo.git", branch = "main" }\nbar = { path = "/Users/secretuser/bar" }\n',
    "crates/c/src/lib.rs": "use foo::X;\n",
  }, true);
  try {
    const artifacts = scanRepository(repo.root, { analysisMode: "quick" });
    const text = serializePortableAtlas(portableAtlasFromScan(artifacts));
    for (const secret of secrets) assert.ok(!text.includes(secret), `bundle leaks ${secret}`);
    const declarations = new Map(artifacts.dependencies.declarations.map(row => [row.alias ?? row.dependency, row]));
    assert.equal(declarations.get("v")!.requested, "https://[redacted]@example.com/v.tgz");
    assert.equal(declarations.get("p")!.requested, "file:<absolute path>");
    assert.equal(declarations.get("bar")!.requested, "path:<absolute path>");
    assert.deepEqual([declarations.get("l")!.resolution, declarations.get("l")!.resolvedVersions], ["unresolved", []], "a URL-shaped lock version is not a version");
    assert.match(declarations.get("l")!.reason!, /non-registry source/);
  } finally { repo.cleanup(); }
});

// --- item 6 -----------------------------------------------------------------

test("item 6: unowned files and cap notes are counted per ecosystem", () => {
  const result = facts({ "Cargo.toml": "[workspace]\nmembers=[]\n", "tools/x.rs": "use serde::X;", "package.json": '{"name":"a","dependencies":{"react":"1","vue":"1"}}', "a.ts": "import 'react';\nimport 'vue';\n" }, { limits: { maxImports: 1 } });
  const imports = (ecosystem: string) => result.coverage.find(row => row.ecosystem === ecosystem && row.evidence === "imports")!;
  assert.ok(imports("cargo").limitations.some(line => /1 file\(s\) with dependency evidence have no owning Cargo\.toml/.test(line)), imports("cargo").limitations.join("\n"));
  assert.ok(!imports("npm").limitations.some(line => /no owning/.test(line)), imports("npm").limitations.join("\n"));
  assert.ok(imports("npm").limitations.some(line => /Capped at 1 imports/.test(line)));
  assert.ok(!imports("cargo").limitations.some(line => /Capped/.test(line)), "cap note only where facts were dropped");
});

// --- item 7 -----------------------------------------------------------------

test("item 7: pnpm v5 peer-suffixed versions resolve to the package version", () => {
  const lock = "lockfileVersion: 5.4\n\nspecifiers:\n  react-dom: ^18\n\ndependencies:\n  react-dom: 18.2.0_react@17.0.2\n";
  assert.equal(parsePnpmLockImporters(lock).get(".")?.get("react-dom"), "18.2.0");
  assert.deepEqual(normalizeLockVersion("18.2.0_react@17.0.2"), { kind: "version", version: "18.2.0" });
  assert.deepEqual(normalizeLockVersion("1.0.0-beta.1_a@1.0.0+b@2.0.0"), { kind: "version", version: "1.0.0-beta.1" });
  const result = facts({ "package.json": JSON.stringify({ name: "a", dependencies: { "react-dom": "^18" } }), "pnpm-lock.yaml": lock, "a.ts": "import 'react-dom';" });
  assert.deepEqual(result.declarations.map(row => [row.resolution, row.resolvedVersions]), [["resolved", ["18.2.0"]]]);
});

// --- item 8 -----------------------------------------------------------------

test("item 8: invalid rows are skipped and counted; Cargo comments and multi-line tables never invent dependencies", () => {
  const manifest = parseCargoManifest([
    "[package]", 'name = "x"', "[dependencies]",
    'tokio = { version = "1", features = [', '  "rt",', '], default-features = false }',
    'foo = { version = "1",', '  package = "bar" }',
    'baz = "2" # package = "evil", version = "9"',
    'qux = { version = "3" } # git = "https://tok@example.com"',
    '"" = "1"',
  ].join("\n"));
  assert.deepEqual(manifest.entries.map(row => [row.key, row.version ?? "", row.package ?? "", row.git ?? ""]), [
    ["tokio", "1", "", ""], ["foo", "1", "bar", ""], ["baz", "2", "", ""], ["qux", "3", "", ""], ["", "1", "", ""],
  ]);
  assert.equal(stripTomlComment('a = "x # y" # z'), 'a = "x # y" ');
  for (const files of [
    { "package.json": JSON.stringify({ name: "a", dependencies: { "": "1", "ok": "1" } }), "a.ts": "import 'ok';" },
    { "Cargo.toml": '[package]\nname = "app"\n[dependencies]\n"" = "1"\n"bad name" = "1"\nok = "1"\n', "src/lib.rs": "use ok::X;" },
  ]) {
    const result = facts(files);
    validateDependencyFacts(result, SHA);
    assert.deepEqual(result.declarations.map(row => row.dependency), ["ok"]);
    const declarations = result.coverage.find(row => row.evidence === "declarations")!;
    assert.ok(declarations.limitations.some(line => /row\(s\) with invalid names or paths were skipped/.test(line)), declarations.limitations.join("\n"));
  }
});

test("item 8: the fact byte budget trims symbol references first, then imports, deterministically with counts", () => {
  const refs: NonNullable<LanguageAnalysis["externalReferences"]> = Array.from({ length: 200 }, (_, index) => ({ path: "a.ts", startLine: index + 1, endLine: index + 1, ecosystem: "npm", package: "react", symbol: `symbol${index}`, kind: "uses", analyzer: "typescript@5" }));
  const analysis: LanguageAnalysis = { schemaVersion: 1, definitions: [], references: [], modules: [], externalReferences: refs, coverage: [{ language: "typescript", tool: "typescript", version: "5", coverage: "semantic", indexedFiles: [], limitations: [] }] };
  const files = { "package.json": '{"name":"a","dependencies":{"react":"1"}}', "a.ts": Array.from({ length: 20 }, (_, index) => `import 'react/m${index}';`).join("\n") };
  const full = facts(files, { analysisMode: "full", languageAnalysis: analysis });
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  const budget = size(full) - 1;
  const fitted = fitDependencyFacts(full, budget);
  assert.ok(size(fitted) <= budget);
  assert.equal(fitted.imports.length, full.imports.length, "imports kept while references absorb the cut");
  assert.ok(fitted.symbolReferences.length < full.symbolReferences.length);
  assert.deepEqual(fitted.symbolReferences, full.symbolReferences.slice(0, fitted.symbolReferences.length), "canonical prefix kept");
  const symbols = fitted.coverage.find(row => row.ecosystem === "npm" && row.evidence === "symbolReferences")!;
  assert.equal(symbols.dropped, full.symbolReferences.length - fitted.symbolReferences.length);
  assert.ok(symbols.limitations.some(line => line.includes("dependency fact budget")));
  const tight = fitDependencyFacts(full, size({ ...full, symbolReferences: [], imports: full.imports.slice(0, 5) }) + 8192);
  assert.equal(tight.symbolReferences.length, 0);
  assert.ok(tight.imports.length < full.imports.length);
  assert.equal(tight.coverage.find(row => row.ecosystem === "npm" && row.evidence === "imports")!.dropped, full.imports.length - tight.imports.length);
  validateDependencyFacts(tight, SHA);
  assert.deepEqual(fitDependencyFacts(full, budget), fitted, "deterministic");
  assert.equal(fitDependencyFacts(full, size(full)), full, "no-op when it fits");
});

test("item 8: dependency facts never push a bundle that fit before over the limit", () => {
  const repo = tree({
    "package.json": '{"name":"fit","dependencies":{"react":"1"}}',
    "src/index.ts": Array.from({ length: 400 }, (_, index) => `import 'react/m${index}';`).join("\n") + "\nexport const x = 1;\n",
  }, true);
  try {
    const artifacts = scanRepository(repo.root, { analysisMode: "quick" });
    const withoutFacts = Buffer.byteLength(serializePortableAtlas(portableAtlasFromScan({ ...artifacts, dependencies: { ...artifacts.dependencies, imports: [], declarations: [], symbolReferences: [], packages: [], coverage: [] } })));
    const limit = withoutFacts + 30_000;
    const bundle = portableAtlasFromScan(artifacts, undefined, limit);
    const text = serializePortableAtlas(bundle);
    assert.ok(Buffer.byteLength(text) <= limit, `${Buffer.byteLength(text)} > ${limit}`);
    assert.ok(bundle.dependencies!.imports.length < artifacts.dependencies.imports.length);
    assert.ok(bundle.dependencies!.coverage.some(row => row.evidence === "imports" && row.dropped > 0));
    parsePortableAtlas(text);
    const tiny = portableAtlasFromScan(artifacts, undefined, withoutFacts + 10);
    assert.equal(tiny.dependencies, undefined, "facts are omitted rather than failing an export that fit");
  } finally { repo.cleanup(); }
});

// --- item 9 -----------------------------------------------------------------

test("item 9: manifests and lockfiles come only from inputs captured before analyzers ran", () => {
  const files: Record<string, string> = { "Cargo.toml": '[package]\nname = "app"\n[dependencies]\nrand = "0.8"\n', "src/lib.rs": "use rand::Rng;\n" };
  const inputs = collectDependencyInputs(["src/lib.rs"], reader(files));
  assert.deepEqual([...inputs.keys()], ["Cargo.toml"]);
  // An analyzer (cargo/rust-analyzer) writes Cargo.lock into the tree afterwards.
  files["Cargo.lock"] = '[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = ["rand"]\n\n[[package]]\nname = "rand"\nversion = "0.8.5"\nsource = "registry+x"\n';
  const result = facts(files, { manifestInputs: inputs });
  assert.deepEqual(result.declarations.map(row => [row.resolution, row.lockfilePath ?? "", row.reason ?? ""]), [["unresolved", "", "No committed Cargo.lock at or above this crate."]]);
});

test("item 9: quick and full scans give identical declarations for a crate with no committed Cargo.lock", { timeout: 300_000 }, () => {
  const repo = tree({
    // `itoa` is a registry crate: when cargo can reach the index it writes a Cargo.lock
    // resolving it into the acquired tree during the full scan. Offline, both modes agree trivially.
    "Cargo.toml": '[package]\nname = "nolock"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nhelper = { path = "helper" }\nitoa = "1"\n',
    "src/lib.rs": "use helper::value;\npub fn f() -> u32 { let _ = itoa::Buffer::new(); value() }\n",
    "helper/Cargo.toml": '[package]\nname = "helper"\nversion = "0.1.0"\nedition = "2021"\n',
    "helper/src/lib.rs": "pub fn value() -> u32 { 1 }\n",
  }, true);
  try {
    const quick = scanRepository(repo.root, { analysisMode: "quick" }).dependencies;
    const full = scanRepository(repo.root, { analysisMode: "full" }).dependencies;
    assert.deepEqual(full.declarations, quick.declarations);
    assert.deepEqual(full.declarations.find(row => row.dependency === "itoa")!.resolution, "unresolved");
    assert.ok(!full.declarations.some(row => row.lockfilePath === "Cargo.lock"), "an analyzer-written Cargo.lock is never cited");
  } finally { repo.cleanup(); }
});

// --- item 10 ----------------------------------------------------------------

test("item 10 (QA D2): an npm alias key and the real package name give the same consumers", () => {
  const result = facts({ "package.json": JSON.stringify({ name: "a", dependencies: { s: "npm:left-pad@^1.3.0" } }), "a.ts": "import s from 's';\nexport default s;\n" });
  assert.deepEqual(result.imports.map(row => [row.dependency, row.specifier]), [["left-pad", "s"]]);
  const byAlias = queryDependencyConsumers(result, "s");
  const byName = queryDependencyConsumers(result, "left-pad");
  assert.deepEqual(byAlias.consumers, byName.consumers);
  assert.equal(byAlias.consumers.length, 1);
  assert.deepEqual(byAlias.declaredWithoutObservedUse, []);
});

// --- honesty polish -------------------------------------------------------------

test("polish: declarations are partial by construction; no installation means npm references unavailable", () => {
  const result = facts({ "package.json": '{"name":"a","dependencies":{"x":"1"}}', "a.ts": "import 'x';" });
  const declarations = result.coverage.find(row => row.ecosystem === "npm" && row.evidence === "declarations")!;
  assert.equal(declarations.status, "partial");
  assert.ok(declarations.limitations.some(line => /Partial by construction/.test(line)));
  const analysis = (limitations: string[]): LanguageAnalysis => ({ schemaVersion: 1, definitions: [], references: [], modules: [], externalReferences: [], coverage: [{ language: "typescript", tool: "typescript", version: "5", coverage: "semantic", indexedFiles: [], limitations }] });
  for (const limitations of [[], ["No local dependency installation found; npm symbol references unavailable."]]) {
    const full = facts({ "package.json": '{"name":"a","dependencies":{"x":"1"}}', "a.ts": "import 'x';" }, { analysisMode: "full", languageAnalysis: analysis(limitations) });
    const npm = full.coverage.find(row => row.ecosystem === "npm" && row.evidence === "symbolReferences")!;
    assert.equal(npm.status, "unavailable");
    assert.ok(npm.limitations.includes("No local dependency installation found; npm symbol references unavailable."), npm.limitations.join("\n"));
    assert.ok(!npm.limitations.some(line => /Installed dependency types reused/.test(line)));
  }
});

test("polish: dependency context reports a missing installation instead of claiming reuse", () => {
  const repo = tree({ "committed/package.json": '{"name":"a","dependencies":{"x":"1"}}', "committed/a.ts": "import { v } from 'x'; export const y = v;\n", "working/package.json": '{"name":"a","dependencies":{"x":"1"}}' });
  try {
    const analysis = analyzeTypeScript(join(repo.root, "committed"), ["a.ts"], join(repo.root, "working"));
    const limits = analysis.coverage.flatMap(row => row.limitations);
    assert.ok(limits.includes("No local dependency installation found; npm symbol references unavailable."), limits.join("\n"));
    assert.ok(!limits.some(line => /Installed dependency types reused/.test(line)));
  } finally { repo.cleanup(); }
});

test("polish: tsconfig paths aliases that look like bare specifiers are skipped unless declared", () => {
  const result = facts({
    "package.json": '{"name":"a","dependencies":{"@real/pkg":"1"}}',
    "tsconfig.json": '{\n  // comments are allowed\n  "compilerOptions": { "paths": { "@lib/*": ["src/lib/*"], "@real/*": ["src/real/*"], "utils": ["src/utils.ts"] } }\n}',
    "src/a.ts": "import '@lib/x';\nimport 'utils';\nimport '@real/pkg';\nimport 'react';\n",
  });
  assert.deepEqual(result.imports.map(row => row.specifier), ["@real/pkg", "react"]);
  const imports = result.coverage.find(row => row.ecosystem === "npm" && row.evidence === "imports")!;
  assert.ok(imports.limitations.some(line => /2 import\(s\) matched a tsconfig paths alias/.test(line)), imports.limitations.join("\n"));
});

test("polish: Rust limits are stated and raw identifiers are normalized", () => {
  const result = facts({ "Cargo.toml": '[package]\nname = "app"\n[dependencies]\nmd-5 = "0.10"\nasync = "1"\n', "src/lib.rs": "use md5::Digest;\nuse r#async::X;\n" });
  assert.deepEqual(result.imports.map(row => row.dependency), ["async"]);
  const imports = result.coverage.find(row => row.ecosystem === "cargo" && row.evidence === "imports")!;
  assert.ok(imports.limitations.some(line => /md-5 → md5/.test(line) && /extern crate x as y/.test(line)));
});

test("polish: symbol references differing only by analyzer/version/typeOnly are not collapsed", () => {
  const base = { path: "a.ts", startLine: 1, endLine: 1, ecosystem: "npm" as const, package: "react", symbol: "X", kind: "uses" as const };
  const analysis: LanguageAnalysis = { schemaVersion: 1, definitions: [], references: [], modules: [], coverage: [{ language: "typescript", tool: "typescript", version: "5", coverage: "semantic", indexedFiles: [], limitations: [] }],
    externalReferences: [{ ...base, analyzer: "typescript@5" }, { ...base, analyzer: "typescript@6" }, { ...base, analyzer: "typescript@5", typeOnly: true }, { ...base, analyzer: "typescript@5" }] };
  const result = facts({ "package.json": '{"name":"a","dependencies":{"react":"1"}}', "a.ts": "import 'react';" }, { analysisMode: "full", languageAnalysis: analysis });
  assert.equal(result.symbolReferences.length, 3);
});
