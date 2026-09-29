import assert from "node:assert/strict";
import test from "node:test";
import type { ArchitectureEntity, ArchitectureRelation, ArchitectureSnapshot } from "@okie/architecture";
import { computeIncrementalImpact, entitySignature, type IncrementalImpact } from "./incrementalImpact.js";

/* Hand-built snapshots shaped like a real `scanRepository` result (ids, sourceRefs, excerpts, exposure, relations). */
interface Symbol { name: string; start: number; text: string; exported?: boolean }
type Files = Record<string, Symbol[]>;
type Edge = [from: string, to: string, kind: ArchitectureRelation["kind"]];
const slug = (value: string) => value.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase();
const componentId = (path: string) => `component:${slug(path)}`;
const codeId = (path: string, name: string) => `code:${slug(path)}:${slug(name)}`;

function snapshot(sha: string, files: Files, edges: Edge[]): ArchitectureSnapshot {
  const entities: ArchitectureEntity[] = [
    { id: "system:demo", kind: "softwareSystem", name: "Demo", technology: ["TypeScript"], sourceRefs: [{ path: "README.md", commitSha: sha }] },
    { id: "container:demo-lib", kind: "container", parentId: "system:demo", name: "demo-lib", technology: ["TypeScript"], sourceRefs: [{ path: "package.json", commitSha: sha }] },
  ];
  for (const [path, symbols] of Object.entries(files)) {
    entities.push({ id: componentId(path), kind: "component", parentId: "container:demo-lib", name: path, technology: ["TypeScript"], sourceRefs: [{ path, commitSha: sha }] });
    for (const symbol of symbols) {
      const lines = symbol.text.split("\n"); const end = symbol.start + lines.length - 1;
      const source = { path, commitSha: sha, symbol: symbol.name, startLine: symbol.start, endLine: end };
      entities.push({
        id: codeId(path, symbol.name), kind: "code", parentId: componentId(path), name: symbol.name, sourceRefs: [source],
        ...(symbol.exported !== false ? { exposure: [{ kind: "moduleExport" as const, evidence: { source, reason: "declared module export" } }] } : {}),
        sourceExcerpts: [{ path, symbol: symbol.name, language: "typescript", startLine: symbol.start, endLine: end, sourceStartLine: symbol.start, sourceEndLine: end, highlightLine: symbol.start, frozenRevision: sha, lines, text: symbol.text }],
      });
    }
  }
  // Relation ids are numbered differently per snapshot on purpose: the diff must key on (from, to, kind) only.
  const relations: ArchitectureRelation[] = edges.map(([from, to, kind], index) => ({ id: `relation:${sha.slice(0, 1)}${edges.length - index}`, from, to, kind, evidence: [{ source: { path: "src/x.ts", commitSha: sha } }] }));
  return { schemaVersion: 1, id: `snapshot:demo:${sha.slice(0, 12)}`, repositoryId: "demo", commitSha: sha, generatedAt: `2026-09-${sha === A ? "01" : "02"}T00:00:00.000Z`, entities, relations };
}

const A = "a".repeat(40); const B = "b".repeat(40);
const add = (start = 1, body = "return a + b;", exported = true): Symbol => ({ name: "add", start, exported, text: `${exported ? "export " : ""}function add(a: number, b: number): number {\n  ${body}\n}` });
const mul = (start = 5): Symbol => ({ name: "mul", start, text: "export function mul(a: number, b: number): number {\n  return a * b;\n}" });
const run = (body = "return add(1, 2);"): Symbol => ({ name: "run", start: 3, text: `export function run(): number {\n  ${body}\n}` });
const log = (body = "console.log(mul(2, 3));"): Symbol => ({ name: "log", start: 3, text: `export function log(): void {\n  ${body}\n}` });
const cli: Symbol = { name: "cli", start: 3, text: "export function cli(): void {\n  run();\n}" };
const baseFiles = (): Files => ({ "src/util.ts": [add(), mul()], "src/main.ts": [run()], "src/log.ts": [log()], "src/cli.ts": [cli] });

