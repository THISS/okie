import { execFileSync } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { slug } from "./ids.js";

/**
 * A parsed `gh:owner/repo[@ref]` source. `ref` may be a branch, tag, or SHA and can
 * itself contain `/` (e.g. `release/1.x`); it is everything after the first `@`.
 * `dirSlug` is the per-repo output directory name (`<owner>__<repo>`, both slugified),
 * kept URL/filesystem-safe so the web app can select a scanned repo by slug.
 */
export interface GithubSourceRef {
  owner: string;
  repo: string;
  ref?: string;
  dirSlug: string;
}

/** The default cap on a downloaded tarball (uncompressed transfer). Clear error above it. */
export const DEFAULT_MAX_TARBALL_BYTES = 150 * 1024 * 1024;

/** A distinct error type so the CLI can print acquisition failures without a stack trace. */
export class GithubAcquisitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubAcquisitionError";
  }
}

/** True for a `gh:owner/repo[...]` source string (vs a local path). */
export function isGithubSource(source: string): boolean {
  return source.startsWith("gh:");
}

/**
 * Parses `gh:owner/repo`, `gh:owner/repo@ref`. Owner/repo are the GitHub-legal
 * `[A-Za-z0-9._-]` sets; ref is free-form (branch/tag/sha). Returns undefined for a
 * non-`gh:` or malformed source so the caller can fall back to local-path scanning.
 */
export function parseGithubSource(source: string): GithubSourceRef | undefined {
  if (!isGithubSource(source)) return undefined;
  const match = /^gh:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:@(.+))?$/.exec(source.trim());
  if (!match) return undefined;
  const [, owner, repo, ref] = match;
  const dirSlug = `${slug(owner!)}__${slug(repo!)}`;
  return { owner: owner!, repo: repo!, ...(ref ? { ref } : {}), dirSlug };
}

export function repoApiPath(owner: string, repo: string): string {
  return `/repos/${owner}/${repo}`;
}

export function commitApiPath(owner: string, repo: string, ref: string): string {
  return `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`;
}

export function tarballUrl(owner: string, repo: string, sha: string): string {
  return `https://codeload.github.com/${owner}/${repo}/tar.gz/${sha}`;
}

/** The immutable commit identity resolved from a ref, feeding the snapshot pin. */
export interface ResolvedCommit {
  sha: string;
  /** ISO-8601 committer date, input-derived (never wall-clock) — the determinism anchor. */
  generatedAt: string;
  treeSha: string;
}

/**
 * Interprets a GitHub `/commits/{ref}` response into the pin fields. Pure and total:
 * throws a clear error on any missing field so a malformed/HTML response can never
 * silently yield an empty pin. `committer.date` (not author date) mirrors the local
 * pin's `git show %cI`, normalized through `Date` so both paths format identically.
 */
export function interpretCommitResponse(json: unknown): ResolvedCommit {
  const record = json as {
    sha?: unknown;
    commit?: { committer?: { date?: unknown }; author?: { date?: unknown }; tree?: { sha?: unknown } };
  };
  const sha = typeof record.sha === "string" ? record.sha : undefined;
  const rawDate = record.commit?.committer?.date ?? record.commit?.author?.date;
  const date = typeof rawDate === "string" ? rawDate : undefined;
  const treeSha = typeof record.commit?.tree?.sha === "string" ? record.commit.tree.sha : undefined;
  if (!sha || !date || !treeSha) {
    throw new GithubAcquisitionError("GitHub commit response missing sha/date/tree — not a valid public repo commit.");
  }
  return { sha, generatedAt: new Date(date).toISOString(), treeSha };
}

/** Extracts `default_branch` from a `/repos/{o}/{r}` response. */
export function interpretRepoResponse(json: unknown): string {
  const branch = (json as { default_branch?: unknown }).default_branch;
  if (typeof branch !== "string" || !branch) {
    throw new GithubAcquisitionError("GitHub repository response missing default_branch — repo not found or private.");
  }
  return branch;
}

export type GithubJsonResult =
  | { ok: true; json: unknown }
  | { ok: false; status: number; rateLimited: boolean; message: string };

