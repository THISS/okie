#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const release = process.argv.includes("--release");
const debug = process.argv.includes("--debug");
if (release && debug) {
  console.error("Choose exactly one WASM profile: --release or --debug.");
  process.exit(1);
}

// Interactive development needs optimized Rust/WASM. `--profiling` retains
// debug information without the severe runtime cost of wasm-pack's `--dev`.
// The unoptimized profile remains explicit for low-level Rust diagnostics.
const profile = release ? "--release" : debug ? "--dev" : "--profiling";
const args = [
  "build",
  "crates/atlas-wasm",
  "--target",
  "web",
  "--out-dir",
  "pkg",
  profile,
];

const result = spawnSync("wasm-pack", args, {
  cwd: process.cwd(),
  stdio: "inherit",
});

if (result.error?.code === "ENOENT") {
  console.error(
    "wasm-pack is required to generate crates/atlas-wasm/pkg. Install wasm-pack 0.13+ and rerun this command.",
  );
  process.exit(1);
}

if (result.error) {
  console.error(`Unable to start wasm-pack: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(
    `wasm-pack failed with status ${result.status ?? "unknown"}. The web app cannot be checked or built without the generated WASM package.`,
  );
  process.exit(result.status ?? 1);
}