const SYSTEM = "system:demo"; const CONTAINER = "container:demo-lib";
const UTIL = componentId("src/util.ts"); const MAIN = componentId("src/main.ts"); const LOG = componentId("src/log.ts"); const CLI = componentId("src/cli.ts"); const MATH = componentId("src/math.ts");
const ADD = codeId("src/util.ts", "add"); const MUL = codeId("src/util.ts", "mul"); const RUN = codeId("src/main.ts", "run"); const LOGFN = codeId("src/log.ts", "log"); const CLIFN = codeId("src/cli.ts", "cli");
const baseEdges = (): Edge[] => [[MAIN, UTIL, "dependsOn"], [RUN, ADD, "calls"], [LOG, UTIL, "dependsOn"], [LOGFN, MUL, "calls"], [CLI, MAIN, "dependsOn"], [CLIFN, RUN, "calls"]];
const base = () => snapshot(A, baseFiles(), baseEdges());

/** Asserts the exact partition; every in-cap scope is in exactly one of dirty, stale, reused. */
function expectSets(impact: IncrementalImpact, expected: { dirty: string[]; stale: Array<[string, "dependency-internal" | "moved"]>; reused: string[]; removed?: string[] }) {
  assert.deepEqual(impact.dirty, [...expected.dirty].sort(), "dirty");
  assert.deepEqual(impact.stale.map(item => [item.scopeId, item.reason]), [...expected.stale].sort((left, right) => left[0] < right[0] ? -1 : 1), "stale");
  assert.deepEqual(impact.reused, [...expected.reused].sort(), "reused");
  assert.deepEqual(impact.removed, [...(expected.removed ?? [])].sort(), "removed");
  const all = [...impact.dirty, ...impact.stale.map(item => item.scopeId), ...impact.reused];
  assert.equal(new Set(all).size, all.length, "dirty, stale and reused are disjoint");
}

test("incremental impact: identical content at a new commit is fully reused (commit, generatedAt and relation ids ignored)", () => {
  const impact = computeIncrementalImpact({ previous: base(), next: snapshot(B, baseFiles(), baseEdges()), cap: "component" });
  assert.deepEqual(impact.diff, { added: [], removed: [], changed: [], moved: [], relationsAdded: [], relationsRemoved: [], removedExports: [] });
  expectSets(impact, { dirty: [], stale: [], reused: [SYSTEM, CONTAINER, UTIL, MAIN, LOG, CLI] });
  assert.deepEqual(impact.seeds, []);
});

test("incremental impact: a moved-only line shift is moved, not changed, and marks the owning in-cap scope stale", () => {
  const files = { ...baseFiles(), "src/util.ts": [add(2), mul(6)] };
  const component = computeIncrementalImpact({ previous: base(), next: snapshot(B, files, baseEdges()), cap: "component" });
  assert.deepEqual(component.diff.moved.map(item => item.id), [ADD, MUL]);
  assert.deepEqual(component.diff.changed, []);
  expectSets(component, { dirty: [], stale: [[UTIL, "moved"]], reused: [SYSTEM, CONTAINER, MAIN, LOG, CLI] });
  const code = computeIncrementalImpact({ previous: base(), next: snapshot(B, files, baseEdges()), cap: "code" });
  expectSets(code, { dirty: [], stale: [[ADD, "moved"], [MUL, "moved"]], reused: [SYSTEM, CONTAINER, UTIL, MAIN, RUN, LOG, LOGFN, CLI, CLIFN] });
});

test("incremental impact: an internal-only change lands its consumers (of the symbol and of its module) in stale, not dirty", () => {
  const files = { ...baseFiles(), "src/util.ts": [add(1, "return b + a;"), mul()] };
  const component = computeIncrementalImpact({ previous: base(), next: snapshot(B, files, baseEdges()), cap: "component" });
  assert.deepEqual(component.diff.changed, [{ id: ADD, kind: "code", name: "add", change: "internal" }]);
  // log.ts imports util.ts (a file-level dependsOn into add's module): it cites util's behaviour, so it is re-checked too.
  expectSets(component, { dirty: [UTIL, CONTAINER, SYSTEM], stale: [[MAIN, "dependency-internal"], [LOG, "dependency-internal"]], reused: [CLI] });
  assert.deepEqual(component.seeds, [UTIL], "a below-cap symbol maps to its component");
  const code = computeIncrementalImpact({ previous: base(), next: snapshot(B, files, baseEdges()), cap: "code" });
  expectSets(code, { dirty: [ADD, UTIL, CONTAINER, SYSTEM], stale: [[RUN, "dependency-internal"], [MAIN, "dependency-internal"], [LOG, "dependency-internal"]], reused: [MUL, LOGFN, CLI, CLIFN] });
});

