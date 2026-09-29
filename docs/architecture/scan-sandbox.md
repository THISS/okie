# Scan sandbox (CLA-305)

A full-mode scan analyses a repository we don't control. Operator runs (`apps/server/src/operatorRunner.ts`,
`analysisMode: "full"`) fetch a GitHub tarball, extract it, and run git, rust-analyzer and rustc over it. This page covers
what that content could make the scanner do, what is mitigated today, what is not, and where isolation goes next
(CLA-266).

## Threat model

The attacker controls everything in the scanned tree: file names, contents and modes. The scanner is trusted. The
operator's configuration and the server's environment are trusted, and must stay secret.

| Vector | What the repository can do |
|---|---|
| Cargo build scripts (`build.rs`) | rust-analyzer compiles and runs them to collect `OUT_DIR` and cfgs, with the scanner's env and uid. |
| Proc macros | rust-analyzer builds the proc-macro crate and loads the dylib into its proc-macro server, which runs its code on every expansion. |
| `.cargo/config.toml` `build.rustc-wrapper`, `build.rustc-workspace-wrapper`, `build.rustc` | `cargo metadata` runs `rustc -vV` through the wrapper, or runs the named compiler outright. |
| `rust-toolchain(.toml)` | A rustup proxy resolved inside the tree selects that toolchain: a `path = "..."` toolchain of repository binaries, or a channel rustup would auto-install over the network. |
| `rust-analyzer.toml` | Could set `cargo.buildScripts.overrideCommand`, `procMacro.server`, and similar. |
| `rust-project.json` | `proc_macro_dylib_path` makes the sysroot proc-macro server load a committed dylib. `sysroot` makes rust-analyzer run `<sysroot>/bin/rustc` and `<sysroot>/libexec/rust-analyzer-proc-macro-srv`. |
| `.git/config` of a local checkout | `core.fsmonitor` can run a command during `git ls-files`. |
| Secrets | Any code that runs can read the environment (API keys, OAuth secrets, GitHub tokens, `.env` values) and the host user's dotfiles (`~/.cargo/credentials.toml`, `~/.config/gh`, `~/.ssh`). |
| Host filesystem | Anything that runs does so as the server's uid. |
| Network | Build scripts can exfiltrate; rustup and cargo can fetch. |
| Resource exhaustion | Huge trees, pathological analysis, runaway processes. |
| Cache poisoning | A planted or symlinked entry in the SCIP index cache would be served to later scans of other repositories. |
| Config in ANCESTOR directories | rust-analyzer and cargo also read the parents of the analysed tree (verified below). Under a shared, world-writable TMPDIR such as Linux `/tmp`, another local user could plant `/tmp/rust-project.json` (code execution) or `/tmp/.cargo/config.toml` (cache poisoning). |
| Tarball traversal | `../`, absolute, symlink and hardlink entries in the archive. CLA-305 item 5 replaced host `tar` with an in-process validating extractor (`packages/scan/src/tar-extract.ts`). |

## rust-analyzer lockdown: what 1.87 `scip` honours

All of this was verified with rust-analyzer 1.87.0 (`rust-analyzer scip <root> --config-path <file>`). The test fixture
was a workspace with a proc-macro crate and a crate with a `build.rs`. Each payload writes a marker file to a temp dir.
We then checked which markers appeared, whether `target/` was created in the tree, and whether the index was produced.

| Config key (via `--config-path`) | Honoured by `scip`? | Result |
|---|---|---|
| `cargo.buildScripts.enable: false` | **No** | Build script and proc macro both still run. `scip` always loads build data. |
| `procMacro.enable: false` | **No** | Proc macro still runs. |
| `procMacro.server: "/usr/bin/false"` | **No** | `scip` always uses the sysroot proc-macro server. |
| `procMacro.ignored` | **No** (for `rust-project.json` dylibs) | The dylib is still loaded and expanded. |
| `cargo.buildScripts.overrideCommand: ["/usr/bin/true"]` | **Yes** | No markers and no `target/`, and the index is still produced. Proc-macro dylibs are produced by the build-data step, so replacing that step with a no-op means no proc-macro dylib exists to load. |
| Repository `rust-analyzer.toml` (any key) | **Not read** by `scip` | With no `--config-path`, build scripts ran normally and the repository's `overrideCommand` script never ran. |

