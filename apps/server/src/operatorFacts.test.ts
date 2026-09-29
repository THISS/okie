import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanRepository } from "@okie/scan";
import type { ArchitectureSnapshot } from "@okie/architecture";
import { operatorInputHash, operatorRequestBody, preparedOperatorScope, type OperatorEnrichmentScope } from "./operatorEnrichment.js";
import { operatorScopesFromSnapshot } from "./operatorFacts.js";

/** A tiny TypeScript repository; `commit` returns the new SHA. */
function scratchRepo(): { root: string; write(path: string, text: string): void; commit(message: string): string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "okie-incremental-repo-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=test", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  return {
    root,
    write(path, text) { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); },
    commit(message) { git("add", "-A"); git("commit", "-q", "--allow-empty", "-m", message); return git("rev-parse", "HEAD"); },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

const UTIL_TS = "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function mul(a: number, b: number): number {\n  return a * b;\n}\n";
const MAIN_TS = "import { add } from \"./util.js\";\n\nexport function run(): number {\n  return add(1, 2);\n}\n";

/** Input hash of one scope exactly as runOperatorEnrichment computes it for a first (leaf) attempt at the given cap. */
function hashOf(snapshot: ArchitectureSnapshot, scopeId: string, cap: "component" | "code"): string {
  const scopes = operatorScopesFromSnapshot(snapshot);
  const byId = new Map(scopes.map(scope => [scope.scopeId, scope]));
  const children = scopes.filter(scope => scope.parentScopeId === scopeId);
  const inCap = (scope: OperatorEnrichmentScope) => cap === "code" || scope.kind !== "code";
  const scope = preparedOperatorScope(byId.get(scopeId)!, children.filter(child => !inCap(child)));
  return operatorInputHash({ modelId: "fake/model", reasoning: "provider-default", scope, children: children.filter(inCap).map(child => ({ scopeId: child.scopeId, name: child.name, kind: child.kind, state: "not run" })) });
}

test("CLA-271: one entity scanned at two commits with identical content has one input hash (component and code scopes)", () => {
  const repo = scratchRepo();
  try {
    repo.write("package.json", "{\"name\":\"demo-lib\",\"version\":\"1.0.0\",\"type\":\"module\"}\n");
    repo.write("src/util.ts", UTIL_TS); repo.write("src/main.ts", MAIN_TS); repo.write("README.md", "one\n");
    const first = repo.commit("A");
    repo.write("README.md", "two\n");
    const second = repo.commit("B");
    const a = scanRepository(repo.root, { revision: first, systemName: "Demo", repositorySlug: "demo" }).snapshot;
    const b = scanRepository(repo.root, { revision: second, systemName: "Demo", repositorySlug: "demo" }).snapshot;
    assert.notEqual(a.commitSha, b.commitSha);
    const code = a.entities.find(entity => entity.id === "code:src-util-ts:add")!;
    // The finding: the scanner stamps the commit into code facts (excerpt frozenRevision, exposure evidence commitSha).
    assert.equal((code.sourceExcerpts![0] as { frozenRevision: string }).frozenRevision, a.commitSha);
    assert.equal(code.exposure![0]!.evidence.source.commitSha, a.commitSha);
    for (const [scopeId, cap] of [["component:src-util-ts", "component"], ["component:src-main-ts", "component"], ["code:src-util-ts:add", "code"], ["code:src-main-ts:run", "code"], ["container:demo-lib", "component"], ["system:demo", "component"]] as const) {
      assert.equal(hashOf(a, scopeId, cap), hashOf(b, scopeId, cap), `${scopeId} (cap ${cap}) hashes the same at both commits`);
    }
    // Neither commit reaches the prompt body.
    const scope = operatorScopesFromSnapshot(a).find(value => value.scopeId === "code:src-util-ts:add")!;
    const body = JSON.stringify(operatorRequestBody("fake/model", scope, []));
    assert.ok(!body.includes(a.commitSha), "the prompt carries no commit SHA");
  } finally { repo.cleanup(); }
});

test("CLA-271: line numbers stay real evidence: a line shift with identical text changes the code scope's input hash", () => {
  const repo = scratchRepo();
  try {
    repo.write("package.json", "{\"name\":\"demo-lib\",\"version\":\"1.0.0\",\"type\":\"module\"}\n");
    repo.write("src/util.ts", UTIL_TS); repo.write("src/main.ts", MAIN_TS);
    const first = repo.commit("A");
    repo.write("src/util.ts", `// header comment\n${UTIL_TS}`);
    const second = repo.commit("B");
    const a = scanRepository(repo.root, { revision: first, systemName: "Demo", repositorySlug: "demo" }).snapshot;
    const b = scanRepository(repo.root, { revision: second, systemName: "Demo", repositorySlug: "demo" }).snapshot;
    assert.notEqual(hashOf(a, "code:src-util-ts:mul", "code"), hashOf(b, "code:src-util-ts:mul", "code"));
    assert.equal(hashOf(a, "code:src-main-ts:run", "code"), hashOf(b, "code:src-main-ts:run", "code"), "an untouched file's symbol is unaffected");
  } finally { repo.cleanup(); }
});
