export type SourceContext = { scanBasePath: string; owner: string; repo: string };
export type SourceRange = { repository: string; commit: string; path: string; startLine: number; endLine: number; totalLines: number; lines: string[]; digest: string };
export function immutableFileUrl(context: SourceContext, commit: string, path: string): string | undefined {
  if (!/^[a-f0-9]{40}$/u.test(commit) || !/^[a-zA-Z0-9-]+$/u.test(context.owner) || !/^[a-zA-Z0-9_.-]+$/u.test(context.repo)) return undefined;
  return `https://github.com/${context.owner}/${context.repo}/blob/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
}
export function createSourceFetcher(fetchImpl: typeof fetch = fetch) {
  const cache = new Map<string, SourceRange>();
  return async (context: SourceContext, commit: string, path: string, start: number, end: number, signal?: AbortSignal): Promise<SourceRange> => {
    const params = new URLSearchParams({ owner: context.owner, repo: context.repo, commit, path, start: String(start), end: String(end) });
    const url = `${context.scanBasePath.replace(/\/$/u, '')}/source.json?${params}`;
    if (cache.has(url)) return cache.get(url)!;
    const response = await fetchImpl(url, { ...(signal ? { signal } : {}) });
    const result = await response.json() as SourceRange & { error?: string };
    if (!response.ok) throw new Error(result.error ?? 'Historical source unavailable.');
    if (result.commit !== commit || result.path !== path || result.repository.toLowerCase() !== `${context.owner}/${context.repo}`.toLowerCase()
      || result.startLine !== start || result.endLine > end || result.endLine < start || result.totalLines < result.endLine
      || !Array.isArray(result.lines) || result.lines.length !== result.endLine - start + 1 || result.lines.some(line => typeof line !== 'string')) throw new Error('Historical source response does not match this selection.');
    if (cache.size >= 32) cache.delete(cache.keys().next().value!);
    cache.set(url, result);
    return result;
  };
}
export const fetchSourceRange = createSourceFetcher();
