import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { analyzeRust } from "./analyze-rust.js";

function fixture(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "okie-rust-semantic-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  for (const args of [["init", "-q"], ["config", "user.email", "okie@example.test"], ["config", "user.name", "Okie"], ["add", "."], ["commit", "-qm", "fixture"]]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("rust-analyzer SCIP resolves cross-crate calls, preserves uses, and emits real file/import dependencies", { timeout: 120_000 }, () => {
  const repo = fixture({
    "Cargo.toml": '[workspace]\nmembers = ["crates/api", "crates/app"]\nresolver = "2"\n',
    "crates/api/Cargo.toml": '[package]\nname = "api"\nversion = "0.1.0"\nedition = "2021"\n',
    "crates/api/src/lib.rs": 'pub mod color;\n#[path = "renamed.rs"] pub mod explicit;\n',
    "crates/api/src/color.rs": 'pub mod nested;\npub fn is_valid_color(value: &str) -> bool { value == "green" }\n',
    "crates/api/src/color/nested.rs": 'pub fn nested_color() -> bool { true }\n',
    "crates/api/src/orphan.rs": 'pub fn not_compiled() {}\n',
    "crates/api/src/renamed.rs": 'pub fn explicit_color() -> bool { true }\n',
    "crates/app/Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\napi = { path = "../api" }\n',
    "crates/app/src/main.rs": 'use api::color::is_valid_color;\nmod local;\nfn caller() { if is_valid_color("green") { local::mark(); } let saved = is_valid_color; let _ = saved; }\n',
    "crates/app/src/local.rs": 'pub fn mark() {}\n',
  });
  try {
    const files = ["crates/api/src/lib.rs", "crates/api/src/color.rs", "crates/api/src/color/nested.rs", "crates/api/src/orphan.rs", "crates/api/src/renamed.rs", "crates/app/src/main.rs", "crates/app/src/local.rs"];
    const analysis = analyzeRust(repo.root, files);
    assert.equal(analysis.coverage[0]?.coverage, "semantic", JSON.stringify(analysis.coverage));
    const valid = analysis.definitions.find(item => item.name === "is_valid_color");
    assert.ok(valid, JSON.stringify(analysis));
    const calls = analysis.references.filter(item => item.path === "crates/app/src/main.rs" && item.symbol === valid.symbol);
    assert.ok(calls.some(item => item.kind === "calls"));
    assert.ok(calls.some(item => item.kind === "uses"));
    assert.ok(analysis.modules.some(item => item.path === "crates/app/src/main.rs" && item.targetPath === "crates/app/src/local.rs"), JSON.stringify(analysis.modules));
    assert.ok(analysis.modules.some(item => item.path === "crates/app/src/main.rs" && item.targetPath === "crates/api/src/color.rs"), JSON.stringify(analysis.modules));
    assert.ok(analysis.modules.some(item => item.path === "crates/api/src/color.rs" && item.targetPath === "crates/api/src/color/nested.rs"), JSON.stringify(analysis.modules));
    assert.ok(analysis.modules.some(item => item.path === "crates/api/src/lib.rs" && item.targetPath === "crates/api/src/renamed.rs"), JSON.stringify(analysis.modules));
    assert.ok(!analysis.coverage[0]!.indexedFiles.includes("crates/api/src/orphan.rs"), JSON.stringify(analysis.coverage));
    assert.ok(analysis.coverage[0]!.limitations.some(item => item.includes("crates/api/src/orphan.rs")), JSON.stringify(analysis.coverage));
    assert.ok(!analysis.definitions.some(item => item.name === "saved"), JSON.stringify(analysis.definitions));
    assert.deepEqual(analysis, analyzeRust(repo.root, files));
  } finally {
    repo.cleanup();
  }
});

test("atlas-protocol records every seven resolved is_valid_color call sites", { timeout: 120_000 }, () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const analysis = analyzeRust(root, [
    "crates/atlas-protocol/src/geometry.rs",
    "crates/atlas-protocol/src/lib.rs",
    "crates/atlas-protocol/src/patch.rs",
    "crates/atlas-protocol/src/scene.rs",
    "crates/atlas-protocol/src/timeline.rs",
  ]);
  const definition = analysis.definitions.find(item => item.name === "is_valid_color");
  assert.ok(definition, JSON.stringify(analysis));
  const calls = analysis.references.filter(item => item.symbol === definition.symbol && item.kind === "calls");
  assert.deepEqual(calls.map(item => `${item.path}:${item.startLine}`).sort(), [
    "crates/atlas-protocol/src/scene.rs:117",
    "crates/atlas-protocol/src/scene.rs:133",
    "crates/atlas-protocol/src/scene.rs:155",
    "crates/atlas-protocol/src/scene.rs:168",
    "crates/atlas-protocol/src/scene.rs:320",
    "crates/atlas-protocol/src/scene.rs:51",
    "crates/atlas-protocol/src/timeline.rs:153",
  ]);
});