The lockdown is therefore `{"cargo":{"buildScripts":{"overrideCommand":[<no-op>]}}}`. It is written to a config file and
passed on **every** `scip` run. The wasm32 variant merges it with its `cargo.target`. The no-op is `/usr/bin/true` on
macOS and glibc Linux, `/bin/true` on busybox, and `node -e ""` as a last resort. It exits 0 and prints nothing, which
rust-analyzer reads as "no build data". The cache key uses the placeholder `<noop>`, so the key does not depend on
the machine.

**Coverage cost.** Generated code is not indexed. That covers `include!(concat!(env!("OUT_DIR"), ...))` and anything
proc-macro expansion would produce. Every Rust coverage row now carries that limitation. With the host cargo
registry available, the lockdown changed nothing measurable on ripgrep: 2925 defs, 16092 refs and 2010 external refs
before and after. On okie itself, external refs went from 852 to 838.

A `rust-project.json` can't be neutralised through config. If any `rust-project.json` or `.rust-project.json` in the tree
names `proc_macro_dylib_path`, `sysroot`, `sysroot_src` or `sysroot_project`, the scanner skips Rust analysis and
records a limitation. It does the same if the file can't be parsed or is not a regular file.

Detection works in two layers, in every directory walked, in the tree and in its ancestors:

- **The filesystem's own answer.** The scanner lstats `rust-project.json` and `.rust-project.json` directly, so
  whatever stored name the filesystem resolves to them counts as found. On APFS this catches `Rust-Project.json`
  (verified: its `sysroot` binary ran) and `ruſt-project.json` (U+017F).
- **A name comparison.** Names are folded with NFC, then upper-case, then lower-case, so `ſ` becomes `s`. This layer
  also catches those spellings on case-sensitive filesystems, where rust-analyzer would not open them anyway.

The name layer alone is not a complete model of every filesystem's folding. That is why the filesystem is asked
first.

Verified: with a real
(marker-only) proc-macro dylib referenced from `rust-project.json`, every config above still loaded it, and a
repository `sysroot` had its `bin/rustc` and `libexec/rust-analyzer-proc-macro-srv` executed.

## Ancestor directories (`packages/scan/src/rust-ancestors.ts`)

Probes (rust-analyzer / cargo 1.87, pinned env, lockdown config) put the tree at `<scratch>/parent/child/tree` and
planted files above it:

| Planted above the tree | Picked up? |
|---|---|
| `rust-project.json` naming a `sysroot` (one level up, two levels up, `.rust-project.json`, `Rust-Project.JSON`) | **Yes**, even though the tree has its own root `Cargo.toml`: the sysroot's proc-macro server ran, and the tree was not indexed at all. |
| `.cargo/config.toml` with `build.rustc` and `rustc-wrapper` | **Yes** without the pins (both markers written). **Neutralised** by the scan-env pins. Other keys still shape `cargo metadata`. |
| `.cargo/config.toml` with `build.target-dir` | No effect: `cargo metadata` builds nothing. |
| `Cargo.toml` with `[workspace]` above a single-package tree | **Yes**: cargo adopts the parent workspace, `cargo metadata` fails, and the whole index fails. That is denial of service, not execution. |

Mitigations:

- **A private work root.**
  - Every scanner temp dir lives under one work root: the tarball extraction, the committed-tree copy, rust-analyzer
    scratch and the scratch HOME. The operator server's per-scan child dirs live there too.
  - `scanWorkDir()` resolves the root once per process, the same way for the server and the CLI:
    1. `$OKIE_SCAN_WORK_DIR/okie-scan-work` when `OKIE_SCAN_WORK_DIR` is set. This is the operator's choice.
    2. Otherwise `$TMPDIR/okie-scan-work`, if `os.tmpdir()` and every ancestor pass the ownership check, and none holds
       a `rust-project.json` or a `Cargo.toml` that defines a workspace (`[workspace]`, `[ workspace ]`,
       `[workspace.*]`, or dotted or inline `workspace` keys). The macOS per-user `T` dir passes.
    3. Otherwise `$XDG_RUNTIME_DIR/okie-scan-work`, under the same test. It is per-user, typically `/run/user/<uid>`,
       and not under `~`, so the operator's `~/.cargo/config.toml` doesn't apply. It is often a small tmpfs, which
       large trees can fill.
    4. Otherwise `${XDG_CACHE_HOME:-~/.cache}/okie/scan-work`, under the same test.
    5. Otherwise `os.tmpdir()`, and Rust analysis refuses to run there with a limitation.

    The root is always the scanner's own dedicated directory: created 0700, owned by the scanner's uid, and with
    symlinks resolved. A symlinked directory, or one another user created first, is refused. The operator's own
    directory, such as `OKIE_SCAN_WORK_DIR` or `TMPDIR`, is never chmod-ed. The root is re-prepared before each use,
    so a deleted root is recreated.
