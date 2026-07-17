import { useEffect, useId, useRef, useState } from 'react';
import type { MermaidConfig } from 'mermaid';

const MAX_MERMAID_SOURCE_LENGTH = 40_000;
const MAX_MERMAID_SVG_LENGTH = 2_000_000;
const MERMAID_RENDER_SEED = 'okie-atlas-mermaid-v1';

/**
 * Elements/attributes forbidden in rendered SVG. Single source of truth applied
 * twice: inside mermaid's own DOMPurify pass (ATLAS_MERMAID_CONFIG.dompurifyConfig)
 * and again in an independent post-render DOMPurify pass (parseSafeMermaidSvg).
 */
const MERMAID_SVG_FORBID_TAGS = ['a', 'foreignObject', 'iframe', 'image', 'script', 'use'];
const MERMAID_SVG_FORBID_ATTR = ['href', 'xlink:href'];

export const ATLAS_MERMAID_CONFIG: Readonly<MermaidConfig> = {
  startOnLoad: false,
  securityLevel: 'strict',
  suppressErrorRendering: true,
  deterministicIds: true,
  deterministicIDSeed: MERMAID_RENDER_SEED,
  htmlLabels: false,
  maxTextSize: MAX_MERMAID_SOURCE_LENGTH,
  maxEdges: 250,
  logLevel: 'fatal',
  theme: 'base',
  look: 'classic',
  fontFamily: 'IBM Plex Sans, ui-sans-serif, system-ui, sans-serif',
  secure: [
    'deterministicIds',
    'deterministicIDSeed',
    'dompurifyConfig',
    'flowchart',
    'fontFamily',
    'htmlLabels',
    'maxEdges',
    'maxTextSize',
    'securityLevel',
    'startOnLoad',
    'suppressErrorRendering',
    'theme',
    'themeCSS',
    'themeVariables',
  ],
  themeVariables: {
    background: '#070a0b',
    primaryColor: '#162022',
    primaryTextColor: '#eef4f2',
    primaryBorderColor: '#52666a',
    secondaryColor: '#15201f',
    secondaryTextColor: '#d9ff70',
    secondaryBorderColor: '#506965',
    tertiaryColor: '#101617',
    tertiaryTextColor: '#b7c3c0',
    tertiaryBorderColor: '#3d4a4d',
    lineColor: '#79dfd4',
    textColor: '#eef4f2',
    mainBkg: '#162022',
    nodeBorder: '#52666a',
    clusterBkg: '#0d1314',
    clusterBorder: '#3d4a4d',
    edgeLabelBackground: '#0d1213',
    noteBkgColor: '#1a2118',
    noteBorderColor: '#73824d',
    noteTextColor: '#eef4f2',
    fontFamily: 'IBM Plex Sans, ui-sans-serif, system-ui, sans-serif',
  },
  flowchart: {
    htmlLabels: false,
    useMaxWidth: true,
    curve: 'basis',
    nodeSpacing: 44,
    rankSpacing: 64,
    diagramPadding: 16,
  },
  dompurifyConfig: {
    FORBID_TAGS: [...MERMAID_SVG_FORBID_TAGS],
    FORBID_ATTR: [...MERMAID_SVG_FORBID_ATTR],
  },
};

type MermaidApi = Pick<typeof import('mermaid')['default'], 'render'>;
type MermaidModule = { default: Pick<typeof import('mermaid')['default'], 'initialize' | 'render'> };

let importMermaidModule: () => Promise<MermaidModule> = () => import('mermaid');
let mermaidModulePromise: Promise<MermaidApi> | undefined;

/**
 * Test seam: swap the Mermaid loader and reset the cached module promise so the
 * fail-then-retry path can be exercised deterministically. Called with no
 * argument it restores the real dynamic import.
 */
export function setMermaidModuleLoaderForTests(loader?: () => Promise<MermaidModule>): void {
  importMermaidModule = loader ?? (() => import('mermaid'));
  mermaidModulePromise = undefined;
}

export function loadMermaid(): Promise<MermaidApi> {
  if (mermaidModulePromise) return mermaidModulePromise;
  const pending = importMermaidModule().then(({ default: mermaid }) => {
    mermaid.initialize(ATLAS_MERMAID_CONFIG);
    return mermaid;
  });
  // A rejected import must not poison the cache: otherwise the error UI's
  // "Retry render" would keep re-receiving the same cached failure forever.
  pending.catch(() => { if (mermaidModulePromise === pending) mermaidModulePromise = undefined; });
  mermaidModulePromise = pending;
  return pending;
}

type DompurifyApi = typeof import('dompurify')['default'];

let dompurifyPromise: Promise<DompurifyApi> | undefined;

/**
 * DOMPurify is loaded lazily — it ships inside mermaid's dynamic chunk, so this
 * adds ~0 to the initial bundle — and cached with the same reject-clears-cache
 * discipline as loadMermaid so a failed chunk load can recover on Retry.
 */