/**
 * Transport for GitHub reads. The default implementation calls the REST API
 * unauthenticated and transparently falls back to the `gh` CLI (which carries the
 * operator's auth) on rate-limit/403/404 — so public repos need no token and private
 * ones work wherever `gh` is logged in. Injected in tests to exercise resolution and
 * fallback logic offline against recorded fixtures.
 */
export interface GithubClient {
  getJson(apiPath: string): Promise<GithubJsonResult>;
  /** Downloads the repo tarball at `sha` into `destFile`; returns bytes written. */
  downloadTarball(owner: string, repo: string, sha: string, destFile: string, maxBytes: number): Promise<number>;
}

function ghAvailable(): boolean {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function ghApiJson(apiPath: string): unknown {
  const endpoint = apiPath.replace(/^\//, "");
  const out = execFileSync("gh", ["api", endpoint], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

const GITHUB_HEADERS = {
  // GitHub requires a User-Agent; Accept pins the v3 JSON media type. No auth header —
  // tokens are never read from env or embedded; `gh` handles auth in the fallback path.
  "User-Agent": "okie-scan",
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;

function isRateLimited(status: number, headers: Headers): boolean {
  if (status === 429) return true;
  return status === 403 && headers.get("x-ratelimit-remaining") === "0";
}

/** The production client: anonymous HTTPS first, `gh` CLI fallback for auth/limits. */
export function createDefaultGithubClient(): GithubClient {
  return {
    async getJson(apiPath) {
      let anonStatus = 0;
      let anonRateLimited = false;
      try {
        const response = await fetch(`https://api.github.com${apiPath}`, { headers: GITHUB_HEADERS });
        if (response.ok) return { ok: true, json: await response.json() };
        anonStatus = response.status;
        anonRateLimited = isRateLimited(response.status, response.headers);
      } catch (error) {
        // Network failure — fall through to gh if available, else report it.
        anonStatus = 0;
        void error;
      }
      // Fall back to gh for rate-limits, auth walls (403/401), private-repo 404s, or a
      // network hiccup — anything the anonymous call could not satisfy on its own.
      if (ghAvailable()) {
        try {
          return { ok: true, json: ghApiJson(apiPath) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, status: anonStatus || 502, rateLimited: anonRateLimited, message: `gh api failed: ${scrub(message)}` };
        }
      }
      return {
        ok: false,
        status: anonStatus || 502,
        rateLimited: anonRateLimited,
        message: anonRateLimited
          ? "GitHub API rate limit reached for anonymous access and the gh CLI is not available (install/auth `gh`)."
          : `GitHub API request failed (status ${anonStatus || "network error"}).`,
      };
    },

    async downloadTarball(owner, repo, sha, destFile, maxBytes) {
      // Anonymous codeload first.
      try {
        const response = await fetch(tarballUrl(owner, repo, sha), { headers: { "User-Agent": GITHUB_HEADERS["User-Agent"] } });
        if (response.ok && response.body) {
          const declared = Number(response.headers.get("content-length") ?? "");
          if (Number.isFinite(declared) && declared > maxBytes) {
            throw new GithubAcquisitionError(tooBigMessage(declared, maxBytes));
          }
          return await streamToFileWithCap(response.body, destFile, maxBytes);
        }
        if (!isRateLimited(response.status, response.headers) && response.status !== 403 && response.status !== 404) {
          throw new GithubAcquisitionError(`Tarball download failed (status ${response.status}).`);
        }
      } catch (error) {
        if (error instanceof GithubAcquisitionError) throw error;
        // network error — try gh below
      }
      // gh fallback: `gh api .../tarball/{sha}` streams the archive with auth.
      if (ghAvailable()) {
        const buffer = execFileSync("gh", ["api", `repos/${owner}/${repo}/tarball/${sha}`], {
          encoding: "buffer",
          maxBuffer: maxBytes + 1,
        });
        if (buffer.length > maxBytes) throw new GithubAcquisitionError(tooBigMessage(buffer.length, maxBytes));
        await pipeline(Readable.from(buffer), createWriteStream(destFile));
        return buffer.length;
      }
      throw new GithubAcquisitionError("Could not download tarball anonymously and the gh CLI is not available.");
    },
  };
}

function tooBigMessage(bytes: number, maxBytes: number): string {
  return `Tarball is ${(bytes / 1024 / 1024).toFixed(1)} MB, over the ${(maxBytes / 1024 / 1024).toFixed(0)} MB cap (raise with --max-tarball-mb).`;
}

/** Redacts anything token-shaped from a message before it can reach a log. */
function scrub(message: string): string {
  return message
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted-token]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[redacted-token]");
}

async function streamToFileWithCap(body: ReadableStream<Uint8Array>, destFile: string, maxBytes: number): Promise<number> {
  let total = 0;
  const capper = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(new GithubAcquisitionError(tooBigMessage(total, maxBytes)));
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]), capper, createWriteStream(destFile));
  } catch (error) {
    rmSync(destFile, { force: true });
    throw error instanceof GithubAcquisitionError ? error : new GithubAcquisitionError(`Tarball download failed: ${scrub(String(error))}`);
  }
  return total;
}

