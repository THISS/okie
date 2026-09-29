#!/usr/bin/env node
// @ts-nocheck
/*
 * ask-dos-bench.mjs — CLA-304 defensive performance-regression benchmark.
 *
 * A local, self-contained worst-case-query benchmark for the Ask retrieval path
 * (apps/server: askRetrieval.ts `buildAskIndex` / `retrieveAskSections` and the
 * POST /api/ask HTTP handler in scanServer.ts). It measures how badly a hostile
 * (adversarially shaped) query stalls the Node event loop and inflates request
 * latency, so a before/after comparison can show the fix.
 *
 * Everything runs locally: a synthetic seeded snapshot, a locally started copy
 * of our own compiled server, and a local stub LLM gateway on 127.0.0.1. There
 * is no external target and no network beyond loopback. No LLM spend.
 *
 * Usage:
 *   node scripts/ask-dos-bench.mjs --server <buildDir> [--json] [--out <file>]
 *                                  [--vocab 120000] [--target-mb 55]
 *                                  [--runs 3] [--warm 8] [--cap-ms 90000]
 *
 * --server points at a build root that contains apps/server/dist (the compiled
 * server). The same script runs against the BEFORE and AFTER builds; it detects
 * API differences (e.g. an AFTER build that runs retrieval in a worker thread,
 * adds a per-IP limiter option, or returns 429 when busy) and reports status
 * codes rather than crashing.
 */

import { createServer } from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Args

function parseArgs(argv) {
  const args = { json: false, vocab: 120_000, targetMb: 55, runs: 3, warm: 8, burst: 12, capMs: 90_000, out: undefined, server: undefined };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--server") args.server = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--vocab") args.vocab = Number(argv[++i]);
    else if (a === "--target-mb") args.targetMb = Number(argv[++i]);
    else if (a === "--runs") args.runs = Number(argv[++i]);
    else if (a === "--warm") args.warm = Number(argv[++i]);
    else if (a === "--burst") args.burst = Number(argv[++i]);
    else if (a === "--cap-ms") args.capMs = Number(argv[++i]);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!args.server) throw new Error("--server <buildDir containing apps/server/dist> is required");
  return args;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) + word generation

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
function makeWord(rand, minLen, maxLen) {
  const len = minLen + Math.floor(rand() * (maxLen - minLen + 1));
  let w = "";
  for (let i = 0; i < len; i += 1) w += LETTERS[Math.floor(rand() * 26)];
  return w;
}

/** A pool of distinct synthetic words (>= count), avoiding pure-digit / stopword collisions. */
function buildVocabPool(rand, count) {
  const pool = [];
  const seen = new Set();
  // Bias lengths to the 6-9 range where fuzzy edit-distance + prefix scans engage hardest.
  while (pool.length < count) {
    const w = makeWord(rand, 6, 10);
    if (seen.has(w)) continue;
    seen.add(w);
    pool.push(w);
  }
  return pool;
}

// ---------------------------------------------------------------------------
// Synthetic snapshot

/**
 * Builds a deterministic snapshot whose vocabulary (distinct postings terms) is
 * close to `vocabTarget` and whose serialized size approaches `targetBytes`
 * (under MAX_ASK_SNAPSHOT_BYTES = 64 MB). Vocabulary is fed exactly as
 * buildAskIndex reads it: entity names, sourceRefs paths + symbols,
 * responsibility, and sourceExcerpts lines.
 */
