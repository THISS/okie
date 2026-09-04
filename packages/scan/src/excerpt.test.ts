import assert from "node:assert/strict";
import test from "node:test";
import { SOURCE_EXCERPT_LIMITS, validateSnapshot } from "@okie/architecture";
import type { Discovery } from "./discover.js";
import { attachPortableSourceExcerpts, languageForScanPath, portableSourceExcerpt } from "./excerpt.js";
import { extractArchitecture } from "./extract.js";
import { buildScanArtifacts } from "./scan.js";

const pin = {
  commitSha: "abc123def456abc123def456abc123def456abc1",
  treeHash: "def456abc123def456abc123def456abc123def4",
  generatedAt: "2026-01-01T00:00:00.000Z",
};

const files: Record<string, string> = {
  "README.md": "# Acme",
  "pkg/a/src/index.ts": [
    "export function alpha() {",
    "  return 1;",
    "}",
    "export const A = 1;",
  ].join("\n") + "\n",
  "pkg/a/src/long.ts": [
    "export function longFn() {",
    ...Array.from({ length: 20 }, (_, index) => `  const n${index} = ${index};`),
    "  return n0;",
    "}",
  ].join("\n") + "\n",
  "pkg/a/src/wide.ts": [
    `export function wideFn(${"x".repeat(SOURCE_EXCERPT_LIMITS.maxLineCharacters)}: string) {`,
    "  return 1;",
    "  return 2;",
    "}",
  ].join("\n") + "\n",
};