test("incremental impact: a removed export with consumers re-enriches every consumer (module importers included)", () => {
  // mul is deleted and log.ts stops calling it in the same commit.
  const files = { ...baseFiles(), "src/util.ts": [add()], "src/log.ts": [log("console.log(2 * 3);")] };
  const edges = baseEdges().filter(([from]) => from !== LOG && from !== LOGFN);
  const impact = computeIncrementalImpact({ previous: base(), next: snapshot(B, files, edges), cap: "component" });
  assert.deepEqual(impact.diff.removed.map(item => item.id), [MUL]);
  assert.deepEqual(impact.diff.removedExports, [{ id: MUL, kind: "code", name: "mul", consumers: [LOGFN, LOG, MAIN].sort() }]);
  assert.deepEqual(impact.diff.changed, [{ id: LOGFN, kind: "code", name: "log", change: "internal" }]);
  assert.deepEqual(impact.diff.relationsRemoved, [{ from: LOGFN, to: MUL, kind: "calls" }, { from: LOG, to: UTIL, kind: "dependsOn" }]);
  expectSets(impact, { dirty: [UTIL, LOG, MAIN, CONTAINER, SYSTEM], stale: [], reused: [CLI], removed: [MUL] });
});

test("incremental impact: a surface change (signature) dirties its 1-hop consumers; an export dropped in place is a removed export", () => {
  const files = { ...baseFiles(), "src/util.ts": [add(1, "return a + b;", false), mul()] };
  const impact = computeIncrementalImpact({ previous: base(), next: snapshot(B, files, baseEdges()), cap: "code" });
  assert.deepEqual(impact.diff.changed, [{ id: ADD, kind: "code", name: "add", change: "surface" }]);
  assert.deepEqual(impact.diff.removedExports.map(item => [item.id, item.consumers]), [[ADD, [RUN, MAIN, LOG].sort()]]);
  expectSets(impact, { dirty: [ADD, RUN, UTIL, MAIN, LOG, CONTAINER, SYSTEM], stale: [], reused: [MUL, LOGFN, CLI, CLIFN] });
});

test("incremental impact: a rename (moved file) removes the old ids, adds the new ones and re-points importers", () => {
  const files: Files = { "src/math.ts": [add(), mul()], "src/main.ts": [run()], "src/log.ts": [log()], "src/cli.ts": [cli] };
  const MADD = codeId("src/math.ts", "add"); const MMUL = codeId("src/math.ts", "mul");
  const edges: Edge[] = [[MAIN, MATH, "dependsOn"], [RUN, MADD, "calls"], [LOG, MATH, "dependsOn"], [LOGFN, MMUL, "calls"], [CLI, MAIN, "dependsOn"], [CLIFN, RUN, "calls"]];
  const impact = computeIncrementalImpact({ previous: base(), next: snapshot(B, files, edges), cap: "component" });
  assert.deepEqual(impact.diff.added.map(item => item.id), [MADD, MMUL, MATH]);
  assert.deepEqual(impact.diff.removed.map(item => item.id), [ADD, MUL, UTIL]);
  assert.deepEqual(impact.diff.changed, [], "importers' own symbols are unchanged: the import line is outside every excerpt");
  assert.equal(impact.diff.relationsAdded.length, 4); assert.equal(impact.diff.relationsRemoved.length, 4);
  expectSets(impact, { dirty: [MATH, MAIN, LOG, CONTAINER, SYSTEM], stale: [], reused: [CLI], removed: [ADD, MUL, UTIL] });
});

test("incremental impact: deleting a file dirties the files it imported and its container", () => {
  const files = baseFiles(); delete files["src/log.ts"];
  const edges = baseEdges().filter(([from]) => from !== LOG && from !== LOGFN);
  const impact = computeIncrementalImpact({ previous: base(), next: snapshot(B, files, edges), cap: "component" });
  assert.deepEqual(impact.diff.removedExports, [{ id: LOGFN, kind: "code", name: "log", consumers: [] }]);
  expectSets(impact, { dirty: [UTIL, CONTAINER, SYSTEM], stale: [], reused: [MAIN, CLI], removed: [LOGFN, LOG] });
});