function buildSnapshot({ seed, vocabTarget, targetBytes, commitSha, systemName }) {
  const rand = mulberry32(seed);
  const pool = buildVocabPool(rand, vocabTarget);
  let poolCursor = 0;
  const nextWord = () => pool[(poolCursor++) % pool.length];

  const entities = [];
  const relations = [];

  entities.push({ id: `system:${systemName}`, kind: "softwareSystem", name: systemName, sourceRefs: [{ path: "README.md", commitSha }] });
  const containerCount = 12;
  const containerIds = [];
  for (let c = 0; c < containerCount; c += 1) {
    const id = `container:c${c}`;
    containerIds.push(id);
    entities.push({ id, kind: "container", parentId: `system:${systemName}`, name: `${nextWord()}-${nextWord()}`, sourceRefs: [{ path: `pkg/${nextWord()}`, commitSha }] });
  }

  // Emit code+component entities until either the whole pool has been used at
  // least once (vocab coverage) or the byte target is reached.
  let approxBytes = 2_000;
  let fileIndex = 0;
  const perExcerptLines = 26;

  const sizeUnder = () => approxBytes < targetBytes;
  const poolCovered = () => poolCursor >= pool.length;

  while (sizeUnder() || !poolCovered()) {
    const container = containerIds[fileIndex % containerCount];
    const fileWord = nextWord();
    const fileId = `component:f${fileIndex}`;
    const path = `pkg/${fileWord}/${nextWord()}-${nextWord()}.ts`;
    entities.push({
      id: fileId,
      kind: "component",
      parentId: container,
      name: `${fileWord}/${nextWord()}.ts`,
      sourceRefs: [{ path, commitSha }],
    });
    approxBytes += path.length + 120;

    const codePerFile = 3;
    for (let k = 0; k < codePerFile; k += 1) {
      const sym = `${nextWord()}${nextWord()}`;
      const responsibility = Array.from({ length: 16 }, () => nextWord()).join(" ");
      const lines = [];
      for (let l = 0; l < perExcerptLines; l += 1) {
        const words = Array.from({ length: 10 }, () => nextWord());
        lines.push(`  ${words.join(" ")}`);
      }
      const excerptStart = 1 + k * 40;
      const codeId = `code:f${fileIndex}:s${k}`;
      entities.push({
        id: codeId,
        kind: "code",
        parentId: fileId,
        name: sym,
        responsibility,
        sourceRefs: [{ path, commitSha, symbol: sym, startLine: excerptStart, endLine: excerptStart + perExcerptLines }],
        sourceExcerpts: [{ startLine: excerptStart, symbol: sym, lines }],
      });
      approxBytes += responsibility.length + lines.reduce((s, ln) => s + ln.length + 12, 0) + 260;

      if (k > 0) {
        relations.push({ id: `rel:f${fileIndex}:s${k}`, from: codeId, to: `code:f${fileIndex}:s${k - 1}`, kind: "dependsOn" });
      }
    }
    // A cross-file relation so graph roll-up has edges to walk.
    if (fileIndex > 0) {
      relations.push({ id: `rel:file:${fileIndex}`, from: fileId, to: `component:f${fileIndex - 1}`, kind: "dependsOn" });
    }
    fileIndex += 1;
    // Safety valve so a mis-set target never loops forever.
    if (fileIndex > 5_000_000) break;
  }

  return {
    schemaVersion: 1,
    id: "snapshot:ask-dos-bench",
    repositoryId: "ask-dos-bench",
    commitSha,
    generatedAt: "2000-01-01T00:00:00.000Z",
    entities,
    relations,
  };
}

// ---------------------------------------------------------------------------
// Query builders

/** A "normal" question made from a few real vocabulary words (fast, in-vocab). */
function benignQuestion(vocabTerms) {
  const picks = [vocabTerms[3], vocabTerms[17], vocabTerms[42], vocabTerms[100]].filter(Boolean);
  return `how does the ${picks.join(" ")} work`;
}

/** worst-case: many distinct out-of-vocabulary tokens (~2,000 chars). */
function outOfVocabQuestion(postings, count = 400, seed = 0xC0FFEE) {
  const rand = mulberry32(seed);
  const tokens = [];
  const seen = new Set();
  while (tokens.length < count) {
    const t = makeWord(rand, 5, 5);
    if (seen.has(t) || postings.has(t)) continue;
    seen.add(t);
    tokens.push(t);
  }
  return tokens.join(" ");
}

/** worst-case: a few very long tokens (5 x 400 chars). */
function longTokensQuestion() {
  const rand = mulberry32(0xBADF00D);
  return Array.from({ length: 5 }, () => makeWord(rand, 400, 400)).join(" ");
}

