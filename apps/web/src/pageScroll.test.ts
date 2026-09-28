import { describe, expect, it } from 'vitest';
import { documentPageFor, DOCUMENT_PAGE_CLASS, setDocumentPage } from './pageScroll';

function fakeBody() { const classes = new Set<string>(); return { classes, body: { classList: { toggle: (name: string, force?: boolean) => { const on = force ?? !classes.has(name); if (on) classes.add(name); else classes.delete(name); return on; } } as unknown as DOMTokenList } }; }

describe('document page scroll marker', () => {
  it('marks document pages and clears the marker when the atlas (e.g. an operator draft preview) mounts', () => {
    const { classes, body } = fakeBody();
    setDocumentPage(true, body);
    expect(classes.has(DOCUMENT_PAGE_CLASS)).toBe(true);
    setDocumentPage(true, body);
    expect(classes.has(DOCUMENT_PAGE_CLASS)).toBe(true);
    setDocumentPage(false, body);
    expect(classes.has(DOCUMENT_PAGE_CLASS)).toBe(false);
  });
  it('scrolls document pages and keeps every atlas mount fixed', () => {
    for (const kind of ['operator', 'landing', 'picker', 'error'] as const) expect(documentPageFor(kind)).toBe(true);
    for (const kind of ['atlas', 'portable', 'preview'] as const) expect(documentPageFor(kind)).toBe(false);
  });
});