test("incremental impact: a new import between two siblings in unchanged files dirties both endpoints", () => {
  const impact = computeIncrementalImpact({ previous: base(), next: snapshot(B, baseFiles(), [...baseEdges(), [CLI, UTIL, "dependsOn"]]), cap: "component" });
  assert.deepEqual(impact.diff.changed, []); assert.deepEqual(impact.diff.relationsAdded, [{ from: CLI, to: UTIL, kind: "dependsOn" }]);
  expectSets(impact, { dirty: [CLI, UTIL, CONTAINER, SYSTEM], stale: [], reused: [MAIN, LOG] });
});

test("incremental impact: a cross-file edge change re-points both sides; the changed caller's own consumer goes stale", () => {
  const files = { ...baseFiles(), "src/main.ts": [run("return mul(1, 2);")] };
  const edges = baseEdges().map(([from, to, kind]): Edge => from === RUN && to === ADD ? [RUN, MUL, "calls"] : [from, to, kind]);
  const component = computeIncrementalImpact({ previous: base(), next: snapshot(B, files, edges), cap: "component" });
  assert.deepEqual(component.diff.relationsAdded, [{ from: RUN, to: MUL, kind: "calls" }]); assert.deepEqual(component.diff.relationsRemoved, [{ from: RUN, to: ADD, kind: "calls" }]);
  expectSets(component, { dirty: [MAIN, UTIL, CONTAINER, SYSTEM], stale: [[CLI, "dependency-internal"]], reused: [LOG] });
  const code = computeIncrementalImpact({ previous: base(), next: snapshot(B, files, edges), cap: "code" });
  expectSets(code, { dirty: [ADD, MUL, RUN, MAIN, UTIL, CONTAINER, SYSTEM], stale: [[CLI, "dependency-internal"], [CLIFN, "dependency-internal"]], reused: [LOG, LOGFN] });
});

test("incremental impact: signature heuristic stops at the declaration head", () => {
  const entity = snapshot(A, baseFiles(), []).entities.find(item => item.id === ADD)!;
  assert.equal(entitySignature(entity), "export function add(a: number, b: number): number {");
  assert.equal(entitySignature(snapshot(A, baseFiles(), []).entities.find(item => item.id === UTIL)!), undefined, "a component's surface is its exposure and children");
});

/** util.ts declares one symbol `api` (text before → after); main.ts's `run` calls it and main.ts imports util.ts; log.ts is unrelated. */
function surfaceCase(before: string, after: string) {
  const API = codeId("src/util.ts", "api");
  const files = (text: string): Files => ({ "src/util.ts": [{ name: "api", start: 1, text }], "src/main.ts": [run()], "src/log.ts": [log("console.log(1);")] });
  const edges: Edge[] = [[MAIN, UTIL, "dependsOn"], [RUN, API, "calls"]];
  const impact = computeIncrementalImpact({ previous: snapshot(A, files(before), edges), next: snapshot(B, files(after), edges), cap: "code" });
  return { API, impact };
}
const SURFACE_SETS = (API: string) => ({ dirty: [API, UTIL, RUN, MAIN, CONTAINER, SYSTEM], stale: [] as Array<[string, "dependency-internal" | "moved"]>, reused: [LOG, LOGFN] });
const INTERNAL_SETS = (API: string) => ({ dirty: [API, UTIL, CONTAINER, SYSTEM], stale: [[RUN, "dependency-internal"], [MAIN, "dependency-internal"]] as Array<[string, "dependency-internal" | "moved"]>, reused: [LOG, LOGFN] });

test("incremental impact: an interface field change is a surface change (type declarations compare their whole text)", () => {
  const { API, impact } = surfaceCase("export interface Api {\n  id: string;\n  size: number;\n}", "export interface Api {\n  id: string;\n  size: bigint;\n}");
  assert.deepEqual(impact.diff.changed, [{ id: API, kind: "code", name: "api", change: "surface" }]);
  expectSets(impact, SURFACE_SETS(API));
  const object = surfaceCase("export const api = {\n  limit: 1,\n};", "export const api = {\n  limit: 2,\n};");
  assert.deepEqual(object.impact.diff.changed.map(item => item.change), ["surface"], "an object literal is surface too");
});

