import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const sha = /^[a-f0-9]{40}$/;
const sourcePath = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const positive = value => Number.isSafeInteger(value) && value > 0;

// Checks citation containment, not whether prose is supported by the cited code.
export function auditCitations(report, captures) {
  if (captures.schemaVersion !== 1 || !sha.test(captures.commitSha)
      || !/^[A-Za-z0-9_.-]+$/.test(captures.owner) || !/^[A-Za-z0-9_.-]+$/.test(captures.repo)
      || !Array.isArray(captures.windows)) throw new Error('Invalid capture identity');
  for (const window of captures.windows) {
    if (!sourcePath.test(window.path) || window.frozenRevision !== captures.commitSha
        || !positive(window.startLine) || !positive(window.endLine) || window.endLine < window.startLine
        || typeof window.text !== 'string' || !window.text.trim()) throw new Error('Invalid captured window');
  }
  const links = [...report.matchAll(/https?:\/\/[^\s)<>]+/g)].map(match => match[0]);
  const citations = links.filter(link => /\/blob\//.test(link));
  if (!citations.length) throw new Error('Recorded evidence plan has no source citations');
  for (const link of citations) {
    const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([a-f0-9]{40})\/(.+)#L([1-9]\d*)(?:-L([1-9]\d*))?$/.exec(link);
    if (!match) throw new Error(`Invalid frozen source citation: ${link}`);
    const [, owner, repo, commit, file, first, last] = match;
    const start = Number(first), end = Number(last ?? first);
    if (owner !== captures.owner || repo !== captures.repo || commit !== captures.commitSha
        || !sourcePath.test(file) || !positive(start) || !positive(end) || end < start) {
      throw new Error(`Citation identity or range mismatch: ${link}`);
    }
    if (!captures.windows.some(window => window.path === file && window.frozenRevision === commit
        && start >= window.startLine && end <= window.endLine)) {
      throw new Error(`Citation is not inside one captured window: ${link}`);
    }
  }
  return { citations: citations.length, capturedWindows: captures.windows.length };
}

export async function auditCorpus(directory) {
  const load = async file => {
    if (!sourcePath.test(file)) throw new Error('Unsafe corpus resource path');
    const text = await readFile(path.join(directory, file), 'utf8');
    if (Buffer.byteLength(text) > 512 * 1024) throw new Error('Corpus resource exceeds 512 KiB');
    return text;
  };
  const corpus = JSON.parse(await load('corpus.json'));
  if (corpus.schemaVersion !== 1 || !Array.isArray(corpus.cases) || !corpus.cases.length) throw new Error('Invalid corpus');
  const ids = new Set();
  const results = [];
  for (const item of corpus.cases) {
    if (!item.id || ids.has(item.id) || !item.prompt?.trim()) throw new Error('Missing or duplicate case');
    ids.add(item.id);
    for (const field of ['dependencies', 'validation']) {
      if (!Array.isArray(item.review?.[field]) || !item.review[field].length
          || item.review[field].some(value => typeof value !== 'string' || !value.trim())) throw new Error(`Missing ${field} rubric`);
    }
    for (const field of ['unsupportedClaims', 'freshness']) {
      if (!item.review?.[field]?.trim()) throw new Error(`Missing ${field} rubric`);
    }
    if (item.execution?.status === 'not-run' && item.execution.reason?.trim()) {
      results.push({ id: item.id, status: 'not-run' });
      continue;
    }
    if (item.execution?.status !== 'recorded-offline') throw new Error('Unknown execution status');
    const review = item.execution.humanReview;
    if (!['needs-correction', 'reviewed'].includes(review?.status)
        || !Array.isArray(review.unsupportedClaims) || !Array.isArray(review.missedDependencies)
        || !review.citationReview?.trim() || !review.freshness?.trim() || !review.usefulValidation?.trim()
        || !positive(item.execution.successfulOperations)) throw new Error('Incomplete recorded review');
    if (review.status === 'reviewed' && review.unsupportedClaims.length) throw new Error('Unresolved unsupported claims cannot have a reviewed verdict');
    const captures = JSON.parse(await load(item.execution.captures));
    const report = await load(item.execution.report);
    results.push({ id: item.id, status: 'recorded-offline', humanReview: review.status,
      successfulOperations: item.execution.successfulOperations, ...auditCitations(report, captures) });
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = await auditCorpus(fileURLToPath(new URL('../docs/qa/atlas-plugin/', import.meta.url)));
  console.log(JSON.stringify({ scope: 'Offline citation regression; human findings and unexecuted cases remain explicit.', results }, null, 2));
}
