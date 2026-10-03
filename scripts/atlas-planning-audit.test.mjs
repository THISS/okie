import test from 'node:test';
import assert from 'node:assert/strict';
import { auditCitations, auditCorpus } from './atlas-planning-audit.mjs';
import { fileURLToPath } from 'node:url';

const commit = 'a'.repeat(40);
const captures = { schemaVersion: 1, owner: 'example', repo: 'app', commitSha: commit,
  windows: [ { path: 'src/app.ts', frozenRevision: commit, startLine: 10, endLine: 20, text: 'captured source' },
    { path: 'src/app.ts', frozenRevision: commit, startLine: 30, endLine: 40, text: 'another capture' } ] };
const link = (range = 'L10-L20', revision = commit, file = 'src/app.ts') =>
  `https://github.com/example/app/blob/${revision}/${file}#${range}`;

test('separate citations fit individual windows; latest visual URL is not frozen source', () => {
  assert.equal(auditCitations(`${link()} ${link('L30')} https://sourcefor.dev/r/example/app`, captures).citations, 2);
});
test('ordinary Markdown and sentence punctuation preserve valid citations', () => {
  for (const rendered of [`${link()}.`, `${link()},`, `${link()};`, `${link()}:`,
    `${link()}!`, `${link()}?`, '`' + link() + '`', `[${link()}]`, `[source](${link()})`]) {
    assert.equal(auditCitations(rendered, captures).citations, 1);
  }
});
test('line-anchored blame, tree and raw source links cannot hide beside valid citations', () => {
  for (const url of [link('L900').replace('/blob/', '/blame/'),
    link().replace('/blob/', '/tree/'),
    `https://raw.githubusercontent.com/example/app/${commit}/uncaptured.ts#L10`,
    `https://raw.githubusercontent.com/example/app/main/src/app.ts#L10`]) {
    assert.throws(() => auditCitations(`${link()} ${url}`, captures), /Invalid frozen source citation/);
  }
  assert.equal(auditCitations(`${link()} https://github.com/example/app/tree/${commit}`, captures).citations, 1);
});
test('a citation cannot bridge disjoint captures or rely on an uncaptured sourceRef', () => {
  for (const range of ['L10-L40', 'L21-L29', 'L9-L20', 'L30-L41']) {
    assert.throws(() => auditCitations(link(range), captures), /one captured window/);
  }
});
test('wrong repository, branch, revision, malformed range and path escapes fail', () => {
  for (const url of [link().replace('/example/', '/other/'), link('L10', 'b'.repeat(40)),
    link('L10', 'main'), link('L20-L10'), link('L0'), link('L10', commit, '../app.ts'),
    link('L10', commit, 'src/%2e%2e/app.ts'), link().replace('https:', 'http:'),
    link().replace('github.com/', 'github.com.attacker/'), link() + '?token=unexpected']) {
    assert.throws(() => auditCitations(url, captures));
    assert.throws(() => auditCitations(`${link()} ${url}`, captures));
  }
});
test('invalid capture identity and empty text cannot authorize citations', () => {
  assert.throws(() => auditCitations(link(), { ...captures, windows: [{ ...captures.windows[0], text: '' }] }));
  assert.throws(() => auditCitations(link(), { ...captures, commitSha: 'main' }));
  assert.throws(() => auditCitations('No sources retrieved.', captures));
});
test('recorded trial replays all citations; unexecuted cases never become passing agent trials', async () => {
  const results = await auditCorpus(fileURLToPath(new URL('../docs/qa/atlas-plugin/', import.meta.url)));
  assert.equal(results.length, 5);
  assert.equal(results[0].citations, 12);
  assert.equal(results[0].humanReview, 'needs-correction');
  assert.equal(results[0].successfulOperations, 34);
  assert.equal(results.filter(result => result.status === 'not-run').length, 4);
});

test('corpus paths cannot escape and unresolved findings cannot be relabeled reviewed', async () => {
  const { mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'atlas-corpus-audit-'));
  try {
    const original = JSON.parse(await readFile(new URL('../docs/qa/atlas-plugin/corpus.json', import.meta.url), 'utf8'));
    const unsafe = structuredClone(original);
    unsafe.cases[0].execution.captures = '../outside.json';
    await writeFile(join(directory, 'corpus.json'), JSON.stringify(unsafe));
    await assert.rejects(auditCorpus(directory), /Unsafe corpus resource path/);
    const relabeled = structuredClone(original);
    relabeled.cases[0].execution.humanReview.status = 'reviewed';
    await writeFile(join(directory, 'corpus.json'), JSON.stringify(relabeled));
    await assert.rejects(auditCorpus(directory), /Unresolved unsupported claims/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
