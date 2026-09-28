import { Fragment, type ReactNode } from 'react';

/**
 * CLA-260 markdown-lite: the only formatting explanation text may use.
 * Inline: **bold**, *italic* / _italic_, `code`. Blocks (summary only): paragraphs split
 * by blank lines and `- ` / `* ` bullet lists. Everything else — HTML, links, images,
 * headings, unclosed markers — stays literal text. Output is React elements only, so
 * text is always escaped by React; nothing is ever injected as HTML.
 */
export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong' | 'em'; children: InlineNode[] };
export type BlockNode =
  | { type: 'paragraph'; children: InlineNode[] }
  | { type: 'list'; items: InlineNode[][] };

/** Rendering bound: long provider text is cut (with an ellipsis) rather than parsed unbounded. */
export const MARKDOWN_LITE_MAX_LENGTH = 4000;
const MAX_DEPTH = 3;

function bounded(text: string): string {
  return text.length > MARKDOWN_LITE_MAX_LENGTH ? `${text.slice(0, MARKDOWN_LITE_MAX_LENGTH - 1)}…` : text;
}
const isSpace = (value: string | undefined) => value === undefined || /\s/u.test(value);
const isWord = (value: string | undefined) => value !== undefined && /[\p{L}\p{N}]/u.test(value);

/** Closing index for an emphasis marker opened at `open`, or -1. */
function closingMarker(text: string, open: number, marker: string): number {
  const inner = open + marker.length;
  if (isSpace(text[inner])) return -1; // "* not emphasis"
  if (marker === '_' && isWord(text[open - 1])) return -1; // snake_case stays literal
  let from = inner;
  while (from < text.length) {
    const close = text.indexOf(marker, from);
    if (close < 0) return -1;
    // Skip a single marker that is really half of a double (`**`, `__`): italic never closes on those.
    const doubled = marker.length === 1 && (text[close + 1] === marker || text[close - 1] === marker);
    const valid = close > inner && !isSpace(text[close - 1]) && !doubled && !(marker === '_' && isWord(text[close + marker.length]));
    if (valid) return close;
    from = close + marker.length;
  }
  return -1;
}

export function parseInline(input: string, depth = 0): InlineNode[] {
  const text = depth === 0 ? bounded(input) : input;
  const nodes: InlineNode[] = [];
  let buffer = '';
  const flush = () => { if (buffer) { nodes.push({ type: 'text', text: buffer }); buffer = ''; } };
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '`') {
      const close = text.indexOf('`', index + 1);
      if (close > index + 1) { flush(); nodes.push({ type: 'code', text: text.slice(index + 1, close) }); index = close + 1; continue; }
    } else if (depth < MAX_DEPTH && (char === '*' || char === '_')) {
      if (char === '_' && text[index + 1] === '_') { buffer += '__'; index += 2; continue; } // `__dunder__` stays literal
      const marker = char === '*' && text[index + 1] === '*' ? '**' : char;
      const close = closingMarker(text, index, marker);
      if (close > 0) {
        flush();
        nodes.push({ type: marker === '**' ? 'strong' : 'em', children: parseInline(text.slice(index + marker.length, close), depth + 1) });
        index = close + marker.length;
        continue;
      }
      if (marker === '**') { buffer += '**'; index += 2; continue; }
    }
    buffer += char;
    index += 1;
  }
  flush();
  return nodes;
}

const BULLET = /^\s*[-*]\s+(.*)$/u;

export function parseBlocks(input: string): BlockNode[] {
  const blocks: BlockNode[] = [];
  for (const chunk of bounded(input).replace(/\r\n?/gu, '\n').split(/\n[ \t]*\n/u)) {
    let paragraph: string[] = [];
    let items: string[] = [];
    const flushParagraph = () => { if (paragraph.length) { blocks.push({ type: 'paragraph', children: parseInline(paragraph.join(' ')) }); paragraph = []; } };
    const flushList = () => { if (items.length) { blocks.push({ type: 'list', items: items.map(item => parseInline(item)) }); items = []; } };
    for (const raw of chunk.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const bullet = BULLET.exec(line);
      if (bullet?.[1]) { flushParagraph(); items.push(bullet[1]); }
      else { flushList(); paragraph.push(line); }
    }
    flushParagraph();
    flushList();
  }
  return blocks;
}

export function renderInlineNodes(nodes: readonly InlineNode[]): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.type === 'text') return <Fragment key={index}>{node.text}</Fragment>;
    if (node.type === 'code') return <code key={index}>{node.text}</code>;
    return node.type === 'strong'
      ? <strong key={index}>{renderInlineNodes(node.children)}</strong>
      : <em key={index}>{renderInlineNodes(node.children)}</em>;
  });
}

/** Inline-only text (key points, table cells, captions). */
export function InlineMarkdown({ text }: { text: string }) {
  return <>{renderInlineNodes(parseInline(text))}</>;
}

/** Block text (the summary): paragraphs and short bullet lists. */
export function BlockMarkdown({ text, className }: { text: string; className?: string }) {
  return <div className={className}>{parseBlocks(text).map((block, index) => block.type === 'paragraph'
    ? <p key={index}>{renderInlineNodes(block.children)}</p>
    : <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineNodes(item)}</li>)}</ul>)}</div>;
}
