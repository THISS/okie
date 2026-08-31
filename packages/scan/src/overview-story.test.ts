import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateStory } from "@okie/architecture";
import type { Discovery } from "./discover.js";
import { buildOverviewStory } from "./overview-story.js";
import { buildScanArtifacts, scanRepository, stableJson } from "./scan.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const files: Record<string, string> = {
  "README.md": "# Acme",
  "pkg/a/src/index.ts": "export function alpha() {}\nexport const A = 1;\nimport './util.js';\n",
  "pkg/a/src/util.ts": "export function helper() {}\n",
  "pkg/b/src/main.ts": "import { alpha } from '@acme/a';\nexport class Beta {}\n",
};
const read = (path: string): string => {
  const text = files[path];
  if (text === undefined) throw new Error(`missing ${path}`);
  return text;
};

function discovery(): Discovery {
  return {
    sourceFiles: ["pkg/a/src/index.ts", "pkg/a/src/util.ts", "pkg/b/src/main.ts"],
    units: [
      { kind: "member", dir: "pkg/a", name: "@acme/a", packageName: "@acme/a", evidencePath: "pkg/a" },
      { kind: "member", dir: "pkg/b", name: "@acme/b", packageName: "@acme/b", evidencePath: "pkg/b" },
    ],
    unitByFile: new Map([
      ["pkg/a/src/index.ts", "pkg/a"], ["pkg/a/src/util.ts", "pkg/a"],
      ["pkg/b/src/main.ts", "pkg/b"],
    ]),
    unitByPackageName: new Map([["@acme/a", "pkg/a"], ["@acme/b", "pkg/b"]]),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
}

const pin = {
  commitSha: "abc123def456abc123def456abc123def456abc1",
  treeHash: "def456abc123def456abc123def456abc123def4",
  generatedAt: "2026-01-01T00:00:00.000Z",
};

test("synthetic scan overview is a multi-step C4 tour, not a commit restatement", () => {
  const artifacts = buildScanArtifacts({
    discovery: discovery(),
    pin,
    readFile: read,
    repositorySlug: "acme",
    systemName: "Acme",
  });
  const { story, snapshot, view, timeline } = artifacts;

  assert.equal(story.id, "story:acme:overview");
  assert.ok(story.steps.length > 1, `expected a tour, got ${story.steps.length} step(s)`);
  assert.deepEqual(validateStory(snapshot, view, story), []);

  const reveals = story.steps.map(step => step.reveal);
  assert.ok(reveals.includes("context"), "tour includes system context");
  assert.ok(reveals.includes("container"), "tour includes containers");
  assert.ok(reveals.includes("component"), "tour includes a component");
  assert.ok(reveals.includes("code"), "tour includes a code declaration");

  for (const step of story.steps) {
    assert.match(step.narration, /\S/u);
    assert.equal(/scanned at commit/i.test(step.narration), false, `${step.id} restates the scan commit`);
    assert.ok(step.focusEntityIds.length >= 1);
    assert.notEqual(step.id, "step:overview");
  }

  const focusKeys = new Set(story.steps.map(step => step.focusEntityIds.slice().sort().join(",")));
  assert.ok(focusKeys.size > 1, "steps must focus different entities, not repeat one commit beat");

  assert.ok(timeline.keyframes.length >= 4, "compiled timeline has arrival+hold per visible step");
  assert.equal(timeline.keyframes.length % 2, 0);
});

test("Okie self-scan overview is a real atlas tour", () => {
  const { story, snapshot, view, timeline } = scanRepository(repoRoot, {
    systemName: "Okie",
    repositorySlug: "thiss-okie",
  });

  assert.equal(story.id, "story:thiss-okie:overview");
  assert.ok(story.steps.length > 1, `expected a tour, got ${story.steps.length} step(s)`);
  assert.deepEqual(validateStory(snapshot, view, story), [], "overview story must stay valid");

  const reveals = new Set(story.steps.map(step => step.reveal));
  for (const band of ["context", "container", "component", "code"] as const) {
    assert.ok(reveals.has(band), `Okie overview is missing a ${band} step`);
  }

  assert.equal(story.steps.some(step => /scanned at commit/i.test(step.narration)), false);
  assert.ok(story.steps[0]!.title.startsWith("Start with "));
  assert.ok(story.steps.some(step => step.focusEntityIds.some(id => snapshot.entities.find(entity => entity.id === id)?.kind === "container")));

  const cited = story.steps.flatMap(step => step.sourceRefs ?? []);
  assert.ok(cited.length > 0, "tour cites snapshot evidence");
  assert.ok(cited.every(ref => ref.commitSha === snapshot.commitSha));

  assert.ok(timeline.keyframes.length >= 2 * Math.min(2, story.steps.length));
});

test("overview story is byte-identical across reversed discovery order", () => {
  const forward = buildScanArtifacts({
    discovery: discovery(),
    pin,
    readFile: read,
    repositorySlug: "acme",
    systemName: "Acme",
  });
  const reversedDiscovery: Discovery = {
    ...discovery(),
    sourceFiles: [...discovery().sourceFiles].reverse(),
    units: [...discovery().units].reverse(),
  };
  const reversed = buildScanArtifacts({
    discovery: reversedDiscovery,
    pin,
    readFile: read,
    repositorySlug: "acme",
    systemName: "Acme",
  });
  assert.equal(stableJson(forward.story), stableJson(reversed.story));
  assert.equal(
    stableJson(buildOverviewStory(forward.snapshot, forward.view, "system:acme", "acme", "Acme")),
    stableJson(forward.story),
  );
});
