import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { analyzeRust } from "./analyze-rust.js";
import { cachedScipIndex, rustAnalyzerVersion, rustcIdentity, rustInputDigest, scipStderrUncacheable, sweepScipCache } from "./scip-cache.js";

const FILES: Record<string, string> = {
  "Cargo.toml": '[workspace]\nmembers = ["crates/api", "crates/app"]\nresolver = "2"\n',
  "crates/api/Cargo.toml": '[package]\nname = "api"\nversion = "0.1.0"\nedition = "2021"\n',
  "crates/api/src/lib.rs": 'pub fn is_valid(value: &str) -> bool { value == "green" }\n#[cfg(target_arch = "wasm32")]\npub fn browser() {}\n',
  "crates/app/Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\napi = { path = "../api" }\n',
  "crates/app/src/main.rs": 'use api::is_valid;\nfn main() { if is_valid("green") { println!("ok"); } }\n',
  "README.md": "not a rust input\n",
};
const RUST = ["crates/api/src/lib.rs", "crates/app/src/main.rs"];
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "okie-scip-cache-tree-"));
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
  return root;
}

test("scip cache: the input digest covers every Rust input and crate file, and ignores the checkout path", () => {
  const variants: Record<string, Record<string, string>> = {
    readme: { ...FILES, "README.md": "changed\n" },
    lock: { ...FILES, "Cargo.lock": "# lock\n" },
    config: { ...FILES, ".cargo/config.toml": "[build]\n" },
    nestedConfig: { ...FILES, "crates/app/.cargo/config.toml": "[build]\n" },
    rustProject: { ...FILES, "tools/rust-project.json": "{}\n" },
    analyzerToml: { ...FILES, "rust-analyzer.toml": "[cargo]\n" },
    target: { ...FILES, "target/debug/x.rs": "fn x() {}\n" },
    nestedTarget: { ...FILES, "crates/api/target/gen/data.txt": "generated\n" },
    included: { ...FILES, "crates/api/assets/greeting.txt": "hello\n" },
    outsideCrate: { ...FILES, "docs/notes.txt": "hello\n" },
  };
  const roots: string[] = [];
  const digest = (files: Record<string, string>) => { const root = tree(files); roots.push(root); return rustInputDigest(root); };
  try {
    const base = digest(FILES);
    assert.equal(digest(FILES), base, "another checkout path, same content");
    assert.equal(digest(variants.readme!), base, "a non-Rust file outside every crate root does not count");
    assert.equal(digest(variants.outsideCrate!), base, "a virtual workspace manifest is not a crate root");
    for (const name of ["lock", "config", "nestedConfig", "rustProject", "analyzerToml", "target", "nestedTarget", "included"]) assert.notEqual(digest(variants[name]!), base, name);
    // Symlinks are hashed by target text (never followed).
    const linked = tree(FILES); roots.push(linked);
    symlinkSync("../../README.md", join(linked, "crates/api/readme-link"));
    const before = rustInputDigest(linked);
    rmSync(join(linked, "crates/api/readme-link")); symlinkSync("../../Cargo.toml", join(linked, "crates/api/readme-link"));
    assert.notEqual(rustInputDigest(linked), before, "a retargeted symlink changes the digest");
    assert.notEqual(before, base);
  } finally { for (const root of roots) rmSync(root, { recursive: true, force: true }); }
});

