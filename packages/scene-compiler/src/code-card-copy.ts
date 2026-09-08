import type { DisplayTextMode } from './display-text.js';

/**
 * L4 card IA (CLA-114): inside a file the parent path is already on the L3
 * shell. Cards show a kind badge, line range, and docstring/signature instead.
 */

export type CodeCardCopySource = {
  name?: string;
  source?: string;
  sourceRefs?: readonly {
    path?: string;
    symbol?: string;
    startLine?: number;
    endLine?: number;
  }[];
  sourceExcerpts?: readonly {
    startLine?: number;
    endLine?: number;
    lines?: readonly string[];
    text?: string;
  }[];
  responsibility?: string;
};

export type CodeCardCopy = {
  kicker: string;
  description?: string;
  descriptionMode: DisplayTextMode;
};

const FALLBACK_KIND = 'SOURCE';

function firstExcerpt(source: CodeCardCopySource) {
  return source.sourceExcerpts?.[0];
}

function firstRef(source: CodeCardCopySource) {
  return source.sourceRefs?.[0];
}

function excerptLines(source: CodeCardCopySource): string[] {
  const excerpt = firstExcerpt(source);
  if (excerpt?.lines?.length) return [...excerpt.lines];
  if (excerpt?.text) return excerpt.text.split('\n');
  return [];
}

function cleanDocLine(line: string): string {
  return line
    .replace(/^\s*\/\*+\s?/, '')
    .replace(/\s*\*+\/\s*$/, '')
    .replace(/^\s*\*\s?/, '')
    .replace(/^\s*\/\/\/?\s?/, '')
    .trim();
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//')
    || trimmed.startsWith('/*')
    || trimmed.startsWith('*')
    || trimmed.startsWith('///');
}

function isDocCommentStart(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('/**') || trimmed.startsWith('///') || trimmed.startsWith('//!');
}

/** First useful docstring sentence, else the first non-comment signature line. */
export function codeCardSignature(source: CodeCardCopySource): string | undefined {
  const lines = excerptLines(source).map(line => line.trimEnd());
  if (!lines.length) return undefined;
  const first = lines.find(line => line.trim());
  if (!first) return undefined;
  if (isDocCommentStart(first)) {
    for (const line of lines) {
      const cleaned = cleanDocLine(line);
      if (cleaned && cleaned !== '/' && !/^[*\/]+$/.test(cleaned)) return cleaned;
    }
  }
  const signature = lines.find(line => line.trim() && !isCommentLine(line))?.trim();
  return signature || first.trim() || undefined;
}

export function formatCodeLineRange(start?: number, end?: number): string | undefined {
  if (!Number.isSafeInteger(start) || (start ?? 0) < 1) return undefined;
  if (!Number.isSafeInteger(end) || (end ?? 0) < start!) return String(start);
  return end === start ? String(start) : `${start}–${end}`;
}

export function codeCardLineRange(source: CodeCardCopySource): string | undefined {
  const ref = firstRef(source);
  const excerpt = firstExcerpt(source);
  return formatCodeLineRange(ref?.startLine ?? excerpt?.startLine, ref?.endLine ?? excerpt?.endLine);
}

const KIND_PATTERNS: readonly [kind: string, pattern: RegExp][] = [
  ['INTERFACE', /\binterface\b/],
  ['CLASS', /\bclass\b/],
  ['TRAIT', /\btrait\b/],
  ['STRUCT', /\bstruct\b/],
  ['ENUM', /\benum\b/],
  ['IMPL', /\bimpl\b/],
  ['MOD', /\bmod\b/],
  ['TYPE', /\btype\s+[A-Za-z_]/],
  ['FN', /\b(?:async\s+)?function\b|\b(?:async\s+)?fn\b/],
  ['CONST', /\b(?:const|static|let)\b/],
  ['MACRO', /\bmacro_rules!\b|\bmacro\b/],
];

export function codeKindBadge(source: CodeCardCopySource): string {
  const haystack = [...excerptLines(source), source.name ?? ''].join('\n');
  for (const [kind, pattern] of KIND_PATTERNS) {
    if (pattern.test(haystack)) return kind;
  }
  const name = source.name?.trim() ?? '';
  if (name.endsWith('()') || name.includes('::')) return 'FN';
  return FALLBACK_KIND;
}

export function codeCardKicker(source: CodeCardCopySource): string {
  const badge = codeKindBadge(source);
  const range = codeCardLineRange(source);
  return range ? `${badge} · ${range}` : badge;
}

/**
 * L4 kicker + support copy. Never repeats the parent filepath — that lives on
 * the L3 file shell and in the inspector / hover HUD.
 */
export function codeCardCopy(source: CodeCardCopySource): CodeCardCopy {
  const signature = codeCardSignature(source);
  return {
    kicker: codeCardKicker(source),
    ...(signature ? { description: signature } : {}),
    descriptionMode: 'word',
  };
}
