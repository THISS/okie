import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { citationsNamedInAnswer, parseAskCompletion } from "./ask.js";
import {
  afterAskChatCompletionsBody,
  askRequestSha256,
  ASK_EVAL_DIR,
  buildAskEvalIndex,
  familyMean,
  legacyAskChatCompletionsBody,
  citedFiles,
  fileRecall,
  loadAskEvalFixture,
  runAskEvalQuestion,
  saysNotInEvidence,
} from "./askEval.js";
import { DEFAULT_ASK_BYTE_BUDGET } from "./askRetrieval.js";
import type { AskEvalReplay } from "./askEvalLive.js";

/**
 * CLA-265 Ask eval over a committed self-scan of THISS/okie. Never calls a live model:
 * BEFORE = web `buildAskContext` packets for the question's starting selection (the pre-CLA-265
 * evidence); AFTER = whole-atlas retrieval + those packets. Metric: expected-file recall in the
 * evidence sent to the model. `replay.json` (recorded by `askEvalLive.ts`) checks the answers.
 */

const fixture = loadAskEvalFixture();
const index = buildAskEvalIndex(fixture);
const runs = fixture.questions.map(question => runAskEvalQuestion(fixture, index, question));

test("eval corpus is the committed THISS/okie self-scan", () => {
  assert.ok(fixture.snapshot.entities.length > 4_000);
  assert.ok(fixture.questions.length >= 5);
  assert.ok(fixture.questions.some(question => /\bOki\b/.test(question.question)), "keeps the 'Oki' typo variant");
  const levels = new Set(fixture.questions.map(question => question.selection.level));
  for (const level of ["L1 system", "container", "component"]) assert.ok(levels.has(level), level);
  // Every expected file and starting selection exists in the corpus.
  const paths = new Set(index.documents.map(doc => doc.path));
  for (const question of fixture.questions) {
    assert.ok(index.byId.has(question.selection.selectedId), question.selection.selectedId);
    for (const file of question.expectedFiles) assert.ok(paths.has(file), file);
  }
});

test("evidence recall: whole-atlas retrieval never loses to the selected-scope packets", t => {
  const row = (run: typeof runs[number]) => `| ${run.question.id} | ${run.question.selection.level} | ${run.before.recall.toFixed(2)} | ${run.after.recall.toFixed(2)} | ${run.after.sections.length} | ${run.after.bytes} |`;
  const tuned = runs.filter(run => !run.question.heldOut);
  const heldOut = runs.filter(run => run.question.heldOut && !run.question.heldOutSet);
  const heldOutV2 = runs.filter(run => run.question.heldOutSet === "v2-vocabulary-gap");
  for (const line of ["| question | selection | recall before | recall after | sections | bytes |", ...tuned.map(row)]) t.diagnostic(line);
  t.diagnostic(`tuning set, mean over ${new Set(tuned.map(run => run.question.family)).size} families: before ${familyMean(tuned, run => run.before.recall).toFixed(2)}, after ${familyMean(tuned, run => run.after.recall).toFixed(2)}`);
  for (const line of ["held-out v1 (lexical; never used to tune):", ...heldOut.map(row)]) t.diagnostic(line);
  t.diagnostic(`held-out v1, mean over ${heldOut.length} families: before ${familyMean(heldOut, run => run.before.recall).toFixed(2)}, after ${familyMean(heldOut, run => run.after.recall).toFixed(2)}`);
  for (const line of ["held-out v2 (vocabulary gap; frozen before retrieval ran on it):", ...heldOutV2.map(row)]) t.diagnostic(line);
  t.diagnostic(`held-out v2, mean over ${heldOutV2.length} families: before ${familyMean(heldOutV2, run => run.before.recall).toFixed(2)}, after ${familyMean(heldOutV2, run => run.after.recall).toFixed(2)}`);
  for (const run of runs) {
    assert.ok(run.after.recall >= run.before.recall, `${run.question.id}: ${run.after.recall} < ${run.before.recall}`);
    assert.ok(run.after.bytes <= DEFAULT_ASK_BYTE_BUDGET, `${run.question.id}: ${run.after.bytes} bytes`);
  }
  assert.ok(heldOut.length >= 4, "held-out v1 questions are part of the eval");
  assert.ok(heldOutV2.length >= 3, "held-out v2 questions are part of the eval");
  assert.ok(familyMean(tuned, run => run.after.recall) > familyMean(tuned, run => run.before.recall));
  assert.ok(familyMean(heldOut, run => run.after.recall) > familyMean(heldOut, run => run.before.recall));
  // Held-out v2 floors are the OBSERVED first-run recall (not targets): they only catch regressions.
  // zoomed-out-cards misses lod.rs ("cards"/"zoomed out" never meet LodController's vocabulary) — kept as an honest miss.
  const v2Floor: Record<string, number> = {
    "held-out-v2-planted-token": 1,
    "held-out-v2-zoomed-out-cards": 0,
    "held-out-v2-share-preview": 1,
    "held-out-v2-concurrent-publish": 1,
  };
  for (const run of heldOutV2) assert.ok(run.after.recall >= (v2Floor[run.question.id] ?? 0), `${run.question.id}: ${run.after.recall}`);
});