/**
 * Resolves a `gh:` ref to an immutable commit: default branch when no ref is given,
 * then the commit's SHA + committer date + tree SHA. Distinguishes not-found (bad
 * owner/repo/ref) from rate-limited so the CLI can print an actionable message.
 */
export async function resolveGithubCommit(src: GithubSourceRef, client: GithubClient): Promise<ResolvedCommit> {
  let ref = src.ref;
  if (!ref) {
    const repoResult = await client.getJson(repoApiPath(src.owner, src.repo));
    if (!repoResult.ok) throw acquisitionError(src, repoResult, "repository");
    ref = interpretRepoResponse(repoResult.json);
  }
  const commitResult = await client.getJson(commitApiPath(src.owner, src.repo, ref));
  if (!commitResult.ok) throw acquisitionError(src, commitResult, `ref “${ref}”`);
  return interpretCommitResponse(commitResult.json);
}

function acquisitionError(src: GithubSourceRef, result: { status: number; rateLimited: boolean; message: string }, what: string): GithubAcquisitionError {
  if (result.rateLimited) return new GithubAcquisitionError(result.message);
  if (result.status === 404) {
    return new GithubAcquisitionError(`GitHub ${what} not found for ${src.owner}/${src.repo} (check the owner/repo/ref, or that the repo is public).`);
  }
  return new GithubAcquisitionError(result.message);
}

/** An acquired, extracted tree ready to scan, plus a cleanup that discards the temp dir. */
export interface AcquiredTree {
  /** Absolute path to the extracted repository root (the tarball's single top-level dir). */
  root: string;
  cleanup: () => void;
}

/**
 * Downloads the tarball at `sha` into a fresh temp dir, extracts it, and returns the
 * repository root. Ephemeral by contract: the caller scans then calls `cleanup()`;
 * nothing long-lived is kept (the pin's commit/tree SHA is the identity). Extraction
 * shells out to `tar` (present on macOS/Linux, as this repo already assumes for git).
 */
export async function acquireGithubTree(src: GithubSourceRef, sha: string, client: GithubClient, maxBytes = DEFAULT_MAX_TARBALL_BYTES): Promise<AcquiredTree> {
  const workDir = mkdtempSync(join(tmpdir(), "okie-scan-gh-"));
  const cleanup = () => rmSync(workDir, { recursive: true, force: true });
  try {
    const tarPath = join(workDir, "repo.tar.gz");
    await client.downloadTarball(src.owner, src.repo, sha, tarPath, maxBytes);
    const extractDir = join(workDir, "tree");
    mkdirSync(extractDir, { recursive: true });
    try {
      execFileSync("tar", ["-xzf", tarPath, "-C", extractDir], { stdio: "ignore" });
    } catch (error) {
      throw new GithubAcquisitionError(`Failed to extract tarball (is it a gzip archive?): ${scrub(String(error))}`);
    }
    // GitHub archives contain a single top-level dir: `{repo}-{sha}` (or similar).
    const entries = readdirSync(extractDir, { withFileTypes: true }).filter(entry => entry.isDirectory());
    if (entries.length !== 1) {
      throw new GithubAcquisitionError(`Unexpected tarball layout: expected one top-level directory, found ${entries.length}.`);
    }
    const root = join(extractDir, entries[0]!.name);
    if (!statSync(root).isDirectory()) throw new GithubAcquisitionError("Extracted tarball root is not a directory.");
    return { root, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
