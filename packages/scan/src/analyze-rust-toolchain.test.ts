import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeRust } from "./analyze-rust.js";
import { resetRustToolchainPinForTests, rustToolchainPin } from "./scan-env.js";

// Own test file (own process): the toolchain pin is memoized per process.
test("rust toolchain pin: an unusable scanner toolchain makes Rust coverage unavailable with a clear limitation, never a silent zero", t => {
  if (spawnSync("rustup", ["--version"]).error) { t.skip("rustup is not installed"); return; }
  const root = mkdtempSync(join(tmpdir(), "okie-rust-toolchain-"));
  const previous = process.env.OKIE_SCAN_RUST_TOOLCHAIN;
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(join(root, "src/lib.rs"), "pub fn f() {}\n");
    process.env.OKIE_SCAN_RUST_TOOLCHAIN = "okie-no-such-toolchain-cla305";
    resetRustToolchainPinForTests();
    assert.equal(rustToolchainPin().toolchain, "okie-no-such-toolchain-cla305");
    const analysis = analyzeRust(root, ["src/lib.rs"]);
    assert.equal(analysis.coverage[0]?.coverage, "unavailable");
    assert.match(analysis.coverage[0]!.limitations[0]!, /Rust analysis unavailable: rustc is unavailable for the scanner's Rust toolchain okie-no-such-toolchain-cla305/);
  } finally {
    if (previous === undefined) delete process.env.OKIE_SCAN_RUST_TOOLCHAIN; else process.env.OKIE_SCAN_RUST_TOOLCHAIN = previous;
    resetRustToolchainPinForTests();
    rmSync(root, { recursive: true, force: true });
  }
});
