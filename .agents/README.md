# Amp orb environment

`setup` installs the locked pnpm dependencies, the repository's Rust toolchain
and WASM target, CI's Rust analyzer components, and wasm-pack 0.13.1. It also
builds workspace packages and generates the stress fixture and optimized WASM.
Node 22+ and npm come from the orb base image. No API keys, live scans, databases,
or authentication are needed for this setup.

Amp snapshots the installed tools, dependency caches, and generated outputs.
An exact snapshot skips setup; stale snapshots rerun it using the cached files.
The first measured run took about 3.5 minutes, mostly compiling WASM; warm runs
took about 49 seconds. `resume` deliberately does no installation or server work.

Rust is added to the login-shell PATH. In a thread already running when setup
is first installed, use `bash -lc '<command>'` until the next normal activation.

Follow `CLAUDE.md` for checks and development commands. The scan tests create
temporary Git repositories. If the orb's global Git configuration requires
signing but has no key for those repositories, run the test suite with a
process-local override (do not disable signing globally):

```sh
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false pnpm test
```

For a web preview, start the scan server and Vite using `amp orb service start`
rather than background shell processes. Setup does not start services or expose
the unauthenticated scan server.