function discovery(): Discovery {
  return {
    sourceFiles: ["pkg/a/src/index.ts", "pkg/a/src/long.ts", "pkg/a/src/wide.ts"],
    units: [{ kind: "member", dir: "pkg/a", name: "@acme/a", packageName: "@acme/a", evidencePath: "pkg/a" }],
    unitByFile: new Map([
      ["pkg/a/src/index.ts", "pkg/a"],
      ["pkg/a/src/long.ts", "pkg/a"],
      ["pkg/a/src/wide.ts", "pkg/a"],
    ]),
    unitByPackageName: new Map([["@acme/a", "pkg/a"]]),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
}

const read = (path: string): string => {
  const text = files[path];
  if (text === undefined) throw new Error(`missing ${path}`);
  return text;
};

test("languageForScanPath matches snapshot excerpt validation", () => {
  assert.equal(languageForScanPath("apps/web/src/App.tsx"), "tsx");
  assert.equal(languageForScanPath("packages/scan/src/excerpt.ts"), "typescript");
  assert.equal(languageForScanPath("scripts/build-wasm.mjs"), "javascript");
  assert.equal(languageForScanPath("crates/atlas-engine/src/lod.rs"), "rust");
  assert.equal(languageForScanPath("d.jsx"), undefined);
  assert.equal(languageForScanPath("README.md"), undefined);
});

test("portableSourceExcerpt clamps to architecture limits and scrubs GitHub tokens", () => {
  const planted = "gho_okieTestPlantedSecretCla54xxxx";
  const short = portableSourceExcerpt({
    path: "pkg/a/src/index.ts",
    symbol: "alpha",
    startLine: 1,
    endLine: 3,
    frozenRevision: pin.commitSha,
    fileText: files["pkg/a/src/index.ts"]!,
  });
  assert.ok(short);
  assert.equal(short.startLine, 1);
  assert.equal(short.endLine, 3);
  assert.equal(short.highlightLine, 1);
  assert.equal(short.language, "typescript");
  assert.equal(short.frozenRevision, pin.commitSha);
  assert.ok(short.text.includes("export function alpha()"));
  assert.equal(short.text, short.lines.join("\n"));

  const long = portableSourceExcerpt({
    path: "pkg/a/src/long.ts",
    symbol: "longFn",
    startLine: 1,
    endLine: 23,
    frozenRevision: pin.commitSha,
    fileText: files["pkg/a/src/long.ts"]!,
  });
  assert.ok(long);
  assert.equal(long.lines.length, SOURCE_EXCERPT_LIMITS.maxLines);
  assert.equal(long.endLine, SOURCE_EXCERPT_LIMITS.maxLines);
  assert.ok(long.text.startsWith("export function longFn()"));

  const redacted = portableSourceExcerpt({
    path: "pkg/a/src/index.ts",
    symbol: "alpha",
    startLine: 1,
    endLine: 1,
    frozenRevision: pin.commitSha,
    fileText: `export function alpha() { return "${planted}"; }\n`,
  });
  assert.ok(redacted);
  assert.equal(redacted.text.includes(planted), false);
  assert.ok(redacted.text.includes("[redacted-token]"));
});

test("portableSourceExcerpt skips an overlong first line without raising bounds", () => {
  assert.equal(SOURCE_EXCERPT_LIMITS.maxLines, 12);
  assert.equal(SOURCE_EXCERPT_LIMITS.maxLineCharacters, 512);

  const skipped = portableSourceExcerpt({
    path: "pkg/a/src/wide.ts",
    symbol: "wideFn",
    startLine: 1,
    endLine: 4,
    frozenRevision: pin.commitSha,
    fileText: files["pkg/a/src/wide.ts"]!,
  });
  assert.ok(skipped);
  assert.equal(skipped.startLine, 2);
  assert.equal(skipped.endLine, 4);
  assert.equal(skipped.highlightLine, 2);
  assert.equal(skipped.lines[0], "  return 1;");
  assert.ok(!skipped.text.includes("export function wideFn"));
  assert.ok(skipped.lines.length <= SOURCE_EXCERPT_LIMITS.maxLines);
  assert.ok(skipped.lines.every(line => [...line].length <= SOURCE_EXCERPT_LIMITS.maxLineCharacters));

  const exactLimit = "x".repeat(SOURCE_EXCERPT_LIMITS.maxLineCharacters);
  const atLimit = portableSourceExcerpt({
    path: "pkg/a/src/index.ts",
    startLine: 1,
    endLine: 1,
    frozenRevision: pin.commitSha,
    fileText: `${exactLimit}\n`,
  });
  assert.ok(atLimit);
  assert.equal(atLimit.startLine, 1);
  assert.equal(atLimit.lines[0], exactLimit);

  const onlyOverlong = portableSourceExcerpt({
    path: "pkg/a/src/index.ts",
    startLine: 1,
    endLine: 1,
    frozenRevision: pin.commitSha,
    fileText: `${"x".repeat(SOURCE_EXCERPT_LIMITS.maxLineCharacters + 1)}\n`,
  });
  assert.equal(onlyOverlong, undefined);

  const planted = `gho_${"A".repeat(600)}`;
  const scrubbedFits = portableSourceExcerpt({
    path: "pkg/a/src/index.ts",
    symbol: "alpha",
    startLine: 1,
    endLine: 1,
    frozenRevision: pin.commitSha,
    fileText: `export function alpha() { return "${planted}"; }\n`,
  });
  assert.ok(scrubbedFits);
  assert.equal(scrubbedFits.startLine, 1);
  assert.equal(scrubbedFits.text.includes(planted), false);
});

test("scan snapshot attaches portable excerpts to code entities and never to containers", () => {
  const artifacts = buildScanArtifacts({
    discovery: discovery(),
    pin,
    readFile: read,
    repositorySlug: "acme",
    systemName: "Acme",
  });
  assert.deepEqual(validateSnapshot(artifacts.snapshot), []);

  const alpha = artifacts.snapshot.entities.find(entity => entity.name === "alpha")!;
  const longFn = artifacts.snapshot.entities.find(entity => entity.name === "longFn")!;
  const wideFn = artifacts.snapshot.entities.find(entity => entity.name === "wideFn")!;
  const container = artifacts.snapshot.entities.find(entity => entity.kind === "container")!;
  const component = artifacts.snapshot.entities.find(entity => entity.kind === "component" && entity.name === "src/index.ts")!;

  assert.equal(alpha.kind, "code");
  assert.equal(alpha.sourceExcerpts?.length, 1);
  assert.ok(alpha.sourceExcerpts![0]!.text.includes("export function alpha()"));
  assert.equal(alpha.sourceRefs[0]!.startLine, alpha.sourceExcerpts![0]!.startLine);
  assert.equal(alpha.sourceRefs[0]!.endLine, alpha.sourceExcerpts![0]!.endLine);

  assert.equal(longFn.sourceExcerpts?.length, 1);
  assert.equal(longFn.sourceExcerpts![0]!.lines.length, SOURCE_EXCERPT_LIMITS.maxLines);
  assert.equal(longFn.sourceRefs[0]!.endLine, longFn.sourceExcerpts![0]!.endLine);

  assert.equal(wideFn.sourceExcerpts?.length, 1);
  assert.equal(wideFn.sourceExcerpts![0]!.startLine, 2);
  assert.equal(wideFn.sourceRefs[0]!.startLine, 2);
  assert.ok(wideFn.sourceExcerpts![0]!.lines.every(line => [...line].length <= SOURCE_EXCERPT_LIMITS.maxLineCharacters));

  assert.equal(container.sourceExcerpts, undefined);
  assert.equal(component.sourceExcerpts, undefined);
  assert.ok(artifacts.snapshot.entities.filter(entity => entity.kind === "code")
    .every(entity => (entity.sourceExcerpts?.length ?? 0) === 1));
});

test("extraction documents stay excerpt-free after the host attaches snapshot excerpts", () => {
  const extraction = extractArchitecture({
    discovery: discovery(),
    readFile: read,
    systemName: "Acme",
    systemSlug: "acme",
  });
  assert.ok(extraction.entities.every(entity => !("sourceExcerpts" in entity)));
  const artifacts = buildScanArtifacts({
    discovery: discovery(),
    pin,
    readFile: read,
    repositorySlug: "acme",
    systemName: "Acme",
  });
  assert.ok(artifacts.extraction.entities.every(entity => !("sourceExcerpts" in entity)));
  const attached = attachPortableSourceExcerpts(artifacts.snapshot, read);
  assert.equal(attached.entities.find(entity => entity.name === "alpha")?.sourceExcerpts?.length, 1);
});
