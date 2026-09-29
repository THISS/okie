import { isFramedBrowsingContext } from './embedCanvas';
import { isEmbedChrome, isEmbedQueryFlag } from './embedChrome';

/**
 * CLA-266 attribution for published atlases. Every `/r/<owner>/<repo>` page whose atlas came from a
 * publication shows the upstream repository, the pinned commit and its licence, linked back to GitHub.
 * The data is the slug's row in `/scan/index.json` (the published index carries owner, repo, commitSha
 * and license {spdxId, name, url}); a row without a licence is not a publication, so nothing renders.
 *
 * Rendered as a small fixed strip outside the React root (main.tsx), so the atlas shell is untouched;
 * `html[data-atlas-attribution]` shrinks `#root` by the strip height so nothing overlaps the canvas
 * controls (app.css). Hidden in embed contexts (framed or `?embed=1`), which keep map-first chrome.
 */

export type PublishedAtlasAttribution = {
  owner: string;
  repo: string;
  commitSha: string;
  shortSha: string;
  /** Repository tree at the pinned commit. */
  treeUrl: string;
  commitUrl: string;
  licenceLabel: string;
  licenceUrl?: string;
};

const GITHUB_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const COMMIT = /^[a-f0-9]{7,40}$/;

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function licenceLabel(spdxId: string, name: string): string {
  // An SPDX expression ("MIT AND CC-BY-4.0", "Unlicense OR MIT") reads as a list, not an adjective.
  if (spdxId && /\s/.test(spdxId)) return `licence: ${spdxId}`;
  if (spdxId && spdxId !== 'NOASSERTION') return `${spdxId} licence`;
  return name ? name : 'Licence not asserted';
}

/** The attribution for `slug` from a published index, or undefined when it is not a publication. */
export function atlasAttributionFor(index: unknown, slug: string): PublishedAtlasAttribution | undefined {
  const repos = (index as { repos?: unknown } | null)?.repos;
  if (!Array.isArray(repos)) return undefined;
  const row = repos.find(candidate => (candidate as { slug?: unknown } | null)?.slug === slug) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const { owner, repo, commitSha, license } = row;
  if (typeof owner !== 'string' || typeof repo !== 'string' || typeof commitSha !== 'string') return undefined;
  if (!GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repo) || !COMMIT.test(commitSha)) return undefined;
  if (!license || typeof license !== 'object') return undefined;
  const spdxId = typeof (license as { spdxId?: unknown }).spdxId === 'string' ? (license as { spdxId: string }).spdxId.trim() : '';
  const name = typeof (license as { name?: unknown }).name === 'string' ? (license as { name: string }).name.trim() : '';
  if (!spdxId && !name) return undefined;
  const base = `https://github.com/${owner}/${repo}`;
  const licenceUrl = httpsUrl((license as { url?: unknown }).url);
  return {
    owner,
    repo,
    commitSha,
    shortSha: commitSha.slice(0, 7),
    treeUrl: `${base}/tree/${commitSha}`,
    commitUrl: `${base}/commit/${commitSha}`,
    licenceLabel: licenceLabel(spdxId, name),
    ...(licenceUrl ? { licenceUrl } : {}),
  };
}

/** The strip's words, in order, as plain text (also its accessible description). */
export function attributionText(attribution: PublishedAtlasAttribution): string {
  return `Source For Atlas · ${attribution.repo} by ${attribution.owner} · commit ${attribution.shortSha} · ${attribution.licenceLabel} · source on GitHub`;
}

type Part = string | { text: string; href: string; code?: boolean };

function parts(attribution: PublishedAtlasAttribution): Part[] {
  return [
    'Source For Atlas · ',
    { text: attribution.repo, href: attribution.treeUrl },
    ` by ${attribution.owner} · commit `,
    { text: attribution.shortSha, href: attribution.commitUrl, code: true },
    ' · ',
    attribution.licenceUrl ? { text: attribution.licenceLabel, href: attribution.licenceUrl } : attribution.licenceLabel,
    ' · ',
    { text: 'source on GitHub', href: attribution.treeUrl },
  ];
}

export const ATTRIBUTION_ATTRIBUTE = 'data-atlas-attribution';

/** Build (or replace) the strip in `doc`. Links open GitHub in a new tab without an opener. */
export function renderAtlasAttribution(doc: Document, attribution: PublishedAtlasAttribution): HTMLElement {
  doc.querySelector('footer.atlas-attribution')?.remove();
  const footer = doc.createElement('footer');
  footer.className = 'atlas-attribution';
  footer.setAttribute('aria-label', 'Atlas attribution');
  footer.dataset.testid = 'atlas-attribution';
  const line = doc.createElement('p');
  for (const part of parts(attribution)) {
    if (typeof part === 'string') {
      line.append(doc.createTextNode(part));
      continue;
    }
    const link = doc.createElement('a');
    link.href = part.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    if (part.code) {
      const code = doc.createElement('code');
      code.textContent = part.text;
      link.append(code);
    } else {
      link.textContent = part.text;
    }
    line.append(link);
  }
  footer.append(line);
  doc.body.append(footer);
  doc.documentElement.setAttribute(ATTRIBUTION_ATTRIBUTE, '');
  return footer;
}

/** Fetch the published index and show the strip for `slug` (no-op in embeds or for non-publications). */
export async function installPublishedAtlasAttribution(
  slug: string,
  options: { fetch?: typeof fetch; doc?: Document; search?: string; framed?: boolean } = {},
): Promise<PublishedAtlasAttribution | undefined> {
  const search = options.search ?? window.location.search;
  const framed = options.framed ?? isFramedBrowsingContext();
  if (isEmbedChrome({ framed, embedQuery: isEmbedQueryFlag(search) })) return undefined;
  const fetchImpl = options.fetch ?? fetch;
  try {
    const response = await fetchImpl('/scan/index.json', { headers: { accept: 'application/json' } });
    if (!response.ok) return undefined;
    const attribution = atlasAttributionFor(await response.json(), slug);
    if (attribution) renderAtlasAttribution(options.doc ?? document, attribution);
    return attribution;
  } catch {
    return undefined;
  }
}