- **Ancestor ownership check.**
  - Before Rust analysis, every ancestor of the analysis root, up to `/`, must be owned by root or the scanner's uid and
    not group- or other-writable. Sticky directories are not exempt, so `/tmp` fails.
  - On failure, Rust analysis is skipped with a limitation naming the directory and telling the operator to set
    `OKIE_SCAN_WORK_DIR`.
  - Paths in limitations are rendered relative to the tree, such as `../../.cargo/config.toml`. They are never
    absolute paths or mkdtemp names, so scan output is deterministic.
  - `analyzeRust` realpaths the tree first, so the directories rust-analyzer and cargo walk up are exactly the
    checked ones.
  - macOS's per-user `/var/folders/<xx>/<id>/T` passes: its ancestors are root-owned 755, the rest belong to the user,
    and `T` is 700.
- **Defence in depth.**
  - Any `rust-project.json` or `.rust-project.json` (any case) in an ancestor refuses Rust analysis.
  - Ancestor `.cargo/config(.toml)` and `Cargo.toml` files are operator-owned once the ownership check passes; an
    example is your own `~/.cargo/config.toml` when the work dir is under `$HOME`. They are listed in the coverage
    limitations, and their content is folded into the SCIP cache key.
  - **Unkeyed, operator-owned inputs.** Once the ownership check passes, these are the operator's own and are not in
    the cache key:
    - the `Cargo.lock` of an ancestor workspace;
    - the member crates of an ancestor workspace (only its `Cargo.toml` is keyed);
    - the `config.toml` inside `OKIE_SCAN_CARGO_HOME` (only its path and whether it holds `registry/` and `git/` are
      keyed).

    Change them and you should clear the SCIP cache.
  - The work root is never placed inside a Cargo workspace (steps 2 to 4 fall through). An explicit `OKIE_SCAN_WORK_DIR`
    inside one, such as the okie checkout, would make cargo adopt that workspace for single-package trees; their Rust
    analysis then fails, and the ancestor limitation says why.

## Minimal child environment (`packages/scan/src/scan-env.ts`)

Every child process the scanner spawns goes through `scanSpawnSync` / `scanExecFileSync`. That covers git (pin,
discovery), gh (the operator CLI fallback), rust-analyzer and rustc. The helpers never inherit `process.env`. They
build an allowlisted environment:

- `PATH`: the host PATH minus empty and relative entries.
- `LANG` and `LC_ALL` set to `C.UTF-8`, plus the host `TMPDIR`.
- `HOME` and `CARGO_HOME`: a per-run private (0700) mkdtemp scratch dir.
- `CARGO_NET_OFFLINE=true`.
- `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`, and `core.fsmonitor=false` via
  `GIT_CONFIG_COUNT`.
- Rust pins:
  - `RUSTUP_TOOLCHAIN`, `RUSTUP_HOME`, `RUSTUP_AUTO_INSTALL=0`.
  - `RUSTC`, `CARGO_BUILD_RUSTC` and `CARGO` set to the pinned toolchain's own binaries.
  - `RUSTC_WRAPPER`, `RUSTC_WORKSPACE_WRAPPER`, `CARGO_BUILD_RUSTC_WRAPPER` and `CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER`
    set to empty.

No API key, `GITHUB_*` / `GH_*` token or `.env` value is copied. **Exception:** `gh` (operator CLI only) gets `GH_TOKEN`
/ `GITHUB_TOKEN` when set, plus the real `HOME` / `GH_CONFIG_DIR`, because gh's stored login lives there. On macOS the
keychain lookup goes through HOME, and with a scratch HOME gh silently falls back to anonymous (60 requests/hour). gh
only downloads. It never runs repository content, and the hosted server never uses it.

