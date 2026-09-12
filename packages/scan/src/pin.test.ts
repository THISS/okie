import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireCommittedTree, pinRepository } from "./pin.js";
import { scanRepository } from "./scan.js";

const gitEnv = { ...process.env, PATH: `/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH ?? ""}` };

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, env: gitEnv, encoding: "utf8" }).trim();
}

test("local scans and prompt source acquisition use only the selected committed revision", () => {
  const root = mkdtempSync(join(tmpdir(), "okie-committed-source-"));
  try {
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "okie@example.test"]);
    git(root, ["config", "user.name", "Okie"]);
    writeFileSync(join(root, "package.json"), '{"name":"committed-source"}\n');
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "main.ts"), "export function firstRevision() { return 1; }\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "first"]);
    const first = git(root, ["rev-parse", "HEAD"]);

    writeFileSync(join(root, "src", "main.ts"), "export function secondRevision() { return 2; }\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "second"]);
    const second = git(root, ["rev-parse", "HEAD"]);

    // These must never affect a committed scan, even though they are ordinary source files.
    writeFileSync(join(root, "src", "main.ts"), "export function dirtyWorkingFile() { return 3; }\n");
    writeFileSync(join(root, "src", "untracked.ts"), "export function untrackedWorkingFile() { return 4; }\n");

    const acquired = acquireCommittedTree(root);
    try {
      assert.equal(acquired.pin.commitSha, second);
      assert.equal(acquired.root.includes(root), false, "the committed view is a separate temporary tree");
      assert.match(readFileSync(join(acquired.root, "src", "main.ts"), "utf8"), /secondRevision/);
    } finally {
      acquired.cleanup();
    }

    const head = scanRepository(root);
    const old = scanRepository(root, { revision: first });
    const headNames = head.snapshot.entities.map(entity => entity.name).join("\n");
    const oldNames = old.snapshot.entities.map(entity => entity.name).join("\n");
    assert.equal(head.pin.commitSha, second);
    assert.match(headNames, /secondRevision/);
    assert.doesNotMatch(headNames, /dirtyWorkingFile|untrackedWorkingFile/);
    assert.equal(old.pin.commitSha, first);
    assert.match(oldNames, /firstRevision/);
    assert.doesNotMatch(oldNames, /secondRevision|dirtyWorkingFile|untrackedWorkingFile/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw committed acquisition ignores archive transformations and keeps unnamed repo identity stable", () => {
  const root = mkdtempSync(join(tmpdir(), "okie-raw-source-"));
  try {
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "okie@example.test"]);
    git(root, ["config", "user.name", "Okie"]);
    writeFileSync(join(root, ".gitattributes"), "hidden.ts export-ignore\nmain.ts export-subst\n");
    writeFileSync(join(root, "hidden.ts"), "export const hidden = 1;\n");
    const source = 'export const revision = "$Format:%H$";\n';
    writeFileSync(join(root, "main.ts"), source);
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "source"]);
    const acquired = acquireCommittedTree(root);
    try {
      assert.equal(readFileSync(join(acquired.root, "main.ts"), "utf8"), source);
      assert.equal(readFileSync(join(acquired.root, "hidden.ts"), "utf8"), "export const hidden = 1;\n");
    } finally { acquired.cleanup(); }
    assert.deepEqual(scanRepository(root), scanRepository(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pins and acquired trees ignore Git replacement refs", () => {
  const root = mkdtempSync(join(tmpdir(), "okie-replace-ref-"));
  try {
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.email", "okie@example.test"]);
    git(root, ["config", "user.name", "Okie"]);
    writeFileSync(join(root, "package.json"), '{"name":"replace-ref"}\n');
    writeFileSync(join(root, "main.ts"), "export const revision = 'first';\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "first"]);
    const first = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(join(root, "main.ts"), "export const revision = 'second';\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "second"]);
    const second = git(root, ["rev-parse", "HEAD"]);

    // Without --no-replace-objects, Git resolves HEAD's tree through this ref.
    git(root, ["replace", second, first]);
    assert.notEqual(git(root, ["rev-parse", "HEAD^{tree}"]), git(root, ["--no-replace-objects", "rev-parse", "HEAD^{tree}"]));

    const pin = pinRepository(root);
    assert.equal(pin.commitSha, second);
    const acquired = acquireCommittedTree(root);
    try {
      assert.equal(acquired.pin.commitSha, second);
      assert.equal(readFileSync(join(acquired.root, "main.ts"), "utf8"), "export const revision = 'second';\n");
    } finally {
      acquired.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