/** repeated token: one out-of-vocab token repeated 400 times. */
function repeatedTokenQuestion(postings) {
  const rand = mulberry32(0x1234);
  let t;
  do { t = makeWord(rand, 6, 6); } while (postings.has(t));
  return Array.from({ length: 400 }, () => t).join(" ");
}

/** near-miss typos: real vocabulary terms mutated by one character. */
function typoQuestion(vocabTerms, postings, count = 400) {
  const rand = mulberry32(0x5EED);
  const out = [];
  let i = 0;
  const longTerms = vocabTerms.filter(t => t.length >= 7);
  while (out.length < count && i < longTerms.length * 4) {
    const base = longTerms[Math.floor(rand() * longTerms.length)] ?? vocabTerms[i % vocabTerms.length];
    i += 1;
    if (!base) break;
    const pos = Math.floor(rand() * base.length);
    const repl = LETTERS[Math.floor(rand() * 26)];
    const mutated = base.slice(0, pos) + repl + base.slice(pos + 1);
    if (mutated === base || postings.has(mutated)) continue;
    out.push(mutated);
  }
  return out.join(" ");
}

// ---------------------------------------------------------------------------
// Stats

function stats(samples) {
  if (samples.length === 0) return { median: 0, max: 0, p99: 0, count: 0 };
  const s = [...samples].sort((a, b) => a - b);
  const at = q => s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
  return { median: at(0.5), max: s[s.length - 1], p99: at(0.99), count: s.length };
}

const round = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// In-process timing

async function runInProcess({ askRetrieval, snapshot, runs, capMs }) {
  const { buildAskIndex, retrieveAskSections } = askRetrieval;

  const buildSamples = [];
  let index;
  for (let r = 0; r < Math.max(1, Math.min(runs, 3)); r += 1) {
    const t0 = performance.now();
    index = buildAskIndex(snapshot);
    buildSamples.push(performance.now() - t0);
  }

  const vocabTerms = [...index.postings.keys()];
  const postings = index.postings;

  const queries = {
    "benign (in-vocab)": benignQuestion(vocabTerms),
    "worst-case: out-of-vocabulary tokens (400)": outOfVocabQuestion(postings, 400),
    "worst-case: long tokens (5 x 400 chars)": longTokensQuestion(),
    "repeated token (x400)": repeatedTokenQuestion(postings),
    "near-miss typos (400)": typoQuestion(vocabTerms, postings, 400),
  };

  const results = {};
  for (const [label, question] of Object.entries(queries)) {
    // One warm-up call also tells us if a single call blows the time cap.
    const probe0 = performance.now();
    retrieveAskSections(index, question, { byteBudget: 24_000 });
    const probe = performance.now() - probe0;
    const effectiveRuns = probe > capMs ? 1 : Math.min(runs, probe > capMs / 3 ? 2 : runs);
    const samples = [];
    let capped = false;
    for (let r = 0; r < effectiveRuns; r += 1) {
      const t0 = performance.now();
      retrieveAskSections(index, question, { byteBudget: 24_000 });
      const dt = performance.now() - t0;
      samples.push(dt);
      if (dt > capMs) { capped = true; break; }
    }
    const st = stats(samples);
    // firstMs = the first call on this index (an AFTER build memoises token expansions per index).
    results[label] = { ...st, firstMs: probe, capped, questionChars: question.length };
  }

  return {
    vocab: index.postings.size,
    documents: index.documents.length,
    buildMs: stats(buildSamples),
    queries: results,
  };
}

// ---------------------------------------------------------------------------
// Stub LLM gateway (local, canned OpenAI-style completion)

function startStubGateway() {
  return new Promise((res) => {
    const server = createServer((req, response) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: "ok", citations: [] }) } }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => res({ server, port: server.address().port }));
  });
}

// ---------------------------------------------------------------------------
// Fake GitHub auth service (returns a session; never intercepts)

