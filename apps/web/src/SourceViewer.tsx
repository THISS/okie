import { useEffect, useMemo, useRef, useState } from 'react';
import type { SceneSourceExcerpt } from './renderer/types';

export type SourceLanguage = SceneSourceExcerpt['language'];
export type SourceToken = { kind: 'plain' | 'comment' | 'string' | 'number' | 'keyword' | 'punctuation'; text: string };
export type SourceEditor = 'vscode' | 'cursor' | 'zed';
export type LocalWorkspaceContext = {
  repositoryRoot: string;
  checkedRevision?: string;
  openEditor?: (editor: SourceEditor, target: { relativePath: string; line: number; column: 1 }) => void | Promise<void>;
};

const sourceTokenPattern = /(\/\/.*$|\/\*.*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b|\b(?:as|async|await|break|const|continue|crate|else|enum|export|false|fn|for|from|function|if|impl|import|in|interface|let|match|mod|move|mut|new|null|pub|return|self|static|struct|super|this|trait|true|type|undefined|use|where|while)\b|[{}()[\],.;:<>+=!&|?\-*/])/giu;

export function sourceLanguage(excerpt: SceneSourceExcerpt): SourceLanguage {
  return excerpt.path.toLowerCase().endsWith('.json') ? 'json' : excerpt.language;
}

export function tokenizeSourceLine(line: string, _language: SourceLanguage): SourceToken[] {
  const tokens: SourceToken[] = [];
  let cursor = 0;
  for (const match of line.matchAll(sourceTokenPattern)) {
    const index = match.index ?? cursor;
    if (index > cursor) tokens.push({ kind: 'plain', text: line.slice(cursor, index) });
    const text = match[0];
    const kind: SourceToken['kind'] = text.startsWith('//') || text.startsWith('/*')
      ? 'comment'
      : text.startsWith('"') || text.startsWith("'") || text.startsWith('`')
        ? 'string'
        : /^(?:0x[\da-f]+|\d)/iu.test(text)
          ? 'number'
          : /^\p{L}/u.test(text)
            ? 'keyword'
            : 'punctuation';
    tokens.push({ kind, text });
    cursor = index + text.length;
  }
  if (cursor < line.length) tokens.push({ kind: 'plain', text: line.slice(cursor) });
  return tokens.length ? tokens : [{ kind: 'plain', text: line }];
}

export function tokenizeSourceLines(lines: readonly string[], language: SourceLanguage): SourceToken[][] {
  let multilineComment = false;
  return lines.map(line => {
    if (multilineComment) {
      const end = line.indexOf('*/');
      if (end < 0) return [{ kind: 'comment', text: line }];
      multilineComment = false;
      return [
        { kind: 'comment', text: line.slice(0, end + 2) },
        ...tokenizeSourceLine(line.slice(end + 2), language),
      ];
    }
    const start = line.indexOf('/*');
    if (start < 0 || line.indexOf('*/', start + 2) >= 0) return tokenizeSourceLine(line, language);
    multilineComment = true;
    return [
      ...tokenizeSourceLine(line.slice(0, start), language),
      { kind: 'comment', text: line.slice(start) },
    ];
  });
}

