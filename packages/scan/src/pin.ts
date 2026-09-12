import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * An immutable pin of the scanned source. `commitSha` is the REAL commit (unlike
 * the golden fixture's synthetic revision); `generatedAt` is the commit's own
 * committer date, NOT wall-clock — so a re-scan of the same commit is byte-identical.
 */
export interface RepositoryPin {
  commitSha: string;
  treeHash: string;
  /** ISO-8601 committer date of `commitSha`. Input-derived, never `Date.now()`. */
  generatedAt: string;
}

function git(sourceRoot: string, args: readonly string[]): string {
  return execFileSync("git", ['--no-replace-objects', ...args], { cwd: sourceRoot, encoding: "utf8" }).trim();
}

/** Resolves a local revision to its immutable commit identity. */
export function pinRepository(sourceRoot: string, revision = "HEAD"): RepositoryPin {
  const commitSha = git(sourceRoot, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]);
  const treeHash = git(sourceRoot, ["rev-parse", `${commitSha}^{tree}`]);
  const generatedAt = new Date(git(sourceRoot, ["show", "-s", "--format=%cI", commitSha])).toISOString();
  return { commitSha, treeHash, generatedAt };
}

/** A temporary filesystem view containing only one committed Git tree. */
export interface AcquiredCommittedTree {
  root: string;
  pin: RepositoryPin;
  sourceName: string;
  cleanup(): void;
}

/**
 * Materializes a committed tree without reading, changing, or checking out the
 * caller's working tree. Dirty and untracked files are absent by construction.
 */
export function acquireCommittedTree(sourceRoot: string, revision = "HEAD"): AcquiredCommittedTree {
  const pin = pinRepository(sourceRoot, revision);
  const sourceName = basename(git(sourceRoot, ['rev-parse', '--show-toplevel']));
  const temporary = mkdtempSync(join(tmpdir(), "okie-committed-"));
  const root = join(temporary, sourceName);
  try {
    mkdirSync(root);
    // Read raw blobs: git archive applies export-ignore/export-subst attributes,
    // and checkout can run filters. Neither is an exact view of committed bytes.
    const listing = execFileSync('git', ['--no-replace-objects', 'ls-tree', '-rz', '--full-tree', pin.commitSha], { cwd: sourceRoot, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
    const entries = listing.split('\0').filter(Boolean).map(entry => {
      const tab = entry.indexOf('\t');
      const [mode, kind, hash] = entry.slice(0, tab).split(' ');
      const path = entry.slice(tab + 1);
      if (tab < 0 || !hash || path.split('/').some(part => !part || part === '..' || part === '.') || path.includes('\\')) throw new Error('Unsupported committed source path.');
      if (kind !== 'blob' || mode === '120000') throw new Error(`Committed source requires materialized files; symlink/submodule is unsupported: ${path}`);
      return { hash, path, mode };
    });
    const blobs = execFileSync('git', ['--no-replace-objects', 'cat-file', '--batch'], { cwd: sourceRoot, input: entries.map(entry => entry.hash + '\n').join(''), maxBuffer: 128 * 1024 * 1024 });
    let offset = 0;
    for (const entry of entries) {
      const newline = blobs.indexOf(10, offset);
      const [hash, kind, sizeText] = blobs.subarray(offset, newline).toString('utf8').split(' ');
      const size = Number(sizeText);
      if (newline < offset || hash !== entry.hash || kind !== 'blob' || !Number.isSafeInteger(size) || size < 0 || newline + 1 + size >= blobs.length) throw new Error('Incomplete committed source blob.');
      const target = join(root, entry.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, blobs.subarray(newline + 1, newline + 1 + size), { mode: entry.mode === '100755' ? 0o755 : 0o644 });
      offset = newline + 1 + size + 1;
    }
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  let cleaned = false;
  return {
    root,
    pin,
    sourceName,
    cleanup: () => {
      if (!cleaned) rmSync(temporary, { recursive: true, force: true });
      cleaned = true;
    },
  };
}