test("incremental impact: a class method's parameter change is a surface change; a method body edit is internal", () => {
  const before = "export class Api {\n  get(id: string) {\n    return id;\n  }\n}";
  const params = surfaceCase(before, "export class Api {\n  get(id: string, fresh: boolean) {\n    return id;\n  }\n}");
  assert.deepEqual(params.impact.diff.changed.map(item => item.change), ["surface"]);
  expectSets(params.impact, SURFACE_SETS(params.API));
  // A class is compared whole, so even a body edit counts as surface; a standalone method excerpt uses its head.
  const method = surfaceCase("async get(id: string): Promise<string> {\n  return id;\n}", "async get(id: string): Promise<string> {\n  return id.trim();\n}");
  assert.deepEqual(method.impact.diff.changed.map(item => item.change), ["internal"]);
  expectSets(method.impact, INTERNAL_SETS(method.API));
  const methodParams = surfaceCase("async get(id: string): Promise<string> {\n  return id;\n}", "async get(id: number): Promise<string> {\n  return id;\n}");
  assert.deepEqual(methodParams.impact.diff.changed.map(item => item.change), ["surface"]);
});

test("incremental impact: a generic <T extends {…}>( first line keeps the constraint in the signature and the body out", () => {
  const before = "export function api<T extends { id: string }>(value: T): T {\n  return value;\n}";
  const constraint = surfaceCase(before, "export function api<T extends { id: number }>(value: T): T {\n  return value;\n}");
  assert.deepEqual(constraint.impact.diff.changed.map(item => item.change), ["surface"]);
  expectSets(constraint.impact, SURFACE_SETS(constraint.API));
  const body = surfaceCase(before, "export function api<T extends { id: string }>(value: T): T {\n  return { ...value };\n}");
  assert.deepEqual(body.impact.diff.changed.map(item => item.change), ["internal"]);
  expectSets(body.impact, INTERNAL_SETS(body.API));
  assert.equal(entitySignature(snapshot(A, { "src/util.ts": [{ name: "api", start: 1, text: before }] }, []).entities.find(item => item.id === constraint.API)!), "export function api<T extends { id: string }>(value: T): T {");
});

test("incremental impact: multi-line parameters and a return type on a later line are part of the signature", () => {
  const before = "export function api(\n  first: string,\n  second: number,\n): {\n  ok: boolean;\n} {\n  return { ok: true };\n}";
  const returnType = surfaceCase(before, "export function api(\n  first: string,\n  second: number,\n): {\n  ok: string;\n} {\n  return { ok: true };\n}");
  assert.deepEqual(returnType.impact.diff.changed.map(item => item.change), ["surface"], "a return-type field seven lines down is surface");
  expectSets(returnType.impact, SURFACE_SETS(returnType.API));
  const param = surfaceCase(before, "export function api(\n  first: string,\n  second: bigint,\n): {\n  ok: boolean;\n} {\n  return { ok: true };\n}");
  assert.deepEqual(param.impact.diff.changed.map(item => item.change), ["surface"]);
  const body = surfaceCase(before, "export function api(\n  first: string,\n  second: number,\n): {\n  ok: boolean;\n} {\n  return { ok: false };\n}");
  assert.deepEqual(body.impact.diff.changed.map(item => item.change), ["internal"]);
  expectSets(body.impact, INTERNAL_SETS(body.API));
  const rust = surfaceCase("pub fn api<'a>(\n    input: &'a str,\n) -> Result<&'a str, Error>\nwhere\n    Error: Clone,\n{\n    Ok(input)\n}", "pub fn api<'a>(\n    input: &'a str,\n) -> Result<&'a str, String>\nwhere\n    Error: Clone,\n{\n    Ok(input)\n}");
  assert.deepEqual(rust.impact.diff.changed.map(item => item.change), ["surface"], "a Rust return type after the params is surface");
});

