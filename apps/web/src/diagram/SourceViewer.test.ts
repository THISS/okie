import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { absoluteSourcePath, editorSourceUri, SourceViewer, tokenizeSourceLine, tokenizeSourceLines, validRelativeSourcePath } from './SourceViewer';

describe('source viewer helpers', () => {
  it('degrades gracefully when a scanned entity has source refs but no frozen excerpt', () => {
    // Scanned code entities (R1) carry sourceRefs but no portable frozen excerpt,
    // so selectedExcerpt is undefined — the viewer must present a clean state, not error.
    const markup = renderToStaticMarkup(createElement(SourceViewer, { excerpt: undefined, onFeedback: () => undefined }));
    expect(markup).toContain('Source excerpt unavailable');
    expect(markup).toContain('no portable frozen source excerpt');
    expect(markup).toContain('role="status"');
  });

  it('tokenizes source deterministically without changing its text', () => {
    const line = 'export const answer: number = 42; // frozen';
    const tokens = tokenizeSourceLine(line, 'typescript');
    expect(tokens.map(token => token.text).join('')).toBe(line);
    expect(tokens).toEqual(expect.arrayContaining([
      { kind: 'keyword', text: 'export' },
      { kind: 'number', text: '42' },
      { kind: 'comment', text: '// frozen' },
    ]));
    expect(tokenizeSourceLine('pub fn main() { println!("ok"); }', 'rust').map(token => token.text).join(''))
      .toBe('pub fn main() { println!("ok"); }');
    expect(tokenizeSourceLine('{"enabled": true}', 'json').map(token => token.text).join(''))
      .toBe('{"enabled": true}');
    expect(tokenizeSourceLine('', 'typescript').map(token => token.text).join('')).toBe('');
    expect(tokenizeSourceLines(['const a = 1; /* open', 'still comment', 'done */ const b = 2;'], 'typescript'))
      .toEqual(expect.arrayContaining([
        expect.arrayContaining([{ kind: 'comment', text: 'still comment' }]),
      ]));
  });

  it('joins only validated relative paths to an explicitly configured root', () => {
    expect(validRelativeSourcePath('apps/web/src/App.tsx')).toBe(true);
    expect(validRelativeSourcePath('../secret')).toBe(false);
    expect(validRelativeSourcePath('/etc/passwd')).toBe(false);
    expect(validRelativeSourcePath('apps\\web\\App.tsx')).toBe(false);
    expect(validRelativeSourcePath('apps//App.tsx')).toBe(false);
    expect(validRelativeSourcePath('https://example.test/App.tsx')).toBe(false);
    expect(validRelativeSourcePath('apps/%2e%2e/secret.ts')).toBe(false);
    expect(validRelativeSourcePath('apps/%2Fsecret.ts')).toBe(false);
    expect(validRelativeSourcePath('apps/App.tsx?raw')).toBe(false);
    expect(validRelativeSourcePath('apps/App.tsx#L1')).toBe(false);
    expect(validRelativeSourcePath('apps/\u0000bad.ts')).toBe(false);
    expect(absoluteSourcePath('/work/okie/', 'apps/web/src/App.tsx')).toBe('/work/okie/apps/web/src/App.tsx');
    expect(absoluteSourcePath(undefined, 'apps/web/src/App.tsx')).toBeUndefined();
    expect(absoluteSourcePath('/work/okie', '../secret')).toBeUndefined();
  });

  it('builds editor URIs only from an already-derived absolute path', () => {
    expect(editorSourceUri('vscode', '/work/okie/apps/web/src/App.tsx', 42))
      .toBe('vscode://file//work/okie/apps/web/src/App.tsx:42:1');
    expect(editorSourceUri('cursor', '/work/okie/apps/web/src/App.tsx', 42))
      .toBe('cursor://file//work/okie/apps/web/src/App.tsx:42:1');
    expect(editorSourceUri('zed', '/work/okie/apps/web/src/App.tsx', 42))
      .toBe('zed://file//work/okie/apps/web/src/App.tsx:42:1');
    expect(editorSourceUri('vscode', '/work/okie/a#b?.ts', -4))
      .toBe('vscode://file//work/okie/a%23b%3F.ts:1:1');
    expect(() => editorSourceUri('javascript' as never, '/work/okie/App.tsx', 1)).toThrow('Unsupported editor');
  });
});