test("renderer selection: every wording from every selected level has createRenderer.ts and WasmRendererAdapter.ts in evidence", () => {
  const family = runs.filter(run => run.question.family === "renderer-selection");
  const levels = new Set(family.map(run => run.question.selection.level));
  for (const level of ["L1 system", "container", "component", "code"]) assert.ok(levels.has(level), `renderer family covers ${level}`);
  assert.ok(new Set(family.map(run => run.question.question)).size >= 3, "several wordings");
  for (const run of family) {
    assert.deepEqual([...run.question.expectedFiles].sort(), ["apps/web/src/renderer/WasmRendererAdapter.ts", "apps/web/src/renderer/createRenderer.ts"]);
    assert.equal(run.after.recall, 1, `${run.question.id}: ${run.after.evidenceFiles.join(", ")}`);
  }
  // The selected-scope packets alone never reach the renderer files from these selections.
  assert.ok(family.every(run => run.before.recall < 1));
});

test("renderer selection: the createRenderer.ts excerpt is the createRenderer body (backend selection), not a sibling that merely mentions a term", () => {
  for (const run of runs.filter(run => run.question.family === "renderer-selection")) {
    const section = run.after.sections.find(candidate => candidate.path === "apps/web/src/renderer/createRenderer.ts");
    assert.ok(section?.excerpt, `${run.question.id}: createRenderer.ts section has an excerpt`);
    // Signature, the auto WebGPU -> WebGL2 attempt order, and the Canvas2D fallback at the end of the body.
    for (const line of [
      "export async function createRenderer(host: HTMLElement, requestedBackend: string, signal?: AbortSignal)",
      "const attempts = gpuPolicy.autoGpuAttemptOrder({",
      "return createCanvasFallback(host, requestedBackend, `GPU initialization failed (${detail}).`);",
    ]) assert.ok(section.excerpt.includes(line), `${run.question.id}: excerpt lacks ${line}`);
    assert.equal(section.symbols?.[0]?.name, "createRenderer", run.question.id);
  }
});

test("eval retrieval is deterministic", () => {
  const again = fixture.questions.map(question => runAskEvalQuestion(fixture, buildAskEvalIndex(fixture), question));
  assert.deepEqual(again.map(run => run.after.sections), runs.map(run => run.after.sections));
});

