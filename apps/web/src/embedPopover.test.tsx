import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { copyEmbedSnippet, EMBED_COPY_FAILED_MESSAGE, EMBED_UNAVAILABLE_MESSAGE, EmbedAtlasControl, EmbedDialogBody, focusTrapTarget, type EmbedDialogProps } from './embedPopover';
import { EMBED_OEMBED_NOTE } from './embedSnippet';

/**
 * CLA-329 embed dialog. The web test env has no DOM, so the behaviour lives in pure helpers (tested here) and the
 * component is checked as static markup; focus/Escape/outside-click are exercised in browser QA.
 */

const noop = () => undefined;
const body = (patch: Partial<EmbedDialogProps> = {}) => renderToStaticMarkup(
  <EmbedDialogBody copyState="idle" link="https://sourcefor.dev/r/pmndrs/zustand" onCopy={noop} onCopyLink={noop} onPreset={noop} onStartAtView={noop} preset="medium" snippet="<iframe></iframe>" startAtView titleId="t" {...patch}/>,
);

describe('CLA-329 embed dialog: focus trap', () => {
  it('wraps Tab at the last stop and Shift+Tab at the first; otherwise lets the browser move', () => {
    expect(focusTrapTarget({ index: 4, count: 5, shift: false })).toBe(0);
    expect(focusTrapTarget({ index: 0, count: 5, shift: true })).toBe(4);
    expect(focusTrapTarget({ index: 2, count: 5, shift: false })).toBeUndefined();
    expect(focusTrapTarget({ index: 2, count: 5, shift: true })).toBeUndefined();
    // Focus outside the dialog (e.g. body after a click) comes back in at the matching end.
    expect(focusTrapTarget({ index: -1, count: 5, shift: false })).toBe(0);
    expect(focusTrapTarget({ index: -1, count: 5, shift: true })).toBe(4);
    expect(focusTrapTarget({ index: 0, count: 1, shift: false })).toBe(0);
    expect(focusTrapTarget({ index: -1, count: 0, shift: false })).toBeUndefined();
  });
});