function fakeAuth() {
  const session = { id: "s1", login: "bench", userId: "bench-user", source: "test", token: "x", createdAt: 0 };
  return {
    config: {},
    sessionFromRequest: () => session,
    publicView: () => ({ authenticated: true, login: "bench", loginPath: "/login", logoutPath: "/logout", oauthConfigured: false }),
    handle: async () => false,
  };
}

const fakeQueue = {
  submit: () => { throw new Error("not used"); },
  get: () => undefined,
  list: () => [],
  idle: async () => {},
};

// ---------------------------------------------------------------------------
// HTTP event-loop responsiveness

function httpRequest({ port, path, method, body }) {
  return new Promise((res, rej) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = createHttpClientRequest({ port, path, method, len: data?.length ?? 0 }, (statusCode, text) => res({ statusCode, text }));
    req.on("error", rej);
    if (data) req.write(data);
    req.end();
  });
}

import { request as nodeRequest } from "node:http";
function createHttpClientRequest({ port, path, method, len }, onDone) {
  const req = nodeRequest({ host: "127.0.0.1", port, path, method, headers: { "content-type": "application/json", "content-length": len } }, (resp) => {
    let text = "";
    resp.on("data", (c) => { text += c; });
    resp.on("end", () => onDone(resp.statusCode, text));
  });
  return req;
}

/** The retrieval summary of an /api/ask response: proves the search actually ran (atlas mode, sections > 0). */
function retrievalOf(text) {
  try {
    const json = JSON.parse(text);
    return { mode: json?.retrieval?.mode ?? (json?.error ? `error: ${json.error}` : "none"), sections: json?.retrieval?.sectionCount ?? 0 };
  } catch { return { mode: "unparsed", sections: 0 }; }
}

