import { scrubGithubTokens } from "./redact.js";

/** Cap nearby test files per code entity so packets stay bounded. */
export const MAX_NEARBY_TESTS = 3;
/** Header / symbol-window lines included per nearby test. */
export const MAX_NEARBY_TEST_LINES = 12;

export interface NearbyTestExcerpt {
  path: string;
  startLine: number;
  endLine: number;
  lines: string[];
}

const TEST_SUFFIXES = [
  ".test.ts",
  ".test.tsx",
  ".spec.ts",
  ".spec.tsx",
  ".test.mts",
  ".spec.mts",
  ".test.cts",
  ".spec.cts",
  ".test.mjs",
  ".spec.mjs",
  ".test.cjs",
  ".spec.cjs",
  ".test.js",
  ".spec.js",
  ".test.jsx",
  ".spec.jsx",
] as const;

const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/;

function stemAndDir(path: string): { dir: string; stem: string } | undefined {
  const slash = path.lastIndexOf("/");
  const file = slash >= 0 ? path.slice(slash + 1) : path;
  const dir = slash >= 0 ? path.slice(0, slash) : "";
  const stem = file.replace(SOURCE_EXTENSION, "");
  if (!stem || stem === file) return undefined;
  return { dir, stem };
}

/**
 * Conventional sibling test paths for a source file. Same directory first, then
 * `__tests__/<stem>.test.ts` in that directory. Never walks the whole repo.
 */
export function nearbyTestCandidatePaths(sourcePath: string): string[] {
  const parsed = stemAndDir(sourcePath);
  if (!parsed) return [];
  const { dir, stem } = parsed;
  const prefix = dir ? `${dir}/` : "";
  const paths: string[] = [];
  for (const suffix of TEST_SUFFIXES) paths.push(`${prefix}${stem}${suffix}`);
  for (const suffix of TEST_SUFFIXES) paths.push(`${prefix}__tests__/${stem}${suffix}`);
  return paths;
}

function symbolMentions(text: string, symbol: string | undefined): boolean {
  if (!symbol) return true;
  const needle = symbol.replace(/[()]/g, "").trim();
  if (!needle) return true;
  return text.includes(needle);
}

function excerptLines(text: string, symbol: string | undefined): { startLine: number; lines: string[] } {
  const all = scrubGithubTokens(text.replace(/\r\n/g, "\n")).split("\n");
  if (!symbol) {
    const lines = all.slice(0, MAX_NEARBY_TEST_LINES);
    return { startLine: 1, lines };
  }
  const needle = symbol.replace(/[()]/g, "").trim();
  const hit = all.findIndex(line => line.includes(needle));
  if (hit < 0) {
    const lines = all.slice(0, MAX_NEARBY_TEST_LINES);
    return { startLine: 1, lines };
  }
  const start = Math.max(0, hit - 2);
  const lines = all.slice(start, start + MAX_NEARBY_TEST_LINES);
  return { startLine: start + 1, lines };
}

/**
 * Bounded sibling-test excerpts for one code entity. Missing files are not an
 * error. Tokens are scrubbed. Test paths stay off `scopePaths` — they are
 * context, not citable extraction sourceRefs.
 */
export function nearbyTestsForCode(
  sourcePath: string,
  symbol: string | undefined,
  readFile: (repoRelativePath: string) => string,
): NearbyTestExcerpt[] {
  const found: NearbyTestExcerpt[] = [];
  for (const path of nearbyTestCandidatePaths(sourcePath)) {
    if (found.length >= MAX_NEARBY_TESTS) break;
    let text: string;
    try {
      text = readFile(path);
    } catch {
      continue;
    }
    if (!text.trim()) continue;
    if (!symbolMentions(text, symbol)) continue;
    const excerpt = excerptLines(text, symbol);
    if (excerpt.lines.length === 0) continue;
    found.push({
      path,
      startLine: excerpt.startLine,
      endLine: excerpt.startLine + excerpt.lines.length - 1,
      lines: excerpt.lines,
    });
  }
  return found;
}