**Toolchain pin.** The toolchain is resolved once per process, using `rustup show active-toolchain` in the **scanner's own
working directory**, never the scanned tree. `OKIE_SCAN_RUST_TOOLCHAIN` overrides it. A path toolchain is never adopted
implicitly. If the pinned toolchain has no rust-analyzer component, coverage is `unavailable` with a limitation that
names the toolchain and says to set `OKIE_SCAN_RUST_TOOLCHAIN`. It is never a silent zero. The trade-off is that a
repository pinned to another channel, such as nightly, is analysed with the scanner's toolchain. `rustcIdentity()` (part
of the cache key) now uses the same pin and no longer runs `rustc -vV` inside the tree.

Environment-variable verification. Each vector was marker-tested with the lockdown config in place:

| Vector | Neutralised by | Result before | Result after |
|---|---|---|---|
| `build.rustc-wrapper` | `RUSTC_WRAPPER=""` and `CARGO_BUILD_RUSTC_WRAPPER=""` | marker | none |
| `build.rustc-workspace-wrapper` | `CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER=""` | marker | none |
| `build.rustc` | `RUSTC` / `CARGO_BUILD_RUSTC` pinned to the toolchain's rustc (the empty wrappers alone do **not** stop it) | marker | none |
| `rust-toolchain.toml` `path =` | `RUSTUP_TOOLCHAIN` pin. rust-analyzer itself already ran under the proxy's inherited pin, but `rustcIdentity` ran the repository `rustc` | marker (`rustc -vV`) | none |

### `CARGO_HOME` and dependency resolution

**Decision (Brenton, CLA-305):** ship the scratch, offline CARGO_HOME as the default, with the `OKIE_SCAN_CARGO_HOME`
opt-in. The default scratch CARGO_HOME is empty and offline, so `cargo metadata` can't resolve crates.io dependencies.
rust-analyzer still produces an index, and coverage stays `semantic`, but:

| Tree (analyzeRust) | defs | refs | external refs | modules |
|---|---|---|---|---|
| okie, before CLA-305 | 583 | 3383 | 852 | 287 |
| okie, lockdown + `OKIE_SCAN_CARGO_HOME=~/.cargo` | 583 | 3383 | 838 | 287 |
| okie, lockdown + scratch CARGO_HOME (default) | 583 | 2056 | 0 | 176 |
| ripgrep, before | 2925 | 16092 | 2010 | 654 |
| ripgrep, lockdown + scratch (default) | 2865 | 12372 | 0 | 547 |

The sysroot's own library workspace needs registry dependencies too, so std type inference degrades as well. That is
why first-party references fall along with external references.

The dependency line is truthful in both modes. After indexing, the scanner runs
`cargo metadata --offline --format-version 1 --manifest-path <root>/Cargo.toml` with the same pinned env and the
pinned absolute cargo, **with the tree as its working directory** (after the ancestor check). Cargo discovers
`.cargo/config.toml` from its working directory, so this sees exactly what rust-analyzer's own `cargo metadata` sees.
For example, a committed vendored `[source.crates-io] replace-with` resolves, and gets no false "not resolved" line.
This is the same exposure rust-analyzer already has. It is recomputed on every run, cache hits included. Error lines
are scrubbed of the tree, scratch, work-root, CARGO_HOME and home paths.

- **Default mode:** "crates.io dependencies are not resolved (offline, isolated CARGO_HOME: <cargo's first error>)...".
  It appears when resolution fails, or when there is no root manifest to check. A tree with nothing to resolve gets no
  line.
- **With `OKIE_SCAN_CARGO_HOME`:** "Dependency resolution failed offline (<first error>): external references omitted
  and calls through dependency types may be missed". It appears whenever resolution fails.

Machine paths are scrubbed from the error line. A registry cache can't satisfy **git dependencies**. QA saw this on
tauri, whose `schemars` comes from a git branch: with the opt-in it recovered only 8,409 of 10,536 relations and 0
external refs. Its coverage row now says so instead of over-claiming.

`OKIE_SCAN_CARGO_HOME` is an **operator-trusted** opt-in that replaces the scratch CARGO_HOME. Point it at a dedicated
directory that holds only a registry cache (`registry/`, and `git/` if needed), which the scanner can read but has no
reason to write beyond cargo's own unpacking. **Don't point it at your own `~/.cargo`**: that exposes
`credentials.toml` and your cargo config to the scan. The scanner refuses a CARGO_HOME containing `credentials.toml` or
`credentials` and falls back to scratch with a limitation. Build scripts never run, so repository code can't read the
directory, but cargo does read its `config.toml`. The directory's path, and whether it holds `registry/` or `git/`, are
part of the SCIP cache key, so an index from a scratch run is never served to an opt-in run.

