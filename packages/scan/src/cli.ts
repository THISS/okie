#!/usr/bin/env node
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildEnrichmentPackets, containerIdFromFileName, packetFileName } from "./packet.js";
import { scanRepository, stableJson, type ScanOptions } from "./scan.js";

interface CliArgs {
  source: string;
  out: string;
  options: ScanOptions;
  emitPacketsDir?: string;
  enrichFromDir?: string;
}

function printUsage(): void {
  process.stdout.write([
    "okie-scan — deterministic local-path repository scan (R1) + enrichment machinery (R2a)",
    "",
    "Usage: okie-scan [--source <path>] [--out <dir>] [--system-name <name>] [--repo <slug>]",
    "                 [--emit-packets <dir>] [--enrich-from <dir>]",
    "",
    "  --source <path>     git working tree to scan (default: cwd)",
    "  --out <dir>         output directory (default: <source>/fixtures/scan)",
    "  --system-name       display name for the software system (default: derived from dir)",
    "  --repo <slug>       repository slug for snapshot/repo IDs (default: derived from dir)",
    "  --emit-packets <d>  write one bounded, redacted enrichment packet per code-bearing",
    "                      container (plus manifest.json) to <d>",
    "  --enrich-from <d>   read enrichment docs (<containerId>.json) from <d>, merge accepted",
    "                      proposals, and emit an enrichment-report.json",
    "  --include-members   scan fixture/example/playground/e2e workspace members too",
    "",
  ].join("\n"));
}

function parseArgs(argv: readonly string[]): CliArgs {
  let source = process.cwd();
  let out = "";
  let emitPacketsDir: string | undefined;
  let enrichFromDir: string | undefined;
  const options: ScanOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--source": source = next(); break;
      case "--out": out = next(); break;
      case "--system-name": options.systemName = next(); break;
      case "--repo": options.repositorySlug = next(); break;
      case "--emit-packets": emitPacketsDir = next(); break;
      case "--enrich-from": enrichFromDir = next(); break;
      case "--include-members": options.includeAllMembers = true; break;
      case "--help": case "-h": printUsage(); process.exit(0); break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  const resolvedSource = resolve(source);
  return {
    source: resolvedSource,
    out: out ? resolve(out) : resolve(resolvedSource, "fixtures/scan"),
    options,
    ...(emitPacketsDir ? { emitPacketsDir: resolve(emitPacketsDir) } : {}),
    ...(enrichFromDir ? { enrichFromDir: resolve(enrichFromDir) } : {}),
  };
}

/** Reads <containerId>.json enrichment docs into a container-keyed map (parse errors kept as-is → rejected). */
function readEnrichmentDocs(dir: string): Map<string, unknown> {
  const docs = new Map<string, unknown>();
  for (const file of readdirSync(dir).sort()) {
    const containerId = containerIdFromFileName(file);
    if (!containerId || file === "manifest.json") continue;
    const text = readFileSync(`${dir}/${file}`, "utf8");
    let value: unknown;
    try { value = JSON.parse(text); } catch { value = text; }
    docs.set(containerId, value);
  }
  return docs;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const readFile = (repoRelativePath: string): string => readFileSync(`${args.source}/${repoRelativePath}`, "utf8");

  const scanOptions: ScanOptions = { ...args.options };
  if (args.enrichFromDir) scanOptions.enrichmentDocs = readEnrichmentDocs(args.enrichFromDir);

  const artifacts = scanRepository(args.source, scanOptions);
  mkdirSync(args.out, { recursive: true });
  writeFileSync(`${args.out}/extraction.json`, stableJson(artifacts.extraction));
  writeFileSync(`${args.out}/snapshot.json`, stableJson(artifacts.snapshot));
  writeFileSync(`${args.out}/view.json`, stableJson(artifacts.view));
  writeFileSync(`${args.out}/story.json`, stableJson(artifacts.story));
  writeFileSync(`${args.out}/scene.json`, stableJson(artifacts.scene));
  writeFileSync(`${args.out}/timeline.json`, stableJson(artifacts.timeline));
  if (artifacts.enrichmentReport) {
    writeFileSync(`${args.out}/enrichment-report.json`, stableJson(artifacts.enrichmentReport));
  }

  if (args.emitPacketsDir) {
    const { packets, systemPacket, manifest } = buildEnrichmentPackets(artifacts.baseExtraction, readFile);
    mkdirSync(args.emitPacketsDir, { recursive: true });
    for (const packet of packets) {
      writeFileSync(`${args.emitPacketsDir}/${packetFileName(packet.containerId)}`, stableJson(packet));
    }
    if (systemPacket) {
      writeFileSync(`${args.emitPacketsDir}/${packetFileName(systemPacket.systemId)}`, stableJson(systemPacket));
    }
    writeFileSync(`${args.emitPacketsDir}/manifest.json`, stableJson(manifest));
  }

  const { snapshot, pin, enrichmentReport, discoverySummary } = artifacts;
  const enrichedNote = enrichmentReport
    ? `  enriched ${enrichmentReport.enrichedContainers.length}/${enrichmentReport.results.length} containers (see enrichment-report.json)\n`
    : "";
  const systemScopeNote = enrichmentReport?.systemScope
    ? (enrichmentReport.systemScope.accepted
      ? `  system-scope: added ${enrichmentReport.systemScope.persons} actor(s) + ${enrichmentReport.systemScope.relations} relation(s)\n`
      : `  system-scope: rejected (${enrichmentReport.systemScope.reasons.length} reason(s), see enrichment-report.json)\n`)
    : "";
  const packetNote = args.emitPacketsDir ? `  wrote enrichment packets to ${args.emitPacketsDir}\n` : "";
  // Never hide what was left out — surface the redaction/omission decisions.
  const modeNote = discoverySummary.singlePackage ? "  single-package repo (no workspace) -> one root container\n" : "";
  const jsNote = discoverySummary.skippedJsFiles > 0
    ? `  skipped ${discoverySummary.skippedJsFiles} .js file(s) (TypeScript repo; use a pure-JS repo to include them)\n`
    : "";
  const membersNote = discoverySummary.skippedMembers.length > 0
    ? `  skipped ${discoverySummary.skippedMembers.length} fixture/example member(s): ${discoverySummary.skippedMembers.slice(0, 5).join(", ")}${discoverySummary.skippedMembers.length > 5 ? " ..." : ""} (--include-members to scan)\n`
    : "";
  process.stdout.write(
    `okie-scan: ${snapshot.entities.length} entities, ${snapshot.relations.length} relations\n` +
    `  commit ${pin.commitSha}\n  tree   ${pin.treeHash}\n` +
    modeNote + jsNote + membersNote + enrichedNote + systemScopeNote + packetNote +
    `  wrote snapshot/view/story/scene/timeline to ${args.out}\n`,
  );
}

main();
