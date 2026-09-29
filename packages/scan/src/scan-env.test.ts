import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { discoverRepository } from "./discover.js";
import { pinRepository } from "./pin.js";
import { createScanScratch, observeScanSpawns, operatorCargoHome, sanitizedPath, scanChildEnv, scanExecFileSync, type ScanChildKind } from "./scan-env.js";

const SECRETS: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-fake-cla305",
  OPENAI_API_KEY: "sk-fake-cla305",
  GITHUB_TOKEN: "ghp_fakecla305fakecla305fakecla305fake",
  GH_TOKEN: "gho_fakecla305fakecla305fakecla305fake",
  GITHUB_CLIENT_SECRET: "fake-client-secret-cla305",
  OKIE_SESSION_SECRET: "fake-session-secret-cla305",
  OKIE_LLM_GATEWAY_KEY: "fake-gateway-key-cla305",
  DATABASE_URL: "postgres://user:fake-dotenv-password-cla305@localhost/db",
  AWS_SECRET_ACCESS_KEY: "fake-aws-secret-cla305",
};
const FAKE_VALUES = Object.values(SECRETS);

function withSecrets<T>(body: () => T): T {
  const previous = Object.fromEntries(Object.keys(SECRETS).map(name => [name, process.env[name]]));
  Object.assign(process.env, SECRETS);
  try { return body(); } finally {
    for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

function assertClean(env: Record<string, string>, label: string, allowed: readonly string[] = []): void {
  for (const [name, value] of Object.entries(env)) {
    const leaked = FAKE_VALUES.filter(fake => value.includes(fake) && !allowed.includes(name));
    assert.deepEqual(leaked, [], `${label}: ${name} carries a secret`);
  }
  for (const name of Object.keys(SECRETS)) if (!allowed.includes(name)) assert.equal(env[name], undefined, `${label}: ${name} passed through`);
}

/** `env` output as a map (the environment a child actually received). */
function parseEnv(output: string): Record<string, string> {
  return Object.fromEntries(output.split("\n").filter(Boolean).map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

test("scan env: no secret reaches a scanner child; HOME and CARGO_HOME are private scratch", t => {
  if (process.platform === "win32") { t.skip("posix env(1)"); return; }
  const seen: Array<{ kind: ScanChildKind; file: string; args: readonly string[]; env: Record<string, string> }> = [];
  observeScanSpawns(spawn => { seen.push(spawn); });
  const repo = mkdtempSync(join(tmpdir(), "okie-scan-env-repo-"));
  try {
    withSecrets(() => {
      // Real scanner code paths: git via pin and discovery.
      execFileSync("git", ["init", "-q"], { cwd: repo });
      writeFileSync(join(repo, "index.ts"), "export const a = 1;\n");
      execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "."], { cwd: repo });
      execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
      pinRepository(repo);
      discoverRepository(repo);
      // What a child actually receives, for each kind.
      for (const kind of ["git", "rust"] as const) {
        const received = parseEnv(scanExecFileSync(kind, "env", [], { encoding: "utf8" }));
        assertClean(received, `${kind} child`);
        assert.equal(received.CARGO_NET_OFFLINE, "true");
        assert.equal(received.GIT_CONFIG_NOSYSTEM, "1"); assert.equal(received.GIT_CONFIG_GLOBAL, "/dev/null"); assert.equal(received.GIT_TERMINAL_PROMPT, "0");
        assert.equal(received.LC_ALL, "C.UTF-8");
        for (const name of ["HOME", "CARGO_HOME"]) {
          assert.ok(received[name]!.startsWith(tmpdir()) || received[name]!.startsWith("/private" + tmpdir()), `${kind}: ${name}=${received[name]} is scratch`);
          assert.notEqual(received[name], process.env.HOME);
        }
        assert.equal(statSync(join(received.HOME!, "..")).mode & 0o777, 0o700, "the scratch dir is private");
        if (kind === "rust") {
          assert.equal(received.RUSTUP_AUTO_INSTALL, "0");
          for (const name of ["RUSTC_WRAPPER", "CARGO_BUILD_RUSTC_WRAPPER", "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER"]) assert.equal(received[name], "", name);
        }
      }
      // gh (operator CLI fallback) is the one child that gets a GitHub token, and only that.
      const gh = scanChildEnv("gh");
      assertClean(gh, "gh child", ["GH_TOKEN", "GITHUB_TOKEN"]);
      assert.equal(gh.GH_TOKEN, SECRETS.GH_TOKEN); assert.equal(gh.GITHUB_TOKEN, SECRETS.GITHUB_TOKEN);
    });
    const gitSpawns = seen.filter(spawn => spawn.file === "git");
    // Each call site went through the helper: discovery's ls-files and pin's rev-parse.
    assert.ok(gitSpawns.some(spawn => spawn.args.includes("ls-files")), "discovery (git ls-files) spawned through the helper");
    assert.ok(gitSpawns.some(spawn => spawn.args.includes("rev-parse")), "pin (git rev-parse) spawned through the helper");
    for (const spawn of seen) assertClean(spawn.env, `${spawn.kind} ${spawn.file}`, spawn.kind === "gh" ? ["GH_TOKEN", "GITHUB_TOKEN"] : []);
  } finally { observeScanSpawns(undefined); rmSync(repo, { recursive: true, force: true }); }
});

test("scan env: PATH keeps absolute entries only; a per-scan scratch is private and removable", () => {
  const path = ["/usr/bin", "", ".", "node_modules/.bin", "./bin", "/bin"].join(delimiter);
  assert.equal(sanitizedPath(path), ["/usr/bin", "/bin"].join(delimiter));
  const scratch = createScanScratch();
  try {
    if (process.platform !== "win32") for (const dir of [scratch.dir, scratch.home, scratch.cargoHome]) assert.equal(statSync(dir).mode & 0o777, 0o700, dir);
    const env = scanChildEnv("rust", scratch);
    assert.equal(env.HOME, scratch.home); assert.equal(env.CARGO_HOME, scratch.cargoHome);
    // OKIE_SCAN_CARGO_HOME: absolute, credential-free dirs only.
    const registryOnly = join(scratch.dir, "registry-only"); mkdirSync(join(registryOnly, "registry"), { recursive: true });
    assert.deepEqual(operatorCargoHome({ OKIE_SCAN_CARGO_HOME: registryOnly }), { path: registryOnly });
    assert.equal(scanChildEnv("rust", scratch, { ...process.env, OKIE_SCAN_CARGO_HOME: registryOnly }).CARGO_HOME, registryOnly);
    assert.match(operatorCargoHome({ OKIE_SCAN_CARGO_HOME: "relative/cargo" }).error ?? "", /absolute/);
    writeFileSync(join(registryOnly, "credentials.toml"), "[registry]\ntoken = \"fake\"\n");
    assert.match(operatorCargoHome({ OKIE_SCAN_CARGO_HOME: registryOnly }).error ?? "", /holds cargo credentials/);
    assert.equal(scanChildEnv("rust", scratch, { ...process.env, OKIE_SCAN_CARGO_HOME: registryOnly }).CARGO_HOME, scratch.cargoHome, "a credentialed CARGO_HOME is never used");
  } finally { scratch.dispose(); }
  assert.throws(() => statSync(scratch.dir));
});