test("recorded live answers (replay.json): AFTER cites the expected files and never declines", t => {
  const replay = JSON.parse(readFileSync(join(ASK_EVAL_DIR, "replay.json"), "utf8")) as AskEvalReplay;
  assert.equal(replay.schema, "ask-eval-replay/v1");
  assert.equal(replay.corpusCommitSha, fixture.snapshot.commitSha);
  assert.ok(replay.totalCostUsd < 0.5, "recorded live spend stays inside the ticket cap");
  const rows: string[] = [];
  const rendererCited: number[] = [];
  for (const question of fixture.questions) {
    const recorded = replay.runs.find(run => run.id === question.id);
    assert.ok(recorded, `replay has ${question.id}`);
    const run = runs.find(candidate => candidate.question.id === question.id)!;
    // The recorded requests must be exactly what the current retrieval + prompts would send;
    // any drift (retrieval, prompt, packets) forces a re-record via askEvalLive.
    assert.equal(recorded.before.requestSha256, askRequestSha256(legacyAskChatCompletionsBody(replay.modelId, question.question, run.before.packets, run.before.relations)), `${question.id}: BEFORE request drifted; re-record replay.json`);
    assert.equal(recorded.after.requestSha256, askRequestSha256(afterAskChatCompletionsBody(replay.modelId, index, run)), `${question.id}: AFTER request drifted; re-record replay.json`);
    assert.deepEqual(recorded.after.allowedIds, run.after.allowedIds);
    const score = (call: AskEvalReplay["runs"][number]["before"], sections: typeof run.after.sections) => {
      const allowed = new Set(call.allowedIds);
      const parsed = parseAskCompletion(call.completion, allowed);
      assert.ok(parsed, `${question.id} parses`);
      // Same post-processing as answerAskQuestion: files the answer names are cited.
      const citations = citationsNamedInAnswer(parsed.answer, parsed.citations, sections);
      for (const id of citations) assert.ok(allowed.has(id));
      const files = citedFiles(citations, index, run.before.packets);
      return { recall: fileRecall(question.expectedFiles, files), files, declined: saysNotInEvidence(parsed.answer) };
    };
    const before = score(recorded.before, []);
    const after = score(recorded.after, run.after.sections);
    rows.push(`| ${question.id}${question.heldOutSet ? ` (held-out ${question.heldOutSet})` : question.heldOut ? " (held-out v1)" : ""} | ${before.recall.toFixed(2)} | ${before.declined ? "yes" : "no"} | ${after.recall.toFixed(2)} | ${after.declined ? "yes" : "no"} |`);
    assert.ok(after.recall >= before.recall, `${question.id}: cited recall regressed`);
    // Cited-recall floor wherever retrieval put an expected file in evidence (a held-out retrieval
    // miss — held-out-v2-zoomed-out-cards — cannot be cited and is reported, not hidden).
    if (run.after.recall > 0) assert.ok(after.recall >= 0.5, `${question.id}: cited recall ${after.recall}`);
    assert.equal(after.declined, false, `${question.id}: AFTER declined although the whole-atlas search found sections`);
    if (question.family === "renderer-selection") {
      // createRenderer.ts (where the choice is made) is cited by every renderer answer.
      assert.ok(after.files.includes("apps/web/src/renderer/createRenderer.ts"), `${question.id}: renderer answer cites createRenderer.ts`);
      // The ticket's question ("... choose what renderer to use?", typo and plain) cites BOTH files from every level.
      if (/\bchoose\b/i.test(question.question)) assert.equal(after.recall, 1, `${question.id}: cites createRenderer.ts and WasmRendererAdapter.ts`);
      rendererCited.push(after.recall);
    }
  }
  for (const row of ["| question | cited recall before | declined before | cited recall after | declined after |", ...rows]) t.diagnostic(row);
  // Evidence recall is 1 for every renderer variant (asserted above, deterministic). Whether a
  // fallback-chain wording ("when does it fall back from WebGPU to WebGL2 to Canvas2D") also NAMES
  // WasmRendererAdapter.ts is model behaviour: with createRenderer's body in evidence those answers
  // explain the chain from createRenderer/gpuLoss and cite WasmRendererAdapter in 2 of 7 recorded runs.
  const bothCited = rendererCited.filter(value => value === 1).length;
  t.diagnostic(`renderer family: both files cited in ${bothCited}/${rendererCited.length} recorded answers`);
});