async function runHttp({ scanServer, snapshot, gatewayPort, capMs, warm, burst }) {
  const { createScanHttpServer } = scanServer;

  // Scratch scan root with the snapshot at the slug slot createAskCorpusSource resolves.
  const owner = "benchowner";
  const repo = "benchrepo";
  const slug = `${owner}__${repo}`.toLowerCase();
  const scanRoot = join(tmpdir(), `ask-dos-scanroot-${process.pid}-${Date.now()}`);
  mkdirSync(join(scanRoot, slug), { recursive: true });
  writeFileSync(join(scanRoot, slug, "snapshot.json"), JSON.stringify(snapshot));

  const llm = { baseUrl: `http://127.0.0.1:${gatewayPort}`, modelId: "stub-model", keySource: "gateway", apiKey: "stub-key" };

  const options = {
    queue: fakeQueue,
    allowSubmit: () => true,
    auth: fakeAuth(),
    scanRoot,
    llm,
    enrich: "off",
    bind: "127.0.0.1",
    // Always allow — both a per-account and any AFTER per-IP style limiter.
    allowAsk: () => true,
    allowAskIp: () => true,
  };

  const server = createScanHttpServer(options);
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const port = server.address().port;

  // Hostile: out-of-vocab tokens. A distinct question per request, so no build's
  // expansion cache can turn a repeated hostile request into a cheap one.
  let questionSeq = 0;
  const nextBody = () => ({
    question: outOfVocabQuestion(new Set(), 400, 0xC0FFEE + (questionSeq++)),
    atlas: { owner, repo, commitSha: snapshot.commitSha },
    packets: [{ id: "p1", name: "sel", kind: "container" }],
  });
  const question = nextBody().question;

  // Event-loop lateness monitor. `windowMax` captures the worst single stall
  // seen during the current request window (a running max would be saturated by
  // the cold request and hide per-warm-request stalls); `lateSamples` is global.
  const lateSamples = [];
  let windowMax = 0;
  let last = performance.now();
  const period = 10;
  const timer = setInterval(() => {
    const now = performance.now();
    const late = now - last - period;
    last = now;
    if (late > 0) { windowMax = Math.max(windowMax, late); lateSamples.push(late); }
  }, period);

  const measure = async (label, singleCap) => {
    windowMax = 0;
    // A tick after the request settles lets the post-unblock late timer fire and be counted.
    const t0 = performance.now();
    const { statusCode, text } = await Promise.race([
      httpRequest({ port, path: "/api/ask", method: "POST", body: nextBody() }),
      new Promise((res) => setTimeout(() => res({ statusCode: -1, text: "" }), singleCap)),
    ]);
    const latency = performance.now() - t0;
    await new Promise((res) => setTimeout(res, period * 3));
    return { label, statusCode, latencyMs: round(latency), lateDuringMs: round(windowMax), ...retrievalOf(text) };
  };

  const cold = await measure("cold (includes index build)", capMs);

  const warmResults = [];
  for (let i = 0; i < warm; i += 1) warmResults.push(await measure(`warm #${i + 1}`, capMs));

  // Concurrent burst of distinct hostile questions: surfaces 429 "busy" admission
  // control (AFTER) vs. serialised main-thread stalls (BEFORE).
  windowMax = 0;
  const burstT0 = performance.now();
  const burstResults = await Promise.all(Array.from({ length: burst }, () => {
    const t0 = performance.now();
    return Promise.race([
      httpRequest({ port, path: "/api/ask", method: "POST", body: nextBody() }),
      new Promise((res) => setTimeout(() => res({ statusCode: -1, text: "" }), capMs)),
    ]).then(({ statusCode, text }) => ({ statusCode, latencyMs: round(performance.now() - t0), ...retrievalOf(text) }));
  }));
  const burstWallMs = round(performance.now() - burstT0);
  await new Promise((res) => setTimeout(res, period * 3));
  const burstLateMax = round(windowMax);
  const statusCounts = (rows) => rows.reduce((acc, r) => { acc[r.statusCode] = (acc[r.statusCode] ?? 0) + 1; return acc; }, {});

  clearInterval(timer);
  await new Promise((res) => server.close(res));
  try { rmSync(scanRoot, { recursive: true, force: true }); } catch { /* ignore */ }

  const warmLat = stats(warmResults.map(r => r.latencyMs));
  const lateStats = stats(lateSamples);

  return {
    cold,
    warm: warmResults,
    warmLatency: warmLat,
    warmStatusCodes: [...new Set(warmResults.map(r => r.statusCode))],
    burst: { size: burst, wallMs: burstWallMs, eventLoopLateMaxMs: burstLateMax, statusCounts: statusCounts(burstResults), latency: stats(burstResults.filter(r => r.statusCode === 200).map(r => r.latencyMs)), results: burstResults },
    eventLoopLateness: { max: round(lateStats.max), p99: round(lateStats.p99), samples: lateSamples.length },
    questionChars: question.length,
  };
}

// ---------------------------------------------------------------------------
// Reporting

