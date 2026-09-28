import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BlockMarkdown, InlineMarkdown, MARKDOWN_LITE_MAX_LENGTH, parseBlocks, parseInline } from './markdownLite';

const inline = (text: string) => renderToStaticMarkup(<InlineMarkdown text={text}/>);
const blocks = (text: string) => renderToStaticMarkup(<BlockMarkdown text={text}/>);

describe('markdown-lite inline', () => {
  it('renders bold, italics and code as elements', () => {
    expect(inline('Start in **`scan.ts`**, then *read* _slowly_.')).toBe('Start in <strong><code>scan.ts</code></strong>, then <em>read</em> <em>slowly</em>.');
    expect(inline('*a **b** c*')).toBe('<em>a <strong>b</strong> c</em>');
  });
  it('keeps HTML, scripts, links and images as literal (escaped) text', () => {
    const markup = inline('<script>alert(1)</script> <img src=x onerror=alert(1)> [docs](javascript:alert(1)) ![x](data:text/html,hi) <b>bold</b>');
    expect(markup).not.toMatch(/<script|<img|<a |<b>|href=/u);
    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(markup).toContain('[docs](javascript:alert(1))');
    expect(markup).toContain('![x](data:text/html,hi)');
    expect(markup).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });
  it('leaves unclosed, empty and spaced markers literal', () => {
    expect(inline('**never closed')).toBe('**never closed');
    expect(inline('a * b * c')).toBe('a * b * c');
    expect(inline('`open code')).toBe('`open code');
    expect(inline('`` and **')).toBe('`` and **');
    expect(inline('snake_case_name and __init__')).toBe('snake_case_name and __init__');
    expect(parseInline('** spaced **')).toEqual([{ type: 'text', text: '** spaced **' }]);
  });
  it('does not interpret markers inside code spans', () => {
    expect(inline('`**not bold**`')).toBe('<code>**not bold**</code>');
  });
  it('bounds nesting depth and very long input', () => {
    expect(() => inline('*'.repeat(5000))).not.toThrow();
    expect(() => inline('**_*`'.repeat(2000))).not.toThrow();
    const long = inline('x'.repeat(MARKDOWN_LITE_MAX_LENGTH * 3));
    expect(long.length).toBe(MARKDOWN_LITE_MAX_LENGTH);
    expect(long.endsWith('…')).toBe(true);
    expect(inline('**a *b _c `d` c_ b* a**')).toContain('<code>d</code>');
  });
});

describe('markdown-lite blocks', () => {
  it('splits paragraphs on blank lines and renders bullet lists', () => {
    expect(parseBlocks('First line\ncontinues.\n\n- one\n* two\n\nLast.').map(block => block.type)).toEqual(['paragraph', 'list', 'paragraph']);
    expect(blocks('Intro:\n- **one**\n- two')).toBe('<div><p>Intro:</p><ul><li><strong>one</strong></li><li>two</li></ul></div>');
  });
  it('shows headings, quotes and HTML blocks as literal paragraphs', () => {
    const markup = blocks('# Heading\n\n> quote\n\n<div onclick="x">hi</div>');
    expect(markup).toContain('<p># Heading</p>');
    expect(markup).toContain('<p>&gt; quote</p>');
    expect(markup).toContain('&lt;div onclick=&quot;x&quot;&gt;hi&lt;/div&gt;');
    expect(markup).not.toMatch(/<h1|<blockquote|<div onclick/u);
  });
});