export function validRelativeSourcePath(path: string): boolean {
  if (!path
    || path.startsWith('/')
    || path.startsWith('\\')
    || path.includes('\\')
    || /[:?#\u0000-\u001f\u007f]/u.test(path)) return false;
  return path.split('/').every(segment => {
    if (!segment || segment === '.' || segment === '..') return false;
    try {
      const decoded = decodeURIComponent(segment);
      return decoded !== '.' && decoded !== '..'
        && !decoded.includes('/') && !decoded.includes('\\')
        && !/[:?#\u0000-\u001f\u007f]/u.test(decoded);
    } catch {
      return false;
    }
  });
}

export function absoluteSourcePath(repositoryRoot: string | undefined, path: string): string | undefined {
  const root = repositoryRoot?.trim().replace(/[\\/]+$/u, '');
  if (!root || !validRelativeSourcePath(path)) return undefined;
  return `${root}/${path.replaceAll('\\', '/')}`;
}

export function editorSourceUri(editor: SourceEditor, absolutePath: string, line = 1): string {
  const path = absolutePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
  const safeLine = Number.isFinite(line) ? Math.max(1, Math.trunc(line)) : 1;
  if (editor === 'vscode') return `vscode://file/${path}:${safeLine}:1`;
  if (editor === 'cursor') return `cursor://file/${path}:${safeLine}:1`;
  if (editor === 'zed') return `zed://file/${path}:${safeLine}:1`;
  throw new Error('Unsupported editor.');
}

async function writeClipboard(value: string) {
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable in this browser.');
  await navigator.clipboard.writeText(value);
}

export function SourceViewer({
  excerpt,
  localWorkspace,
  onFeedback,
}: {
  excerpt?: SceneSourceExcerpt;
  localWorkspace?: LocalWorkspaceContext;
  onFeedback: (message: string) => void;
}) {
  const highlightedLineRef = useRef<HTMLDivElement | null>(null);
  const [feedback, setFeedback] = useState<string>();
  const absolutePath = excerpt ? absoluteSourcePath(localWorkspace?.repositoryRoot, excerpt.path) : undefined;
  const language = excerpt ? sourceLanguage(excerpt) : 'typescript';
  const lineTokens = useMemo(() => tokenizeSourceLines(excerpt?.lines ?? [], language), [excerpt, language]);

  useEffect(() => {
    highlightedLineRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [excerpt?.path, excerpt?.highlightLine]);

  const notify = (message: string) => {
    setFeedback(message);
    onFeedback(message);
  };
  const copy = async (label: string, value: string | undefined) => {
    if (!value) {
      notify(`${label} is unavailable.`);
      return;
    }
    try {
      await writeClipboard(value);
      notify(`${label} copied.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : `${label} could not be copied.`);
    }
  };
  const openEditor = async (editor: SourceEditor) => {
    if (!excerpt || !absolutePath) {
      notify('Configure VITE_OKIE_REPOSITORY_ROOT to enable local editor actions.');
      return;
    }
    try {
      if (localWorkspace?.openEditor) {
        await localWorkspace.openEditor(editor, { relativePath: excerpt.path, line: excerpt.highlightLine || excerpt.startLine || 1, column: 1 });
      } else {
        window.open(editorSourceUri(editor, absolutePath, excerpt.highlightLine || excerpt.startLine || 1), '_blank', 'noopener,noreferrer');
      }
      notify(`Opening ${editor === 'vscode' ? 'VS Code' : editor === 'cursor' ? 'Cursor' : 'Zed'} at line ${excerpt.highlightLine}.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The local editor is unavailable.');
    }
  };

  if (!excerpt) {
    return <div className="source-unavailable" role="status"><strong>Source excerpt unavailable</strong><p>This entity has no portable frozen source excerpt. Details and relative evidence remain available.</p></div>;
  }

  return <section aria-label={`Read-only source for ${excerpt.symbol ?? excerpt.path}`} className="source-viewer">
    <header className="source-meta">
      <div><strong>{excerpt.path}</strong><span>{excerpt.symbol ?? 'File excerpt'} · lines {excerpt.startLine}–{excerpt.endLine}</span></div>
      <span className="source-language">{language}</span>
    </header>
    <div aria-label={`${excerpt.path}, read only`} className="source-code" role="region" tabIndex={0}>
      <div className="source-lines">
        {lineTokens.map((tokens, index) => {
          const line = excerpt.startLine + index;
          const highlighted = line === excerpt.highlightLine;
          return <div {...(highlighted ? { 'aria-current': 'line' as never } : {})} className={`source-line ${highlighted ? 'highlighted' : ''}`} key={line} ref={highlighted ? highlightedLineRef : undefined}>
            <span aria-hidden="true" className="source-line-number">{line}</span>
            <code>{tokens.map((token, tokenIndex) => <span className={`token-${token.kind}`} key={`${tokenIndex}:${token.text}`}>{token.text}</span>)}</code>
          </div>;
        })}
      </div>
    </div>
    <div aria-label="Source actions" className="source-actions">
      <button disabled={!excerpt.symbol} onClick={() => { void copy('Symbol', excerpt.symbol); }} type="button">Copy symbol</button>
      <button onClick={() => { void copy('Relative path', excerpt.path); }} type="button">Copy relative</button>
      {absolutePath && <button onClick={() => { void copy('Absolute path', absolutePath); }} type="button">Copy absolute</button>}
      {absolutePath && <details className="editor-menu">
        <summary aria-label="Open source in editor">Open in…</summary>
        <div role="menu">
          {(['vscode', 'cursor', 'zed'] as const).map(editor => <button key={editor} onClick={() => { void openEditor(editor); }} role="menuitem" type="button">{editor === 'vscode' ? 'VS Code' : editor === 'cursor' ? 'Cursor' : 'Zed'}</button>)}
        </div>
      </details>}
    </div>
    <footer className="source-revision"><span>Frozen @ {excerpt.frozenRevision.slice(0, 12)}</span>{localWorkspace?.checkedRevision && localWorkspace.checkedRevision !== excerpt.frozenRevision && <span className="source-revision-warning">Working tree revision differs</span>}{feedback && <span aria-live="polite">{feedback}</span>}</footer>
  </section>;
}
