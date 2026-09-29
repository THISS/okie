import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { atlasAttributionFor, attributionText, installPublishedAtlasAttribution } from './atlasAttribution';

const SHA = '4f1c2a9e0b7d6c5a4f3e2d1c0b9a8f7e6d5c4b3a';
const INDEX = {
  schema: 'okie.published-index/v1',
  schemaVersion: 1,
  repos: [
    {
      slug: 'pmndrs__zustand',
      owner: 'pmndrs',
      repo: 'zustand',
      repositoryId: 'repo:pmndrs-zustand',
      versionId: 'publication-1',
      commitSha: SHA,
      generatedAt: '2026-09-30T00:00:00Z',
      entityCount: 120,
      publishedAt: '2026-09-30T00:00:00Z',
      license: { spdxId: 'MIT', name: 'MIT License', url: `https://github.com/pmndrs/zustand/blob/${SHA}/LICENSE` },
    },
    { slug: 'acme__local', owner: 'acme', repo: 'local', commitSha: SHA, generatedAt: '2026-09-30T00:00:00Z' },
  ],
};

/** Just enough DOM for renderAtlasAttribution (the web test env has no DOM). */
function fakeDocument() {
  type Node = { tag: string; attrs: Record<string, string>; children: Array<Node | string>; textContent?: string; dataset: Record<string, string>; [key: string]: unknown };
  const make = (tag: string): Node => {
    const node: Node = {
      tag,
      attrs: {},
      children: [],
      dataset: {},
      setAttribute(name: string, value: string) { node.attrs[name] = value; },
      append(...items: Array<Node | string>) { node.children.push(...items); },
    };
    return node;
  };
  const body = make('body');
  const root = make('html');
  const doc = {
    body,
    documentElement: root,
    createElement: make,
    createTextNode: (text: string) => text,
    querySelector: () => null,
  };
  const text = (node: Node | string): string => typeof node === 'string' ? node : node.textContent ?? node.children.map(text).join('');
  const links = (node: Node | string): Array<{ text: string; href: string; rel: string }> => typeof node === 'string' ? [] : [
    ...(node.tag === 'a' ? [{ text: text(node), href: String(node.href), rel: String(node.rel) }] : []),
    ...node.children.flatMap(links),
  ];
  return { doc: doc as unknown as Document, body, root, text, links };
}

describe('published atlas attribution (CLA-266)', () => {
  it('maps the slug row of /scan/index.json to repo, commit and licence links', () => {
    const attribution = atlasAttributionFor(INDEX, 'pmndrs__zustand');
    expect(attribution).toEqual({
      owner: 'pmndrs',
      repo: 'zustand',
      commitSha: SHA,
      shortSha: '4f1c2a9',
      treeUrl: `https://github.com/pmndrs/zustand/tree/${SHA}`,
      commitUrl: `https://github.com/pmndrs/zustand/commit/${SHA}`,
      licenceLabel: 'MIT licence',
      licenceUrl: `https://github.com/pmndrs/zustand/blob/${SHA}/LICENSE`,
    });
    expect(attributionText(attribution!)).toBe('Source For Atlas · zustand by pmndrs · commit 4f1c2a9 · MIT licence · source on GitHub');
  });

  it('renders nothing for rows that are not publications or are malformed', () => {
    expect(atlasAttributionFor(INDEX, 'acme__local')).toBeUndefined(); // no licence: not from a publication
    expect(atlasAttributionFor(INDEX, 'nobody__here')).toBeUndefined();
    expect(atlasAttributionFor(undefined, 'pmndrs__zustand')).toBeUndefined();
    expect(atlasAttributionFor({ repos: 'x' }, 'pmndrs__zustand')).toBeUndefined();
    const row = INDEX.repos[0]!;
    const variant = (patch: Record<string, unknown>) => atlasAttributionFor({ repos: [{ ...row, ...patch }] }, 'pmndrs__zustand');
    expect(variant({ owner: 'pm/ndrs' })).toBeUndefined();
    expect(variant({ commitSha: 'main' })).toBeUndefined();
    expect(variant({ license: { spdxId: '', name: '' } })).toBeUndefined();
    // Licence URL must be https; the rest still renders.
    expect(variant({ license: { spdxId: 'MIT', name: 'MIT License', url: 'javascript:alert(1)' } })).not.toHaveProperty('licenceUrl');
    expect(variant({ license: { spdxId: 'NOASSERTION', name: 'Other' } })?.licenceLabel).toBe('Other');
    expect(variant({ license: { spdxId: 'Apache-2.0', name: 'Apache License 2.0' } })?.licenceLabel).toBe('Apache-2.0 licence');
    // SPDX expressions (operator overrides) read as a list.
    expect(variant({ license: { spdxId: 'MIT AND CC-BY-4.0', name: 'MIT AND CC-BY-4.0' } })?.licenceLabel).toBe('licence: MIT AND CC-BY-4.0');
    expect(variant({ license: { spdxId: 'Unlicense OR MIT', name: 'Unlicense OR MIT' } })?.licenceLabel).toBe('licence: Unlicense OR MIT');
  });

  it('installs a labelled footer with GitHub links, and skips embeds', async () => {
    const fetchIndex = vi.fn(async () => new Response(JSON.stringify(INDEX), { status: 200 })) as unknown as typeof fetch;
    const page = fakeDocument();
    const installed = await installPublishedAtlasAttribution('pmndrs__zustand', { fetch: fetchIndex, doc: page.doc, search: '', framed: false });
    expect(installed?.repo).toBe('zustand');
    const footer = page.body.children[0] as { tag: string; attrs: Record<string, string> };
    expect(footer.tag).toBe('footer');
    expect(footer.attrs['aria-label']).toBe('Atlas attribution');
    expect(page.text(footer as never)).toBe(attributionText(installed!));
    expect(page.links(footer as never).map(link => [link.text, link.href, link.rel])).toEqual([
      ['zustand', `https://github.com/pmndrs/zustand/tree/${SHA}`, 'noopener noreferrer'],
      ['4f1c2a9', `https://github.com/pmndrs/zustand/commit/${SHA}`, 'noopener noreferrer'],
      ['MIT licence', `https://github.com/pmndrs/zustand/blob/${SHA}/LICENSE`, 'noopener noreferrer'],
      ['source on GitHub', `https://github.com/pmndrs/zustand/tree/${SHA}`, 'noopener noreferrer'],
    ]);
    expect(page.root.attrs['data-atlas-attribution']).toBe('');

    const embed = fakeDocument();
    expect(await installPublishedAtlasAttribution('pmndrs__zustand', { fetch: fetchIndex, doc: embed.doc, search: '?embed=1', framed: false })).toBeUndefined();
    expect(await installPublishedAtlasAttribution('pmndrs__zustand', { fetch: fetchIndex, doc: embed.doc, search: '', framed: true })).toBeUndefined();
    expect(embed.body.children).toHaveLength(0);
    const failing = vi.fn(async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    expect(await installPublishedAtlasAttribution('pmndrs__zustand', { fetch: failing, doc: embed.doc, search: '', framed: false })).toBeUndefined();
  });

  it('reserves its height in the layout instead of overlapping the canvas controls', () => {
    const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');
    expect(css).toContain('html[data-atlas-attribution] #root { height: calc(100% - var(--atlas-attribution-height)); }');
    expect(css).toMatch(/\.atlas-attribution \{[^}]*position: fixed;[^}]*height: var\(--atlas-attribution-height\);/);
    const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
    expect(main).toContain('installPublishedAtlasAttribution(route.slug)');
  });
});
