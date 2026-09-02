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

function excerptWithinLimits(lines: readonly string[]): boolean {
  if (lines.length < 1 || lines.length > SOURCE_EXCERPT_LIMITS.maxLines) return false;
  if (lines.some(line => unicodeLength(line) > SOURCE_EXCERPT_LIMITS.maxLineCharacters)) return false;
  return unicodeLength(lines.join("\n")) <= SOURCE_EXCERPT_LIMITS.maxTextCharacters;
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
 */
export function portableSourceExcerpt(input: PortableExcerptInput): SourceExcerpt | undefined {
  const language = languageForScanPath(input.path);
  if (!language) return undefined;
  const fileLines = input.fileText.replace(/\r\n/g, "\n").split("\n");
  const startLine = input.startLine;
  if (!Number.isSafeInteger(startLine) || startLine < 1 || startLine > fileLines.length) return undefined;
  const declaredEnd = Number.isSafeInteger(input.endLine) ? input.endLine : startLine;
  const maxEnd = Math.min(fileLines.length, Math.max(startLine, declaredEnd));
  let endLine = Math.min(maxEnd, startLine + SOURCE_EXCERPT_LIMITS.maxLines - 1);
  while (endLine >= startLine) {
    const lines = fileLines.slice(startLine - 1, endLine).map(line => scrubGithubTokens(line));
    if (excerptWithinLimits(lines)) {
      return {
        path: input.path,
        ...(input.symbol ? { symbol: input.symbol } : {}),
        language,
        startLine,
        endLine,
        highlightLine: startLine,
        frozenRevision: input.frozenRevision,
        lines,
        text: lines.join("\n"),
      };
    }
    endLine -= 1;
  }
  return undefined;
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
      if (!ref?.startLine) return entity;
      const fileText = load(ref.path);
      if (fileText === undefined) return entity;
      const excerpt = portableSourceExcerpt({
        path: ref.path,
        ...(ref.symbol ? { symbol: ref.symbol } : {}),
        startLine: ref.startLine,
        endLine: ref.endLine ?? ref.startLine,
        frozenRevision: snapshot.commitSha,
        fileText,
      });
      if (!excerpt) return entity;
      return {
        ...entity,
        sourceRefs: entity.sourceRefs.map((item, index) => index === 0
          ? { ...item, startLine: excerpt.startLine, endLine: excerpt.endLine }
          : item),
        sourceExcerpts: [excerpt],
      };
    }),
  };
}