function markdownTable(report) {
  const L = [];
  L.push(`## Ask worst-case-query benchmark`);
  L.push("");
  L.push(`- Node: ${report.env.node}`);
  L.push(`- CPU: ${report.env.cpu}`);
  L.push(`- Snapshot: ${report.snapshot.entities} entities, vocab ${report.inProcess.vocab} postings, ${report.snapshot.bytesMb} MB`);
  L.push(`- Index build (median / max): ${round(report.inProcess.buildMs.median)} / ${round(report.inProcess.buildMs.max)} ms`);
  L.push("");
  L.push(`### In-process \`retrieveAskSections\` (ms)`);
  L.push("");
  L.push(`| Query category | chars | first call | median | max | runs | note |`);
  L.push(`|---|--:|--:|--:|--:|--:|---|`);
  for (const [label, q] of Object.entries(report.inProcess.queries)) {
    L.push(`| ${label} | ${q.questionChars} | ${round(q.firstMs)} | ${round(q.median)} | ${round(q.max)} | ${q.count} | ${q.capped ? "capped (see cap-ms)" : ""} |`);
  }
  L.push("");
  L.push(`### HTTP POST /api/ask — event-loop responsiveness (hostile out-of-vocab query)`);
  L.push("");
  L.push(`| Metric | Value |`);
  L.push(`|---|--:|`);
  L.push(`| Cold request latency (incl. index build) | ${report.http.cold.latencyMs} ms (status ${report.http.cold.statusCode}) |`);
  L.push(`| Cold: event-loop lateness during request | ${report.http.cold.lateDuringMs} ms |`);
  L.push(`| Warm request latency (median / max) | ${round(report.http.warmLatency.median)} / ${round(report.http.warmLatency.max)} ms |`);
  L.push(`| Warm status codes | ${report.http.warmStatusCodes.join(", ")} |`);
  L.push(`| Warm retrieval (mode / sections) | ${report.http.warm.map(r => `${r.mode}/${r.sections}`).join(", ")} |`);
  L.push(`| Burst of ${report.http.burst.size} concurrent: status counts | ${JSON.stringify(report.http.burst.statusCounts)} |`);
  L.push(`| Burst: wall time / event-loop lateness max | ${report.http.burst.wallMs} / ${report.http.burst.eventLoopLateMaxMs} ms |`);
  L.push(`| Event-loop lateness (max / p99) over run | ${report.http.eventLoopLateness.max} / ${report.http.eventLoopLateness.p99} ms |`);
  L.push("");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Main

async function main() {
  const args = parseArgs(process.argv);
  const serverDist = resolve(args.server, "apps/server/dist");
  const askRetrieval = await import(pathToFileURL(join(serverDist, "askRetrieval.js")).href);
  const scanServer = await import(pathToFileURL(join(serverDist, "scanServer.js")).href);

  const commitSha = "beefbeefbeefbeefbeefbeefbeefbeefbeefbeef";
  const targetBytes = Math.floor(args.targetMb * 1024 * 1024);

  process.stderr.write(`building synthetic snapshot (vocab~${args.vocab}, target ${args.targetMb} MB)...\n`);
  const snapshot = buildSnapshot({ seed: 1, vocabTarget: args.vocab, targetBytes, commitSha, systemName: "benchsystem" });
  const serialized = JSON.stringify(snapshot);
  const bytes = Buffer.byteLength(serialized);
  const cap = askRetrieval.MAX_ASK_SNAPSHOT_BYTES ?? 64 * 1024 * 1024;
  if (bytes > cap) throw new Error(`snapshot ${bytes} exceeds MAX_ASK_SNAPSHOT_BYTES ${cap}; lower --target-mb`);

  process.stderr.write(`snapshot: ${snapshot.entities.length} entities, ${round(bytes / 1024 / 1024)} MB (cap ${round(cap / 1024 / 1024)} MB)\n`);

  process.stderr.write(`in-process timing...\n`);
  const inProcess = await runInProcess({ askRetrieval, snapshot, runs: args.runs, capMs: args.capMs });

  process.stderr.write(`starting stub gateway + server for HTTP timing...\n`);
  const { server: gateway, port: gatewayPort } = await startStubGateway();
  let http;
  try {
    http = await runHttp({ scanServer, snapshot, gatewayPort, capMs: args.capMs, warm: args.warm, burst: args.burst });
  } finally {
    await new Promise((res) => gateway.close(res));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    env: { node: process.version, cpu: process.env.__BENCH_CPU__ || "unknown" },
    server: serverDist,
    args: { vocab: args.vocab, targetMb: args.targetMb, runs: args.runs, warm: args.warm, burst: args.burst, capMs: args.capMs },
    snapshot: { entities: snapshot.entities.length, relations: snapshot.relations.length, bytes, bytesMb: round(bytes / 1024 / 1024) },
    inProcess,
    http,
  };

  if (args.json) {
    const json = JSON.stringify(report, null, 2);
    if (args.out) writeFileSync(args.out, json);
    process.stdout.write(json + "\n");
  } else {
    const md = markdownTable(report);
    if (args.out) writeFileSync(args.out, md + "\n");
    process.stdout.write(md + "\n");
  }
}

main().then(() => process.exit(0)).catch((e) => { process.stderr.write(String(e?.stack ?? e) + "\n"); process.exit(1); });