Planned pattern for CLA-266: the scan container image carries its own pre-filled, credential-free registry cache, for
example `/opt/okie/cargo-registry`, read-only in the image. `OKIE_SCAN_CARGO_HOME` points at it, which restores
dependency resolution with no network and no host credentials.

## Scan child process (`apps/server/src/scanWorker.ts`)

Operator full scans run in a child **process**, not a worker thread:

- The child is started with `/bin/sh -c 'ulimit ...; exec node --max-old-space-size=N scanWorkerMain.js'`. Its env is:
  - PATH and locale;
  - its private per-scan work dir as `TMPDIR` and `OKIE_SCAN_WORK_DIR`, with a scratch HOME inside it;
  - the host RUSTUP_HOME and a short list of non-secret scanner settings
  (`OKIE_SCIP_CACHE_MAX_MB`, `OKIE_SCAN_RUST_TOOLCHAIN`, `OKIE_SCAN_CARGO_HOME`, `RUSTUP_TOOLCHAIN`,
  `NODE_EXTRA_CA_CERTS`).
- The run's input, including the GitHub access token, is sent over the IPC channel and never in argv or the env. The
  result comes back by structured clone.
- Limits:

  | Limit | Setting | Default |
  |---|---|---|
  | Heap | `--max-old-space-size` (`OKIE_SCAN_MAX_OLD_SPACE_MB`) | 4096 |
  | Wall clock (`OKIE_SCAN_TIMEOUT_MS`), then SIGKILL of the child's process group, rust-analyzer included | `OKIE_SCAN_TIMEOUT_MS` | 30 min |
  | CPU seconds | `ulimit -t` (`OKIE_SCAN_CPU_SECONDS`) | 3600 |
  | Max file size | `ulimit -f` (`OKIE_SCAN_MAX_FILE_MB`) | 4096 MB |
  | Core dumps | `ulimit -c 0` | none |

  `--max-old-space-size` caps **node only**. rust-analyzer's memory is **not capped**: `ulimit -v` is unusable, because
  macOS doesn't support it and V8's large virtual reservations make it break node on Linux. rust-analyzer is bounded
  only by its own 120 s timeout, the CPU ulimit and the wall-clock kill. The container plan adds a cgroup memory limit.
- Cancelling the run kills the child. The runner polls the run's cancelled flag once a second during the scan.
- **Cleanup.**
  - The parent removes the per-scan work dir (extracted tree included) when the child exits, however it ended: reply,
    timeout, cancel or crash. It first SIGKILLs the child's process group again, which reaps an orphaned rust-analyzer.
    Neither step can throw into the server.
  - On server exit, `SIGINT` or `SIGTERM`, live scan process groups are killed and their work dirs removed
    (`killScanChildren`). The signal handler then removes itself and re-raises the signal, so the server still dies
    of it with the right status.
  - **Not covered:** if the server is SIGKILLed or crashes hard, no handler runs. A child busy in synchronous analysis
    keeps going until it next yields to its event loop, then exits on the IPC disconnect. Its work dir leaks under the
    work root until someone cleans it.
- `OKIE_SCAN_WORKER_CONCURRENCY` (default 1) and FIFO queuing are unchanged, and errors are still token-scrubbed.
- The test seams `deps.scan` and `deps.githubClient` still run inline.

## SCIP cache hardening (`packages/scan/src/scip-cache.ts`)

- The directory is created 0700. An existing directory owned by this uid is chmod-ed back to 0700. A symlinked cache
  dir, or one owned by another user, is not used.
- Entries and temp files are written 0600 with exclusive create (`wx`), then renamed into place. Rename replaces a
  planted symlink and never writes through it.
- A read accepts only regular files (`lstat`). The meta must name this exact key and the bytes must match the recorded
  sha256. Anything else is a miss.
- A cache dir inside the scanned root is refused and the scan runs uncached. Symlinks are resolved first.
- The key schema was bumped to 3, so no pre-lockdown entry can ever hit.
- The server's cache is `<OKIE_SCAN_ROOT>/cache/rust-scip` (`rustIndexCacheDir(store)`). The extracted tree is a fresh
  per-scan dir under the scanner work root (`scanWorkDir()`), never under the cache, so the two are disjoint.

