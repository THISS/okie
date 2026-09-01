import assert from "node:assert/strict";
import test from "node:test";
import type { Discovery } from "./discover.js";
import { extractArchitecture } from "./extract.js";
import { buildEnrichmentPackets, containerIdFromFileName, contentHash, packetFileName, ENRICHMENT_PROMPT_VERSION } from "./packet.js";

const files: Record<string, string> = {
  "README.md": "# Acme",
  "pkg/a/src/index.ts": "export function alpha() {}\nexport const A = 1;\nimport './util.js';\n",
  "pkg/a/src/util.ts": "export function helper() {}\n",
  "pkg/b/src/main.ts": "import { alpha } from '@acme/a';\nexport class Beta {}\n",
  "pkg/c/src/config.ts": "export default 1;\n",
};
const read = (path: string): string => {
  const text = files[path];
  if (text === undefined) throw new Error(`missing ${path}`);
  return text;
};
function base() {
  const discovery: Discovery = {
    sourceFiles: ["pkg/a/src/index.ts", "pkg/a/src/util.ts", "pkg/b/src/main.ts", "pkg/c/src/config.ts"],
    units: [
      { kind: "member", dir: "pkg/a", name: "@acme/a", packageName: "@acme/a", evidencePath: "pkg/a" },
      { kind: "member", dir: "pkg/b", name: "@acme/b", packageName: "@acme/b", evidencePath: "pkg/b" },
      { kind: "member", dir: "pkg/c", name: "@acme/c", packageName: "@acme/c", evidencePath: "pkg/c" },
    ],
    unitByFile: new Map([
      ["pkg/a/src/index.ts", "pkg/a"], ["pkg/a/src/util.ts", "pkg/a"],
      ["pkg/b/src/main.ts", "pkg/b"], ["pkg/c/src/config.ts", "pkg/c"],
    ]),
    unitByPackageName: new Map([["@acme/a", "pkg/a"], ["@acme/b", "pkg/b"], ["@acme/c", "pkg/c"]]),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
  return extractArchitecture({ discovery, readFile: read, systemName: "Acme", systemSlug: "acme" });
}

test("emits one packet per code-bearing container, strictly redacted to scope", () => {
  const { packets } = buildEnrichmentPackets(base(), read);
  // pkg/c has only an empty component (export default) -> no packet.
  assert.deepEqual(packets.map(packet => packet.containerId).sort(), ["container:pkg-a", "container:pkg-b"]);

  const a = packets.find(packet => packet.containerId === "container:pkg-a")!;
  assert.equal(a.promptVersion, ENRICHMENT_PROMPT_VERSION);
  assert.ok(a.scopePaths.every(path => path.startsWith("pkg/a/")), "scope paths in-scope only");
  assert.ok(a.excerpts.every(excerpt => a.scopePaths.includes(excerpt.path)), "excerpts in-scope only");
  assert.ok(a.code.every(code => code.path.startsWith("pkg/a/")), "code in-scope only");
  // hard redaction: not a single byte references pkg/b or pkg/c.
  const serialized = JSON.stringify(a);
  assert.equal(serialized.includes("pkg/b/"), false);
  assert.equal(serialized.includes("pkg/c/"), false);
  // every code entity names the component it currently belongs to (for re-parenting).
  assert.ok(a.code.every(code => a.components.some(component => component.id === code.componentId)));
});

test("packet excerpts apply the existing GitHub token scrub (planted secret stays off the wire)", () => {
  const planted = "gho_okieTestPlantedSecretCla25xxxx";
  const withSecret: Record<string, string> = {
    ...files,
    "pkg/a/src/index.ts": `export function alpha() {}\nconst planted = "${planted}";\n`,
    "README.md": `# Acme\ntoken ${planted}\n`,
  };
  const readSecret = (path: string): string => {
    const text = withSecret[path];
    if (text === undefined) throw new Error(`missing ${path}`);
    return text;
  };
  const extraction = extractArchitecture({
    discovery: {
      sourceFiles: ["pkg/a/src/index.ts", "pkg/a/src/util.ts", "pkg/b/src/main.ts", "pkg/c/src/config.ts"],
      units: [
        { kind: "member", dir: "pkg/a", name: "@acme/a", packageName: "@acme/a", evidencePath: "pkg/a" },
        { kind: "member", dir: "pkg/b", name: "@acme/b", packageName: "@acme/b", evidencePath: "pkg/b" },
        { kind: "member", dir: "pkg/c", name: "@acme/c", packageName: "@acme/c", evidencePath: "pkg/c" },
      ],
      unitByFile: new Map([
        ["pkg/a/src/index.ts", "pkg/a"], ["pkg/a/src/util.ts", "pkg/a"],
        ["pkg/b/src/main.ts", "pkg/b"], ["pkg/c/src/config.ts", "pkg/c"],
      ]),
      unitByPackageName: new Map([["@acme/a", "pkg/a"], ["@acme/b", "pkg/b"], ["@acme/c", "pkg/c"]]),
      summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
    },
    readFile: readSecret,
    systemName: "Acme",
    systemSlug: "acme",
  });
  const emitted = buildEnrichmentPackets(extraction, readSecret);
  const a = emitted.packets.find(packet => packet.containerId === "container:pkg-a")!;
  const packetJson = JSON.stringify(a);
  const systemJson = JSON.stringify(emitted.systemPacket);
  assert.equal(packetJson.includes(planted), false);
  assert.equal(systemJson.includes(planted), false);
  assert.ok(a.excerpts.some(excerpt => excerpt.lines.some(line => line.includes("[redacted-token]"))));
  assert.ok(emitted.systemPacket?.readme.some(excerpt => excerpt.lines.some(line => line.includes("[redacted-token]"))));
  // scope redaction still holds
  assert.equal(packetJson.includes("pkg/b/"), false);
});

test("manifest is content-addressed and deterministic; file names round-trip", () => {
  const first = buildEnrichmentPackets(base(), read).manifest;
  const second = buildEnrichmentPackets(base(), read).manifest;
  assert.deepEqual(first, second, "manifest is deterministic");
  assert.equal(first.promptVersion, ENRICHMENT_PROMPT_VERSION);
  for (const entry of first.packets) {
    assert.match(entry.hash, /^[0-9a-f]{8}$/);
    assert.equal(entry.file, packetFileName(entry.containerId));
    assert.equal(containerIdFromFileName(entry.file), entry.containerId, "file name reverses to the container id");
  }
  // a changed packet must change its hash.
  assert.notEqual(contentHash("a"), contentHash("b"));
  assert.equal(contentHash("stable"), contentHash("stable"));
});
