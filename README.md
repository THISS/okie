# Okie

Okie is a spatial explanation system for software: an evidence-backed architecture atlas that moves from system context to source code and can play deterministic guided stories.

This repository currently contains the first renderer vertical slice: a versioned semantic model, scene compiler, Rust/WASM renderer workspace, deterministic demo data, and browser shell.

## Prerequisites

- Node.js 22+
- pnpm 11.10+
- Rust 1.87 and the `wasm32-unknown-unknown` target (pinned by `rust-toolchain.toml`)
- wasm-pack 0.13+

## Commands

```sh
pnpm install
pnpm check
pnpm build
pnpm test
cargo test --workspace
pnpm generate:fixtures
pnpm generate:stress -- --nodes 5000 --edges 15000 --seed 42
pnpm generate:wasm
pnpm generate:wasm:debug
```

`pnpm check` and `pnpm dev` deterministically generate optimized profiling WASM and the ignored 5,000-node stress fixture before TypeScript or Vite starts. This keeps ordinary development interaction representative while retaining Rust debug information. Use `pnpm generate:wasm:debug` only when an unoptimized WASM build is specifically needed for low-level Rust diagnostics. `pnpm build` regenerates the same prerequisites with the smaller release WASM profile. Generated outputs remain uncommitted, so these commands also work after a clean clone or after deleting `crates/atlas-wasm/pkg` and `fixtures/renderer/stress-5000.json`.

If wasm-pack is unavailable, generation stops with an explicit prerequisite error instead of a later TypeScript missing-module failure.

## Continuous integration

Pull requests and pushes to `main` run GitHub Actions (`.github/workflows/ci.yml`) with the same deterministic gates used locally: `pnpm install --frozen-lockfile`, emit workspace `dist/` (gitignored; package `check` typechecks `@okie/*` exports), `pnpm check`, `pnpm test`, and `cargo test --workspace`. That covers typecheck plus tests for `@okie/web`, `@okie/server`, `@okie/scan`, `@okie/architecture`, `@okie/scene-compiler`, and the Rust crates. Live GitHub/LLM tests stay skipped (`OKIE_SCAN_LIVE` and gateway keys are unset). The workflow uses no repository secrets and no `.env` files.

Making the **Deterministic gates** check required to merge is a GitHub branch-protection setting and is not applied from this repository.

See [the renderer architecture](docs/architecture/renderer.md) for system boundaries, protocol decisions, browser fallback, and milestone acceptance criteria.
