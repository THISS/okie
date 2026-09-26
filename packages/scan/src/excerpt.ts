import {
  SOURCE_EXCERPT_LIMITS,
  type ArchitectureSnapshot,
  type SourceExcerpt,
  type SourceLanguage,
} from "@okie/architecture";
import { scrubGithubTokens } from "./redact.js";

/** Same extension map as snapshot validation — unsupported files stay excerpt-less. */
export function languageForScanPath(path: string): SourceLanguage | undefined {
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) return "javascript";
  if (path.endsWith(".rs")) return "rust";
  return undefined;
}

function unicodeLength(value: string): number {
  return [...value].length;
}

export type PortableExcerptInput = {
  path: string;
  symbol?: string;
  startLine: number;
  endLine: number;
  frozenRevision: string;
  fileText: string;
};

/**
 * Bounded, commit-pinned source window for one observed code ref. Clamps to
 * architecture excerpt limits and scrubs GitHub-token shapes so a planted
 * credential cannot land in the portable snapshot.
 *
 * An overlong first line (over `maxLineCharacters`) is skipped so the window
 * can still start on the next usable line. Lines are never truncated and the
 * original observed range is retained so partial capture is explicit.
 */
export function portableSourceExcerpt(input: PortableExcerptInput): SourceExcerpt | undefined {
  const language = languageForScanPath(input.path);
  if (!language) return undefined;
  const fileLines = input.fileText.replace(/\r\n/g, "\n").split("\n");
  const originalStart = input.startLine;
  if (!Number.isSafeInteger(originalStart) || originalStart < 1 || originalStart > fileLines.length) {
    return undefined;
  }
  if (!Number.isSafeInteger(input.endLine) || input.endLine < originalStart) return undefined;
  const maxEnd = Math.min(fileLines.length, input.endLine);
  const lines: string[] = [];
  let startLine = originalStart;
  let characters = 0;
  for (let lineNumber = originalStart; lineNumber <= maxEnd; lineNumber += 1) {
    const line = scrubGithubTokens(fileLines[lineNumber - 1]!);
    const length = unicodeLength(line);
    if (length > SOURCE_EXCERPT_LIMITS.maxLineCharacters) {
      if (lines.length) break;
      startLine = lineNumber + 1;
      continue;
    }
    const nextCharacters = characters + length + (lines.length ? 1 : 0);
    if (nextCharacters > SOURCE_EXCERPT_LIMITS.maxTextCharacters) break;
    lines.push(line);
    characters = nextCharacters;
    if (lines.length === SOURCE_EXCERPT_LIMITS.maxLines) break;
  }
  if (!lines.length) return undefined;
  return {
    path: input.path,
    ...(input.symbol ? { symbol: input.symbol } : {}),
    language, startLine, endLine: startLine + lines.length - 1,
    sourceStartLine: originalStart, sourceEndLine: input.endLine,
    highlightLine: startLine, frozenRevision: input.frozenRevision,
    lines, text: lines.join("\n"),
  };
}

/**
 * Host-owned snapshot step: attach a portable excerpt onto scanned *code*
 * entities. Extraction documents stay excerpt-free (pipeline-owned field).
 * Containers and other kinds are unchanged so Source stays disabled for them.
 */
export function attachPortableSourceExcerpts(
  snapshot: ArchitectureSnapshot,
  readFile: (repoRelativePath: string) => string,
): ArchitectureSnapshot {
  const files = new Map<string, string | undefined>();
  const load = (path: string): string | undefined => {
    if (files.has(path)) return files.get(path);
    try {
      const text = readFile(path);
      files.set(path, text);
      return text;
    } catch {
      files.set(path, undefined);
      return undefined;
    }
  };

  return {
    ...snapshot,
    entities: snapshot.entities.map(entity => {
      if (entity.kind !== "code") return entity;
      const ref = entity.sourceRefs[0];
      if (!ref?.startLine || ref.endLine === undefined) return entity;
      const fileText = load(ref.path);
      if (fileText === undefined) return entity;
      const excerpt = portableSourceExcerpt({
        path: ref.path,
        ...(ref.symbol ? { symbol: ref.symbol } : {}),
        startLine: ref.startLine,
        endLine: ref.endLine,
        frozenRevision: snapshot.commitSha,
        fileText,
      });
      if (!excerpt) return entity;
      return {
        ...entity,
        sourceExcerpts: [excerpt],
      };
    }),
  };
}