function loadDompurify(): Promise<DompurifyApi> {
  if (dompurifyPromise) return dompurifyPromise;
  const pending = import('dompurify').then(module => module.default);
  pending.catch(() => { if (dompurifyPromise === pending) dompurifyPromise = undefined; });
  dompurifyPromise = pending;
  return pending;
}

export function stableMermaidRenderId(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `okie-mermaid-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function assertSafeMermaidSource(source: string): void {
  if (!source.trim()) throw new Error('Mermaid source is empty');
  if (source.length > MAX_MERMAID_SOURCE_LENGTH) throw new Error('Mermaid source exceeds the render limit');
  const semanticLines = source.split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('%%'));
  if (!/^flowchart\s+(?:LR|TB)$/u.test(semanticLines[0] ?? '')) {
    throw new Error('Only deterministic LR or TB flowcharts can be rendered');
  }
  if (semanticLines.slice(1).some(line => /^flowchart\b/u.test(line))) {
    throw new Error('Mermaid source contains more than one diagram');
  }
  if (/^[ \t]*%%\s*\{/imu.test(source)
    || /^[ \t]*(?:click|classDef|linkStyle|style)\s+/imu.test(source)
    || /javascript\s*:|data\s*:\s*text\/html/iu.test(source)) {
    throw new Error('Mermaid source contains an unsupported active directive');
  }
}

function assertLocalUrlReferences(value: string): void {
  for (const match of value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/giu)) {
    if (!/^#[A-Za-z_][\w:.-]*$/u.test(match[2] ?? '')) {
      throw new Error('Rendered Mermaid SVG contains an external URL');
    }
  }
}

/**
 * Decodes CSS escape sequences (`\XX` hex + optional trailing space, or `\<char>`)
 * so escape-obfuscated payloads — `url\28 …\29`, `\68ttp:`, `@im\70 ort` — are
 * normalized before the substring checks. DOMPurify intentionally leaves CSS
 * untouched (`style` is URI-safe-listed), so this decode-then-check is the
 * authoritative defense for CSS, replacing the previous raw-regex inspection.
 */
function decodeCssEscapes(css: string): string {
  return css.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\r\n\f]?|([^\r\n\f0-9a-fA-F]))/gu, (_full, hex: string | undefined, literal: string | undefined) => {
    if (hex === undefined) return literal ?? '';
    const codePoint = Number.parseInt(hex, 16);
    if (codePoint === 0 || codePoint > 0x10_ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return '\uFFFD';
    return String.fromCodePoint(codePoint);
  });
}

export function assertSafeCssText(css: string): void {
  const normalized = decodeCssEscapes(css.replace(/\/\*[^]*?\*\//gu, ''));
  if (/javascript\s*:|data\s*:\s*text\/html|@import\b|expression\s*\(/iu.test(normalized)) {
    throw new Error('Rendered Mermaid SVG contains active styles');
  }
  assertLocalUrlReferences(normalized);
}

export function assertSafeMermaidSvgText(svg: string): void {
  if (!/^\s*<svg\b/iu.test(svg)) throw new Error('Mermaid did not return an SVG document');
  if (svg.length > MAX_MERMAID_SVG_LENGTH) throw new Error('Rendered Mermaid SVG exceeds the display limit');
  if (/<\s*(?:a|audio|embed|foreignObject|iframe|image|object|script|use|video)\b/iu.test(svg)) {
    throw new Error('Rendered Mermaid SVG contains an unsupported element');
  }
  if (/\s+on[a-z][\w:.-]*\s*=/iu.test(svg) || /\s+(?:href|xlink:href)\s*=/iu.test(svg)) {
    throw new Error('Rendered Mermaid SVG contains an active attribute');
  }
  if (/javascript\s*:|data\s*:\s*text\/html|@import\b/iu.test(svg)) {
    throw new Error('Rendered Mermaid SVG contains active content');
  }
  assertLocalUrlReferences(svg);
}

const allowedSvgElements = new Set([
  'circle',
  'clippath',
  'defs',
  'desc',
  'ellipse',
  'fedropshadow',
  'filter',
  'g',
  'line',
  'lineargradient',
  'marker',
  'mask',
  'path',
  'polygon',
  'polyline',
  'rect',
  'stop',
  'style',
  'svg',
  'text',
  'title',
  'tspan',
]);

function parseSafeMermaidSvg(svg: string, ownerDocument: Document, purify: DompurifyApi): SVGSVGElement {
  assertSafeMermaidSvgText(svg);

  // Independent hardened sanitizer over the rendered output: DOMPurify parses the
  // markup with a real HTML/SVG parser (defeating markup-level obfuscation the raw
  // text checks can miss) and drops the shared forbid list. DOMPurify deliberately
  // does NOT sanitize CSS (`style` is URI-safe-listed), so assertSafeCssText below
  // remains the authoritative defense for url()/@import in styles and <style>.
  const fragment = purify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: [...MERMAID_SVG_FORBID_TAGS],
    FORBID_ATTR: [...MERMAID_SVG_FORBID_ATTR],
    RETURN_DOM_FRAGMENT: true,
  });

  const root = fragment.querySelector('svg');
  if (!root || root.namespaceURI !== 'http://www.w3.org/2000/svg') {
    throw new Error('Mermaid did not return a standalone SVG');
  }

  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (element.namespaceURI !== 'http://www.w3.org/2000/svg' || !allowedSvgElements.has(element.localName.toLowerCase())) {
      throw new Error('Rendered Mermaid SVG contains an unsupported element');
    }
    for (const attribute of element.getAttributeNames()) {
      const normalized = attribute.toLowerCase();
      const value = element.getAttribute(attribute) ?? '';
      if (normalized.startsWith('on') || normalized === 'href' || normalized === 'xlink:href') {
        throw new Error('Rendered Mermaid SVG contains an active attribute');
      }
      if (normalized === 'style') {
        assertSafeCssText(value);
        continue;
      }
      if (/javascript\s*:|data\s*:\s*text\/html|@import\b/iu.test(value)) {
        throw new Error('Rendered Mermaid SVG contains active content');
      }
      assertLocalUrlReferences(value);
    }
    if (element.localName.toLowerCase() === 'style') {
      assertSafeCssText(element.textContent ?? '');
    }
  }

  const safeRoot = ownerDocument.importNode(root, true) as unknown as SVGSVGElement;
  safeRoot.setAttribute('aria-hidden', 'true');
  safeRoot.setAttribute('focusable', 'false');
  return safeRoot;
}

type RenderState = 'loading' | 'ready' | 'error';

type MermaidDiagramProps = {
  source: string;
  title: string;
};

export function MermaidDiagram({ source, title }: MermaidDiagramProps) {
  const headingId = useId();
  const hostRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<RenderState>('loading');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const request = ++requestRef.current;
    let cancelled = false;
    host.replaceChildren();
    setState('loading');

    void (async () => {
      try {
        assertSafeMermaidSource(source);
        const [mermaid, purify] = await Promise.all([loadMermaid(), loadDompurify()]);
        if (cancelled || request !== requestRef.current) return;
        const result = await mermaid.render(stableMermaidRenderId(source), source);
        if (cancelled || request !== requestRef.current) return;
        const safeSvg = parseSafeMermaidSvg(result.svg, host.ownerDocument, purify);
        if (cancelled || request !== requestRef.current) return;
        host.replaceChildren(safeSvg);
        setState('ready');
      } catch {
        if (cancelled || request !== requestRef.current) return;
        host.replaceChildren();
        setState('error');
      }
    })();

    return () => {
      cancelled = true;
      if (request === requestRef.current) {
        requestRef.current += 1;
        host.replaceChildren();
      }
    };
  }, [retry, source]);

  return <section aria-labelledby={headingId} className="semantic-mermaid-diagram">
    <header>
      <div><span>Rendered view</span><h2 id={headingId}>{title}</h2></div>
      <small>Strict · deterministic SVG</small>
    </header>
    <div className={`semantic-mermaid-canvas is-${state}`}>
      <div aria-hidden="true" className="semantic-mermaid-svg" data-render-state={state} ref={hostRef}/>
      {state === 'loading' && <div className="semantic-mermaid-status" role="status"><span/>Rendering diagram…</div>}
      {state === 'error' && <div className="semantic-mermaid-error" role="alert"><strong>Diagram preview unavailable</strong><span>The structured participants and interactions below are still available.</span><button onClick={() => setRetry(value => value + 1)} type="button">Retry render</button></div>}
    </div>
    <p className="semantic-mermaid-outline-note">The structured outline below is the accessible and interactive representation of this diagram.</p>
  </section>;
}

type CopyState = 'idle' | 'copied' | 'error';

export function MermaidSourceDisclosure({ source }: { source: string }) {
  const [copyState, setCopyState] = useState<CopyState>('idle');

  useEffect(() => setCopyState('idle'), [source]);

  const copySource = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(source);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  };

  return <details className="semantic-mermaid-source">
    <summary>Generated Mermaid source</summary>
    <div className="semantic-mermaid-source-actions">
      <span aria-live="polite">{copyState === 'copied' ? 'Source copied' : copyState === 'error' ? 'Copy unavailable' : 'Deterministic export payload'}</span>
      <button onClick={() => void copySource()} type="button">{copyState === 'copied' ? 'Copied' : 'Copy source'}</button>
    </div>
    <pre><code>{source}</code></pre>
  </details>;
}
