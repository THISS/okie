import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ArchitectureSnapshot } from "@okie/architecture";
import { parseGithubSource } from "@okie/scan";
import { resolvePublishedScanFile } from "./scanObjects.js";

const MAX_BYTES = 1024 * 1024;
const MAX_LINES = 500;
export class SourceRequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
/** Resolves one immutable publication artifact. Undefined is deliberately a
 * closed miss: callers must never fall back to the mutable legacy scan root. */
export type VersionedSnapshotResolver = (input: { scanRoot: string; pathname: string; repositoryId: string; versionId: string }) => string | undefined;
export function validSourcePath(path: string): boolean {
  return path.length > 0 && path.length <= 512 && !/[\\:%?#\u0000-\u001f\u007f]/u.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
export function isSourceScanPath(path: string): boolean { return /^\/scan\/(?:[a-z0-9_-]+\/)?source\.json$/u.test(path); }
function slug(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

/** Each handler has a bounded immutable file cache; no machine credentials or checkout fallback. */
export function createSourceService(fetchSource: typeof fetch = fetch, resolveVersionedSnapshot?: VersionedSnapshotResolver) {
  const cache = new Map<string, { lines: string[]; digest: string }>();
  return async (scanRoot: string, pathname: string, params: URLSearchParams) => {
    const owner = params.get('owner') ?? '', repo = params.get('repo') ?? '';
    const commit = params.get('commit') ?? '', path = params.get('path') ?? '';
    const version = params.get('version');
    const start = Number(params.get('start')), end = Number(params.get('end'));
    if (!isSourceScanPath(pathname) || !/^[a-zA-Z0-9-]+$/u.test(owner) || !/^[a-zA-Z0-9_.-]+$/u.test(repo)
      || !/^[a-f0-9]{40}$/u.test(commit) || !validSourcePath(path)
      || (version !== null && (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,180}$/u.test(version)))
      || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start + 1 > MAX_LINES) {
      throw new SourceRequestError(400, 'Invalid immutable source request.');
    }
    const source = parseGithubSource(`gh:${owner}/${repo}`);
    const base = pathname.slice(0, -'source.json'.length);
    if (base !== `/scan/${source?.dirSlug}/` && !(base === '/scan/' && owner.toLowerCase() === 'thiss' && repo.toLowerCase() === 'okie')) {
      throw new SourceRequestError(404, 'Repository does not match this published atlas.');
    }
    const repositoryId = `repo:${slug(`${owner}-${repo}`)}`;
    const file = version === null
      ? resolvePublishedScanFile(scanRoot, `${base}snapshot.json`)
      : resolveVersionedSnapshot?.({ scanRoot, pathname: `${base}snapshot.json`, repositoryId, versionId: version });
    if (!file) throw new SourceRequestError(404, 'Published snapshot unavailable.');
    const snapshot = JSON.parse(readFileSync(file, 'utf8')) as ArchitectureSnapshot;
    // The root self-scan predates owner-qualified repository IDs. Only the
    // existing THISS/okie publication alias may use its legacy identity.
    const legacyDogfood = owner.toLowerCase() === 'thiss' && repo.toLowerCase() === 'okie'
      && snapshot.repositoryId === 'repo:okie';
    if (snapshot.commitSha !== commit || (!legacyDogfood && snapshot.repositoryId !== repositoryId)
      || !snapshot.entities.some(entity => entity.sourceRefs.some(ref => ref.path === path && ref.commitSha === commit))) {
      throw new SourceRequestError(404, 'Source is not recorded at this published revision.');
    }
    const key = `${version ?? 'legacy'}/${owner.toLowerCase()}/${repo.toLowerCase()}/${commit}/${path}`;
    let content = cache.get(key);
    if (!content) {
      const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
      let response: Response;
      try { response = await fetchSource(url, { redirect: 'error', signal: AbortSignal.timeout(15000) }); }
      catch { throw new SourceRequestError(502, 'Historical source is unavailable. The saved excerpt remains available.'); }
      if (!response.ok || !response.body) throw new SourceRequestError(502, 'Historical source is unavailable. The saved excerpt remains available.');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > MAX_BYTES) throw new SourceRequestError(413, 'File exceeds the 1 MiB source limit.');
          chunks.push(next.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const buffer = Buffer.concat(chunks);
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
      catch { throw new SourceRequestError(422, 'Source is not UTF-8 text.'); }
      if (text.includes('\0')) throw new SourceRequestError(422, 'Source is not a text file.');
      content = { lines: text.replace(/\r\n/g, '\n').split('\n'), digest: createHash('sha256').update(buffer).digest('hex') };
      if (cache.size >= 16) cache.delete(cache.keys().next().value!);
      cache.set(key, content);
    }
    if (start > content.lines.length) throw new SourceRequestError(416, 'Requested lines are outside this file.');
    return { repository: `${owner}/${repo}`, commit, path, startLine: start, endLine: Math.min(end, content.lines.length), totalLines: content.lines.length, lines: content.lines.slice(start - 1, end), digest: content.digest };
  };
}
