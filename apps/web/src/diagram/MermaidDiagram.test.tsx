import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  assertSafeCssText,
  assertSafeMermaidSource,
  assertSafeMermaidSvgText,
  ATLAS_MERMAID_CONFIG,
  loadMermaid,
  MermaidDiagram,
  MermaidSourceDisclosure,
  setMermaidModuleLoaderForTests,
  stableMermaidRenderId,
} from './MermaidDiagram';

const componentSource = readFileSync(new URL('./MermaidDiagram.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../app.css', import.meta.url), 'utf8');

function declarations(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...source.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
  const match = matches.at(-1);
  if (!match) throw new Error(`Missing CSS rule for ${selector}`);
  return match[1]!;
}

describe('Mermaid diagram renderer boundary', () => {
  it('uses a strict deterministic application-owned configuration', () => {
    expect(ATLAS_MERMAID_CONFIG).toMatchObject({
      deterministicIds: true,
      deterministicIDSeed: 'okie-atlas-mermaid-v1',
      htmlLabels: false,
      maxEdges: 250,
      securityLevel: 'strict',
      startOnLoad: false,
      suppressErrorRendering: true,
      theme: 'base',
      flowchart: { htmlLabels: false, useMaxWidth: true },
    });
    expect(ATLAS_MERMAID_CONFIG.secure).toEqual(expect.arrayContaining([
      'securityLevel',
      'htmlLabels',
      'themeCSS',
      'flowchart',
    ]));
  });

  it('keeps Mermaid behind a dynamic import instead of the initial web bundle', () => {
    expect(componentSource).toContain("import('mermaid')");
    expect(componentSource).not.toMatch(/^import mermaid from 'mermaid'/mu);
  });

  it('recovers on retry after a failed Mermaid import instead of caching the rejection', async () => {
    let attempts = 0;
    const initialize = vi.fn();
    setMermaidModuleLoaderForTests(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('network down'))
        : Promise.resolve({
            default: { initialize, render: async () => ({ svg: '<svg/>', diagramType: 'flowchart' }) },
          });
    });
    try {
      // First attempt fails; the module-level cache must not retain the rejection.
      await expect(loadMermaid()).rejects.toThrow('network down');
      // Retry re-imports (attempt 2), initializes with the app config, and resolves.
      const api = await loadMermaid();
      expect(attempts).toBe(2);
      expect(initialize).toHaveBeenCalledWith(ATLAS_MERMAID_CONFIG);
      expect(api).toHaveProperty('render');
    } finally {
      setMermaidModuleLoaderForTests();
    }
  });

  it('derives stable source-specific render IDs', () => {
    const source = 'flowchart LR\n  a["A"] --> b["B"]\n';
    expect(stableMermaidRenderId(source)).toBe(stableMermaidRenderId(source));
    expect(stableMermaidRenderId(source)).toMatch(/^okie-mermaid-[a-f0-9]{8}$/u);
    expect(stableMermaidRenderId(source)).not.toBe(stableMermaidRenderId(`${source}  b --> c\n`));
  });

  it('accepts only bounded LR/TB flowcharts while allowing inert metadata comments', () => {
    const source = [
      '%% okie-entity {"semanticEntityId":"click bad style something"}',
      'flowchart TB',
      '  a["click bad style something"] --> b["B"]',
      '',
    ].join('\n');
    expect(() => assertSafeMermaidSource(source)).not.toThrow();
    expect(() => assertSafeMermaidSource('sequenceDiagram\n  A->>B: hello\n')).toThrow(/Only deterministic/u);
    expect(() => assertSafeMermaidSource(`flowchart LR\n${'a'.repeat(40_001)}`)).toThrow(/render limit/u);
  });

  it.each([
    'flowchart LR\n  click a "https://example.com"\n',
    'flowchart LR\n  classDef bad fill:url(https://example.com/x)\n',
    'flowchart LR\n  linkStyle 0 stroke:red\n',
    '%%{init: {"securityLevel": "loose"}}%%\nflowchart LR\n  a --> b\n',
    'flowchart LR\n  a["javascript:alert(1)"]\n',
  ])('rejects unsupported active Mermaid source: %s', source => {
    expect(() => assertSafeMermaidSource(source)).toThrow(/unsupported active directive/u);
  });

  it('accepts inert SVG with local marker references', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><style>.edge{marker-end:url(#arrow)}</style><defs><marker id="arrow"><path d="M0 0L4 2"/></marker></defs><g><rect width="10" height="10"/><text>A</text></g></svg>';
    expect(() => assertSafeMermaidSvgText(svg)).not.toThrow();
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>bad</div></foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="https://example.com"><text>bad</text></a></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><path marker-end="url(https://example.com/marker)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://example.com/x.css";</style></svg>',
  ])('rejects active or externally linked SVG output: %s', svg => {
    expect(() => assertSafeMermaidSvgText(svg)).toThrow();
  });

  it('neutralizes CSS-escaped external url() in a style attribute value', () => {
    // Escaped parens (url\28 …\29) evade a raw url() regex but decode to a real url.
    expect(() => assertSafeCssText('fill:url\\28 https://evil.example/x\\29')).toThrow(/external URL/u);
    // Hex-escaped scheme (\68 = 'h') hides the external target from a naive scan.
    expect(() => assertSafeCssText('background:url(\\68 ttps://evil.example/x)')).toThrow(/external URL/u);
  });

  it('neutralizes CSS-escaped external url() inside a <style> block body', () => {
    expect(() => assertSafeCssText('.node rect{fill:url(\\68 ttps://evil.example/x)}')).toThrow(/external URL/u);
    expect(() => assertSafeCssText('.edgePath{stroke:url\\28 https://evil.example\\29}')).toThrow(/external URL/u);
  });

  it('preserves legitimate internal marker references, including an escaped "#"', () => {
    expect(() => assertSafeCssText('marker-end:url(#arrow)')).not.toThrow();
    expect(() => assertSafeCssText('.edge{marker-end:url(#arrow)}')).not.toThrow();
    // \000023 decodes to '#', so this remains an internal fragment reference.
    expect(() => assertSafeCssText('marker-end:url(\\000023 arrow)')).not.toThrow();
    expect(() => assertSafeCssText('/* themed */ fill:#162022; stroke-width:1px')).not.toThrow();
  });

  it('rejects escaped @import and IE expression() payloads in CSS', () => {
    expect(() => assertSafeCssText('@import "https://evil.example/x.css"')).toThrow(/active styles/u);
    // \70 = 'p' — reconstructs @import after decoding.
    expect(() => assertSafeCssText('@im\\70 ort url(https://evil.example)')).toThrow();
    expect(() => assertSafeCssText('width:expression(alert(1))')).toThrow(/active styles/u);
  });

  it('normalizes comment-split, case-variant, and escaped-"url" obfuscation before allowlisting', () => {
    // comment-split: url(/**/http…) collapses to url(http…) after comment strip.
    expect(() => assertSafeCssText('background:url(/**/https://evil.example/x)')).toThrow(/external URL/u);
    // uppercase / mixed-case URL( still matched (case-insensitive).
    expect(() => assertSafeCssText('fill:URL(https://evil.example/x)')).toThrow(/external URL/u);
    // the "url" keyword itself hex-escaped: \75 = 'u' -> url(
    expect(() => assertSafeCssText('fill:\\75rl(https://evil.example/x)')).toThrow(/external URL/u);
    // hex escape with a whitespace terminator inside the scheme still fails closed.
    expect(() => assertSafeCssText('fill:url(\\68 ttp://evil.example)')).toThrow(/external URL/u);
    // comments + whitespace around a legit internal ref remain allowed (both forms).
    expect(() => assertSafeCssText('marker-end: url( /* ok */ #arrow )')).not.toThrow();
    expect(() => assertSafeCssText('.edge {\n  marker-end:\turl(#arrow) ;\n}')).not.toThrow();
  });

  it('server-renders an accessible loading fallback without executing the renderer', () => {
    const markup = renderToStaticMarkup(<MermaidDiagram
      source={'flowchart LR\n  a["A"] --> b["B"]\n'}
      title="Request flow diagram"
    />);
    expect(markup).toContain('Request flow diagram');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('Rendering diagram');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('data-render-state="loading"');
  });

  it('keeps deterministic source behind a disclosure with a copy action', () => {
    const markup = renderToStaticMarkup(<MermaidSourceDisclosure source={'flowchart LR\n  a --> b\n'}/>);
    expect(markup).toContain('<details class="semantic-mermaid-source">');
    expect(markup).toContain('Generated Mermaid source');
    expect(markup).toContain('Copy source');
    expect(markup).toContain('<pre><code>flowchart LR');
  });

  it('omits the derived-diagram outline note in compact inspector one-pager mode', () => {
    const markup = renderToStaticMarkup(<MermaidDiagram compact source={'flowchart TB\n  a["A"]\n'} title="L1 → L2"/>);
    expect(markup).toContain('data-mermaid-compact="true"');
    expect(markup).toContain('is-compact');
    expect(markup).not.toContain('structured outline below');
    expect(css).toContain('.semantic-mermaid-diagram.is-compact');
  });

  it('fits the complete SVG within the initial mobile canvas instead of forcing a wide discovery surface', () => {
    const mobile = css.slice(css.indexOf('@media (max-width: 470px)'));
    const host = declarations(mobile, '.semantic-mermaid-svg');
    const svg = declarations(mobile, '.semantic-mermaid-svg > svg');

    expect(host).toContain('min-width: 0');
    expect(host).not.toContain('520px');
    expect(svg).toContain('width: 100% !important');
    expect(svg).toContain('max-width: 100% !important');
    expect(svg).toContain('min-width: 0');
  });
});