describe('CLA-329 embed dialog: copy', () => {
  it('writes the snippet to the clipboard', async () => {
    const writeText = vi.fn(async () => undefined);
    expect(await copyEmbedSnippet('<iframe>', { writeText })).toBe(true);
    expect(writeText).toHaveBeenCalledWith('<iframe>');
  });

  it('refuses an empty snippet (never a false "copied")', async () => {
    const writeText = vi.fn(async () => undefined);
    expect(await copyEmbedSnippet('', { writeText })).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('reports failure when the clipboard is missing or refuses', async () => {
    expect(await copyEmbedSnippet('<iframe>', undefined)).toBe(false);
    expect(await copyEmbedSnippet('<iframe>', { writeText: async () => { throw new Error('NotAllowedError'); } })).toBe(false);
  });
});

describe('CLA-329 embed dialog: markup', () => {
  it('the header button is a labelled, collapsed dialog trigger with the code icon', () => {
    const html = renderToStaticMarkup(<EmbedAtlasControl readPageHref={() => 'https://sourcefor.dev/r/pmndrs/zustand'}/>);
    expect(html).toContain('aria-label="Embed this atlas"');
    expect(html).toContain('title="Embed"');
    expect(html).toContain('data-testid="embed-atlas"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('m8.5 7-5 5 5 5');
    expect(html).not.toContain('role="dialog"');
  });

  it('dialog body: heading, size radios, start-at-view checked by default, readonly snippet, copy, oEmbed note', () => {
    const html = body();
    expect(html).toContain('<h2 id="t">Embed this atlas</h2>');
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).toContain('<input type="radio" name="t-size" checked="" value="medium"/><span>800 × 500</span>');
    expect(html).toContain('1200 × 675');
    expect(html).toContain('Responsive');
    expect(html).toContain('<input type="checkbox" checked=""/><span>Start at this view</span>');
    expect(html).toMatch(/<textarea data-testid="embed-snippet" readOnly="" rows="5" spellCheck="false">&lt;iframe&gt;&lt;\/iframe&gt;<\/textarea>/);
    expect(html).toContain('data-testid="embed-copy"');
    expect(html).toContain(EMBED_OEMBED_NOTE);
    expect(EMBED_OEMBED_NOTE).toBe('Or paste the link: tools that read oEmbed (like Ghost) embed the live atlas; others may show a preview card.');
  });

  it('offers the plain atlas link with its own Copy link (what link-embedding tools need, not the iframe src)', () => {
    const html = body();
    expect(html).toContain('<input data-testid="embed-link" readOnly="" spellCheck="false" type="text" value="https://sourcefor.dev/r/pmndrs/zustand"/>');
    expect(html).toMatch(/<button data-testid="embed-copy-link" type="button">Copy link<\/button>/);
    expect(body({ copyState: 'link-copied' })).toContain('Atlas link copied.');
    expect(body({ copyState: 'link-failed' })).toContain(EMBED_COPY_FAILED_MESSAGE);
    expect(body({ link: '' })).toMatch(/<button data-testid="embed-copy-link" disabled="" type="button">/);
  });

  it('copy feedback: "Copied" on success, a select-manually message on failure', () => {
    expect(body({ copyState: 'copied' })).toMatch(/<button class="copied" data-testid="embed-copy" type="button"><svg[^]*<\/svg> Copied<\/button>/);
    expect(body({ copyState: 'failed' })).toContain(EMBED_COPY_FAILED_MESSAGE);
    expect(body({ startAtView: false, preset: 'responsive' })).toContain('<input type="radio" name="t-size" checked="" value="responsive"/>');
    expect(body({ startAtView: false })).toContain('<input type="checkbox"/><span>Start at this view</span>');
  });

  it('no snippet: an inline message, an empty textarea and a disabled Copy', () => {
    const html = body({ snippet: '' });
    expect(html).toContain(`data-testid="embed-unavailable" role="alert">${EMBED_UNAVAILABLE_MESSAGE.replace("'", '&#x27;')}</p>`);
    expect(EMBED_UNAVAILABLE_MESSAGE).toBe("This atlas URL can't be embedded.");
    expect(html).toContain('spellCheck="false"></textarea>');
    expect(html).toMatch(/<button data-testid="embed-copy" disabled="" type="button">Copy<\/button>/);
    expect(body()).not.toContain('embed-unavailable');
    expect(body()).not.toMatch(/data-testid="embed-copy" disabled/);
  });

  it('the component wires Escape, Tab trap, outside press and focus restore', () => {
    const source = readFileSync(new URL('./embedPopover.tsx', import.meta.url), 'utf8');
    expect(source).toContain("event.key === 'Escape'");
    expect(source).toContain('close(true)');
    expect(source).toContain("document.addEventListener('pointerdown'");
    expect(source).toContain('buttonRef.current?.focus()');
    expect(source).toMatch(/role="dialog"/);
    expect(source).toMatch(/aria-labelledby=\{titleId\}/);
    // A click on non-focusable dialog content keeps focus in the dialog, so Esc/Tab still work.
    expect(source).toMatch(/aria-modal="true"[^>]*role="dialog" tabIndex=\{-1\}/);
    // Copy re-reads the live view when starting at this view, and shows exactly what it copied.
    expect(source).toMatch(/if \(startAtView\) \{\s+const href = readPageHref\(\);\s+setPageHref\(href\);\s+text = snippetFor\(href\);/);
  });

  it('phones get a fixed full-width bottom sheet that scrolls', () => {
    const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');
    const phone = css.slice(css.indexOf('@media (max-width: 640px) {\n  /* backdrop-filter'));
    expect(phone).toMatch(/\.embed-popover \{ position: fixed;[^}]*right: 0; bottom: 0; left: 0; width: auto; max-height: [^;]+; overflow-y: auto;/);
  });
});
