import { execFileSync } from "node:child_process";

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
  return execFileSync("git", args, { cwd: sourceRoot, encoding: "utf8" }).trim();
}

/** Pins the working tree at its current HEAD commit, tree hash, and committer date. */
export function pinRepository(sourceRoot: string): RepositoryPin {
  const commitSha = git(sourceRoot, ["rev-parse", "HEAD"]);
  const treeHash = git(sourceRoot, ["rev-parse", "HEAD^{tree}"]);
  const generatedAt = new Date(git(sourceRoot, ["show", "-s", "--format=%cI", "HEAD"])).toISOString();
  return { commitSha, treeHash, generatedAt };
}