## Residual risks

- **Same uid, same filesystem.** The scan child and rust-analyzer run as the server user. rust-analyzer and cargo can
  read anything that uid can:
  - `include!("/etc/...")` during macro expansion;
  - `path = "../../.."` dependencies outside the tree.
  Nothing from outside the tree is emitted (the analyzer keeps only in-tree documents), but it is read.
- **`cargo metadata` still runs** on repository manifests. It is offline, with pinned rustc and no wrappers. It parses
  `Cargo.toml` and `.cargo/config.toml` and may write `Cargo.lock` into the tree. It executes no repository code in
  the vectors we know of.
- **rust-analyzer itself** parses and type-checks hostile input. A parser or proc-macro-server bug is not contained
  beyond the process limits.
- **The network is not blocked.** No repository code runs, so nothing should use it, but nothing prevents it.
- **Other toolchain versions.** The findings are for rust-analyzer 1.87. A later rust-analyzer may honour more config
  keys, or read `rust-analyzer.toml` in `scip`. `analyze-rust-lockdown.test.ts` is the tripwire: it fails if any
  payload runs.
- **Ancestor directories.** These are mitigated by the private work root, the ownership check and the ancestor
  `rust-project.json` refusal. What remains trusted is operator-owned ancestor cargo config and manifests (noted in
  limitations, keyed in the cache) and root-owned directories.
- **Memory of rust-analyzer** is uncapped; see above.
- **Local CLI scans** of a user's own checkout run git in that repository. `core.fsmonitor` is disabled, but other
  local `.git/config` behaviour is trusted as the user's own.

## Next: Cloudflare Containers (CLA-266)

The goal is to move the scan child into a disposable sandbox (a container on gVisor or Firecracker):

- No network (the tarball is fetched by the parent and mounted).
- No secrets in the image or env.
- The source is mounted read-only.
- A writable scratch tmp only.
- A distinct uid per scan.
- cgroup limits for CPU, memory, pids and disk.
- A seccomp profile.
- Per-scan cache namespaces, or a read-only shared cache written only by a trusted indexer.

The process boundary built here, with its IPC-only input and structured result, is the seam the container replaces.

## Tests

- `packages/scan/src/analyze-rust-lockdown.test.ts`
  - Generates a workspace with a build script, a proc macro, rustc wrappers, `build.rustc`, a path toolchain and
    `rust-analyzer.toml`. Each payload writes only a marker, to an absolute temp path baked in at generation time.
    Asserts that no marker appears and that the index is still produced.
  - Asserts the `rust-project.json` refusal.
  - Against the pre-fix code, the same test fails with markers
    `build-rustc, build-script, proc-macro, rustc-workspace-wrapper, rustc-wrapper, toolchain-rustc`.
- `packages/scan/src/analyze-rust-toolchain.test.ts`: an unusable scanner toolchain gives `unavailable` coverage with a
  limitation naming it. `analyze-rust.test.ts` asserts the okie worktree itself is indexed `semantic` under the default.
- `packages/scan/src/scan-env.test.ts`: fake secrets in `process.env` never reach a spawned child. Checked through the
  observer seam and by running `env` through the helper. HOME and CARGO_HOME are private scratch.
- `packages/scan/src/rust-ancestors.test.ts`:
  - fake-filesystem ancestors: `/tmp` 1777, a group-writable dir and another user's dir are refused; ancestor
    `rust-project.json` in any case is refused; ancestor cargo config and manifests are noted and keyed;
  - on the real filesystem: a planted parent `Rust-Project.json` and a group-writable parent stop analysis before
    rust-analyzer runs, and changing an ancestor config misses the cache.
- `packages/scan/src/scip-cache.test.ts`: permissions, symlink rejection, meta/key binding, refusal of a cache dir inside
  the tree, and the CARGO_HOME opt-in in the key.
- `apps/server/src/scanWorker.test.ts`:
  - the child is a separate process with no server secrets in its env, and the heap cap and ulimits apply;
  - the timeout and cancellation kill it;
  - a child killed on timeout leaves nothing under the work root, and the group kill reaches its grandchild `sleep`;
  - concurrency and FIFO order are unchanged.
