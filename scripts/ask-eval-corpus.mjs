#!/usr/bin/env node
// CLA-265: project an `okie-scan` snapshot into the committed Ask eval corpus.
//
//   node packages/scan/dist/cli.js --source . --out <dir> --system-name Okie --repo thiss__okie \
//     --enrich-from <copy of fixtures/enrichment/thiss-okie container__/system__ docs>
//   node scripts/ask-eval-corpus.mjs <dir>/snapshot.json fixtures/ask-eval/snapshot.json.gz
//
// Keeps only what Ask retrieval reads (ids, kinds, parents, names, responsibilities, source refs,
// excerpt text, non-duplicate relations). Excerpt `lines` are dropped: they always equal
// `text.split("\n")`. Output is deterministic (stable key order, fixed gzip level, no mtime).
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: node scripts/ask-eval-corpus.mjs <snapshot.json> <out.json.gz>");
  process.exit(2);
}
const snapshot = JSON.parse(readFileSync(input, "utf8"));
const ref = r => ({ path: r.path, commitSha: r.commitSha, ...(r.symbol ? { symbol: r.symbol } : {}), ...(r.startLine ? { startLine: r.startLine } : {}), ...(r.endLine ? { endLine: r.endLine } : {}) });
const entities = snapshot.entities.map(e => ({
  id: e.id,
  kind: e.kind,
  ...(e.parentId ? { parentId: e.parentId } : {}),
  name: e.name,
  ...(e.responsibility ? { responsibility: e.responsibility } : {}),
  sourceRefs: (e.sourceRefs ?? []).map(ref),
  ...(e.sourceExcerpts?.length ? {
    sourceExcerpts: e.sourceExcerpts.map(x => ({ path: x.path, ...(x.symbol ? { symbol: x.symbol } : {}), language: x.language, startLine: x.startLine, endLine: x.endLine, highlightLine: x.highlightLine, frozenRevision: x.frozenRevision, text: x.text })),
  } : {}),
}));
const relations = snapshot.relations.filter(r => r.kind !== "duplicates").map(r => ({ id: r.id, from: r.from, to: r.to, kind: r.kind, ...(r.label ? { label: r.label } : {}) }));
const corpus = { schemaVersion: snapshot.schemaVersion, id: snapshot.id, repositoryId: snapshot.repositoryId, commitSha: snapshot.commitSha, generatedAt: snapshot.generatedAt, entities, relations };
const gz = gzipSync(JSON.stringify(corpus), { level: 9 });
writeFileSync(output, gz);
console.log(`${output}: ${entities.length} entities, ${relations.length} relations, ${gz.length} bytes gzipped`);