test("incremental impact: a Rust where clause (rustfmt style) is surface; a body-only edit under it is internal", () => {
  const head = "pub fn api<T>(\n    input: T,\n) -> Result<T, Error>\nwhere\n    T: Clone + Send,\n{\n";
  const body = surfaceCase(`${head}    Ok(input)\n}`, `${head}    Ok(input.clone())\n}`);
  assert.deepEqual(body.impact.diff.changed.map(item => item.change), ["internal"], "the body `{` after `where …,` is the body, not a type");
  expectSets(body.impact, INTERNAL_SETS(body.API));
  const bound = surfaceCase(`${head}    Ok(input)\n}`, `${head.replace("Clone + Send", "Clone + Sync")}    Ok(input)\n}`);
  assert.deepEqual(bound.impact.diff.changed.map(item => item.change), ["surface"], "a where bound is surface");
  const inline = surfaceCase("fn api<T>(x: T) -> T where T: Copy { x }", "fn api<T>(x: T) -> T where T: Copy { let y = x; y }");
  assert.deepEqual(inline.impact.diff.changed.map(item => item.change), ["internal"]);
});

test("incremental impact: every TS overload head is surface; angle brackets keep a generic object return type out of the body", () => {
  const overloads = (second: string, body = "return String(value);") => `export function api(value: string): string;\nexport function api(value: ${second}): string;\nexport function api(value: unknown): string {\n  ${body}\n}`;
  const later = surfaceCase(overloads("number"), overloads("bigint"));
  assert.deepEqual(later.impact.diff.changed.map(item => item.change), ["surface"], "a change to the second overload is surface");
  expectSets(later.impact, SURFACE_SETS(later.API));
  const body = surfaceCase(overloads("number"), overloads("number", "return `${value}`;"));
  assert.deepEqual(body.impact.diff.changed.map(item => item.change), ["internal"]);
  const promise = (field: string, result = "{ ok: true }") => `export async function api(): Promise<{\n  ${field}: boolean;\n}> {\n  return ${result};\n}`;
  assert.deepEqual(surfaceCase(promise("ok"), promise("done")).impact.diff.changed.map(item => item.change), ["surface"], "a field of Promise<{…}> is surface");
  assert.deepEqual(surfaceCase(promise("ok"), promise("ok", "{ ok: false }")).impact.diff.changed.map(item => item.change), ["internal"]);
  const params = (second: string) => `export function api(first: Map<string, { id: number }>, ${second}) {\n  return first;\n}`;
  assert.deepEqual(surfaceCase(params("b: string"), params("b: number")).impact.diff.changed.map(item => item.change), ["surface"]);
});

test("incremental impact: below-cap consumers of a changed entity are listed: `changed` for surface, `dependency-internal` for internal", () => {
  const internal = computeIncrementalImpact({ previous: base(), next: snapshot(B, { ...baseFiles(), "src/util.ts": [add(1, "return b + a;"), mul()] }, baseEdges()), cap: "component" });
  assert.deepEqual(internal.belowCap, [{ scopeId: RUN, reason: "dependency-internal" }, { scopeId: ADD, reason: "changed" }]);
  const surfaceAdd: Symbol = { name: "add", start: 1, text: "export function add(a: number, b: number, c = 0): number {\n  return a + b + c;\n}" };
  const surface = computeIncrementalImpact({ previous: base(), next: snapshot(B, { ...baseFiles(), "src/util.ts": [surfaceAdd, mul()] }, baseEdges()), cap: "component" });
  assert.deepEqual(surface.diff.changed.map(item => item.change), ["surface"]);
  assert.deepEqual(surface.belowCap, [{ scopeId: RUN, reason: "changed" }, { scopeId: ADD, reason: "changed" }]);
  const moved = computeIncrementalImpact({ previous: base(), next: snapshot(B, { ...baseFiles(), "src/util.ts": [add(2), mul(6)] }, baseEdges()), cap: "component" });
  assert.deepEqual(moved.belowCap, [{ scopeId: ADD, reason: "moved" }, { scopeId: MUL, reason: "moved" }]);
  const code = computeIncrementalImpact({ previous: base(), next: snapshot(B, { ...baseFiles(), "src/util.ts": [add(1, "return b + a;"), mul()] }, baseEdges()), cap: "code" });
  assert.deepEqual(code.belowCap, [], "nothing is below the code cap");
});
