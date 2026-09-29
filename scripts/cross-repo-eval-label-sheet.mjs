// CLA-289: render the draft labels as a quick spot-check sheet with GitHub permalinks at each pinned SHA.
//
//   node scripts/cross-repo-eval-label-sheet.mjs   # rewrites docs/qa/cross-repo-eval/label-review.md
//
// Reads fixtures/cross-repo-eval/{manifest.json,labels/*.json}. Deterministic; no network.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('fixtures/cross-repo-eval/manifest.json', root), 'utf8'));
const out = fileURLToPath(new URL('docs/qa/cross-repo-eval/label-review.md', root));
const cell = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/_/g, '\\_').replace(/\|/g, '\\|').replace(/\n/g, ' ');
// Inside code spans only the table pipe needs escaping (HTML entities and backslashes would show literally).
const codeCell = text => String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const link = (repo, path) => `[${cell(path)}](${repo.url}/blob/${repo.commitSha}/${path.split('/').map(encodeURIComponent).join('/')})`;

const lines = [
  '# Cross-repo eval: draft label review (CLA-289)',
  '',
  'Every label below is `status: "draft"`: agent-written from reading each repo at its pinned commit. Questions were frozen before any retrieval or model run; Overview hand orders after enrichment (their candidates come from it) but before any block order was scored.',
  'Labels count as ground truth only after a spot-check. For each question, open the linked files and check two things:',
  '',
  '- the files answer the question;',
  '- the "must mention" terms are what a correct answer has to say.',
  '',
  'To record a verdict, edit the question in `fixtures/cross-repo-eval/labels/<slug>.json`:',
  '',
  '- set `"status": "checked"`, or fix it;',
  '- or set `"status": "rejected"` with a `"reviewNote"`.',
  '',
  'Then rerun `node scripts/cross-repo-eval-label-sheet.mjs` and `node scripts/cross-repo-eval.mjs report`.',
  '`a|b` in "must mention" means either term counts.',
  '',
];
let total = 0;
for (const repo of manifest.repos) {
  const labels = JSON.parse(readFileSync(new URL(`fixtures/cross-repo-eval/labels/${repo.slug}.json`, root), 'utf8'));
  total += labels.questions.length;
  lines.push(`## ${repo.repository} — ${repo.shape}`, '', `Pinned [\`${repo.commitSha.slice(0, 12)}\`](${repo.url}/tree/${repo.commitSha}) · ${repo.license} · ${repo.language} · ${repo.size.trackedFiles} files`, '');
  lines.push('| # | Question | Expected files | Must mention | Status |', '|---|---|---|---|---|');
  labels.questions.forEach((q, i) => {
    lines.push(`| ${i + 1} | ${cell(q.question)}<br><sub>\`${q.id}\` · ${q.category}${q.answerNote ? ` · ${cell(q.answerNote)}` : ''}${q.labelFix ? ` · <b>fix:</b> ${cell(q.labelFix)}` : ''}${q.reviewNote ? ` · <b>review:</b> ${cell(q.reviewNote)}` : ''}</sub> | ${q.expectedFiles.map(path => link(repo, path)).join('<br>')} | ${q.mustMention.map(m => `\`${codeCell(m)}\``).join(', ')} | ${q.status} |`);
  });
  const c4 = labels.c4Note;
  if (c4) lines.push('', `**C4 grouping: ${c4.verdict}.** ${cell(c4.note)}`);
  if (labels.overviews?.length) {
    lines.push('', '**Hand-ordered Overviews** (block ids, first = shown first):', '');
    for (const o of labels.overviews) lines.push(`- \`${o.nodeId}\`: ${o.order.map(id => `\`${id}\``).join(' → ')}${o.note ? ` — ${cell(o.note)}` : ''}`);
  }
  lines.push('');
}
lines.splice(3, 0, `${total} questions across ${manifest.repos.length} repos.`, '');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join('\n'));
console.log(`wrote ${out} (${total} questions)`);