test("scip cache: rustc identity and stderr classification", () => {
  const root = tree(FILES);
  try {
    const identity = rustcIdentity(root);
    if (identity !== undefined) assert.match(identity, /^\d+\.\d+\.\d+\S* \S+$/, "release and host");
    assert.equal(scipStderrUncacheable("error: failed to run build script for `foo`"), true);
    assert.equal(scipStderrUncacheable("proc-macro server: failed to load dylib"), true);
    assert.equal(scipStderrUncacheable("duplicate scip symbols: x\nindexing 3 files"), false);
    // Real rust-analyzer progress output on a healthy workspace (crate names containing "error") stays cacheable.
    assert.equal(scipStderrUncacheable("rust-analyzer: Loading building proc-macros: thiserror-impl\nrust-analyzer: Loading running build-script: thiserror\nrust-analyzer: Loading building proc-macros: error-chain\nGenerating SCIP start..."), false);
    assert.equal(scipStderrUncacheable("[ERROR] proc-macro thiserror-impl failed to build"), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("scip cache: a corrupt entry is a miss, failed or build-script-dependent runs are never stored, and no cache dir means no caching", t => {
  if (!rustAnalyzerVersion()) { t.skip("rust-analyzer is not installed"); return; }
  const root = tree(FILES); const cacheDir = mkdtempSync(join(tmpdir(), "okie-scip-cache-"));
  try {
    let runs = 0; const run = () => { runs += 1; return { bytes: Buffer.from(`index ${runs}`), stderr: "" }; };
    const common = { cacheDir, root, toolchain: "1.87.0 test-host" };
    assert.equal(cachedScipIndex({ ...common, variant: "v", run }).cache, "miss");
    const hit = cachedScipIndex({ ...common, variant: "v", run });
    assert.deepEqual([hit.cache, hit.bytes?.toString(), runs], ["hit", "index 1", 1]);
    assert.equal(cachedScipIndex({ ...common, variant: "other", run }).cache, "miss", "the invocation is part of the key");
    assert.equal(cachedScipIndex({ ...common, toolchain: "1.88.0 test-host", variant: "v", run }).cache, "miss", "the rustc identity is part of the key");
    for (const name of readdirSync(cacheDir).filter(file => file.endsWith(".scip"))) writeFileSync(join(cacheDir, name), "garbage");
    assert.equal(cachedScipIndex({ ...common, variant: "v", run }).cache, "miss", "bytes that do not match their sha256 are ignored");
    const failing = { ...common, variant: "failing", run: () => ({ stderr: "boom", error: "boom" }) };
    assert.equal(cachedScipIndex(failing).cache, "miss"); assert.equal(cachedScipIndex(failing).cache, "miss");
    const buildScript = { ...common, variant: "build-script", run: () => ({ bytes: Buffer.from("partial"), stderr: "failed to run build script for `api`" }) };
    assert.equal(cachedScipIndex(buildScript).cache, "miss"); assert.equal(cachedScipIndex(buildScript).cache, "miss", "never stored");
    assert.equal(cachedScipIndex({ root, variant: "v", run }).cache, "off");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(cacheDir, { recursive: true, force: true }); }
});

test("scip cache: a hit refreshes the entry; writes sweep oldest entries to the size cap and drop stale temp files", t => {
  if (!rustAnalyzerVersion()) { t.skip("rust-analyzer is not installed"); return; }
  const root = tree(FILES); const cacheDir = mkdtempSync(join(tmpdir(), "okie-scip-cache-"));
  try {
    const common = { cacheDir, root, toolchain: "1.87.0 test-host", maxBytes: 2500 };
    const run = () => ({ bytes: Buffer.alloc(1000, 1), stderr: "" });
    const keyOf = (variant: string) => { cachedScipIndex({ ...common, variant, run }); return readdirSync(cacheDir).filter(name => name.endsWith(".scip")); };
    keyOf("a"); const [a] = keyOf("a");
    const old = new Date(Date.now() - 10_000);
    utimesSync(join(cacheDir, a!), old, old); utimesSync(join(cacheDir, a!.replace(".scip", ".json")), old, old);
    const afterB = keyOf("b"); const b = afterB.find(name => name !== a)!;
    for (const name of afterB) { const older = new Date(Date.now() - (name === a ? 20_000 : 5_000)); utimesSync(join(cacheDir, name), older, older); }
    assert.equal(cachedScipIndex({ ...common, variant: "a", run }).cache, "hit");
    assert.ok(statSync(join(cacheDir, a!)).mtimeMs > statSync(join(cacheDir, b)).mtimeMs, "a hit touches the entry");
    const stale = join(cacheDir, "x.123.tmp"); writeFileSync(stale, "partial"); const hourAgo = new Date(Date.now() - 2 * 60 * 60 * 1000); utimesSync(stale, hourAgo, hourAgo);
    const fresh = join(cacheDir, "y.456.tmp"); writeFileSync(fresh, "in flight");
    cachedScipIndex({ ...common, variant: "c", run }); // third ~1.1 KB entry: over 2.5 KB, so the least recently used (b) goes
    const left = readdirSync(cacheDir);
    assert.ok(left.includes(a!), "the recently hit entry survives");
    assert.ok(!left.includes(b) && !left.includes(b.replace(".scip", ".json")), "the least recently used entry is evicted whole");
    assert.equal(left.filter(name => name.endsWith(".scip")).length, 2);
    assert.ok(!left.includes("x.123.tmp") && left.includes("y.456.tmp"), "only temp files older than an hour are removed");
    sweepScipCache(cacheDir, 0);
    assert.deepEqual(readdirSync(cacheDir).filter(name => !name.endsWith(".tmp")), [], "a zero cap empties the cache");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(cacheDir, { recursive: true, force: true }); }
});

test("scip cache: the same Rust content at two roots gives an identical analysis from the cache; a one-byte change misses", { timeout: 300_000 }, t => {
  if (!rustAnalyzerVersion() || !rustcIdentity(tmpdir())) { t.skip("rust-analyzer or rustc is not installed"); return; }
  const cacheDir = mkdtempSync(join(tmpdir(), "okie-scip-cache-"));
  // rust-analyzer may write a Cargo.lock into the tree it indexes, so every run gets its own fresh tree (as a scan does).
  const first = tree(FILES); const second = tree(FILES); const plain = tree(FILES); const edited = tree({ ...FILES, "crates/api/src/lib.rs": FILES["crates/api/src/lib.rs"]!.replace("green", "greeN") }); const nestedTarget = tree({ ...FILES, "crates/api/target/gen/data.txt": "generated\n" });
  try {
    const seen: string[] = []; const onIndex = (variant: string, cache: string) => { seen.push(`${variant}:${cache}`); };
    const uncached = analyzeRust(plain, RUST);
    assert.equal(uncached.coverage[0]?.coverage, "semantic", JSON.stringify(uncached.coverage));
    const cold = analyzeRust(first, RUST, { indexCacheDir: cacheDir, onIndex });
    assert.deepEqual(seen.splice(0), ["host:miss", "wasm32:miss"]);
    const warm = analyzeRust(second, RUST, { indexCacheDir: cacheDir, onIndex });
    assert.deepEqual(seen.splice(0), ["host:hit", "wasm32:hit"], "a different checkout path reuses both indexes");
    assert.deepEqual(warm, cold); assert.deepEqual(cold, uncached, "the cache never changes the analysis");
    analyzeRust(edited, RUST, { indexCacheDir: cacheDir, onIndex });
    assert.deepEqual(seen.splice(0), ["host:miss", "wasm32:miss"]);
    // An edit under a nested target/ directory is content too (committed trees have no build output).
    analyzeRust(nestedTarget, RUST, { indexCacheDir: cacheDir, onIndex });
    assert.deepEqual(seen.splice(0), ["host:miss", "wasm32:miss"]);
  } finally { for (const root of [cacheDir, first, second, plain, edited, nestedTarget]) rmSync(root, { recursive: true, force: true }); }
});
