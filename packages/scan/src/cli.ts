#!/usr/bin/env node
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildEnrichmentPackets, containerIdFromFileName, packetFileName } from "./packet.js";
import { GithubAcquisitionError, isGithubSource, parseGithubSource, type GithubSourceRef } from "./github.js";
import { regenerateScanManifest } from "./manifest.js";
import { scanGithubRepository, scanRepository, stableJson, type ScanArtifacts, type ScanOptions } from "./scan.js";

interface CliArgs {
  source: string;
  github?: GithubSourceRef;
  out: string;
  /** Parent scan directory whose per-repo slots the manifest indexes (gh mode). */
  scanRoot?: string;
  options: ScanOptions;
  emitPacketsDir?: string;
  enrichFromDir?: string;
  maxTarballBytes?: number;
}

function printUsage(): void {
  process.stdout.write([
    "okie-scan — deterministic repository scan (R1 local + R3 GitHub) + enrichment machinery (R2a)",
    "",
    "Usage: okie-scan [--source <path | gh:owner/repo[@ref]>] [--out <dir>]",
    "                 [--system-name <name>] [--repo <slug>] [--max-tarball-mb <n>]",
    "                 [--emit-packets <dir>] [--enrich-from <dir>] [--include-members]",
    "",
    "  --source <src>      local git working tree, or gh:owner/repo[@ref] (default: cwd)",
    "  --out <dir>         output directory (default: <source>/fixtures/scan for a local",
    "                      scan; fixtures/scan/<owner>__<repo> for a gh: source)",
    "  --system-name       display name for the software system (default: derived)",
    "  --repo <slug>       repository slug for snapshot/repo IDs (default: derived)",
    "  --max-tarball-mb    cap on a gh: tarball download (default: 150)",
    "  --emit-packets <d>  (local only) write bounded, redacted enrichment packets to <d>",
    "  --enrich-from <d>   read enrichment docs (<containerId>.json) from <d>, merge accepted",
    "  --include-members   scan fixture/example/playground/e2e workspace members too",
    "  --public-api        L4 code entities cover only the export surface (hosted posture)",
    "",
  ].join("\n"));
}

function parseArgs(argv: readonly string[]): CliArgs {
  let source = process.cwd();
  let out = "";
  let emitPacketsDir: string | undefined;
  let enrichFromDir: string | undefined;
  let maxTarballBytes: number | undefined;
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
      case "--max-tarball-mb": {
        const mb = Number.parseFloat(next());
        if (!Number.isFinite(mb) || mb <= 0) throw new Error("--max-tarball-mb must be a positive number");
        maxTarballBytes = Math.round(mb * 1024 * 1024);
        break;
      }
      case "--emit-packets": emitPacketsDir = next(); break;
      case "--enrich-from": enrichFromDir = next(); break;
      case "--include-members": options.includeAllMembers = true; break;
      case "--public-api": options.codeSurface = "public"; break;
      case "--help": case "-h": printUsage(); process.exit(0); break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (isGithubSource(source)) {
    const github = parseGithubSource(source);
    if (!github) throw new Error(`Invalid gh source “${source}” — expected gh:owner/repo[@ref]`);
    const resolvedOut = out ? resolve(out) : resolve(process.cwd(), "fixtures/scan", github.dirSlug);
    return {
      source,
      github,
      out: resolvedOut,
      scanRoot: dirname(resolvedOut),
      options,
      ...(enrichFromDir ? { enrichFromDir: resolve(enrichFromDir) } : {}),
      ...(emitPacketsDir ? { emitPacketsDir: resolve(emitPacketsDir) } : {}),
      ...(maxTarballBytes ? { maxTarballBytes } : {}),
    };
  }

  const resolvedSource = resolve(source);
  return {
    source: resolvedSource,
    out: out ? resolve(out) : resolve(resolvedSource, "fixtures/scan"),
    options,
    ...(emitPacketsDir ? { emitPacketsDir: resolve(emitPacketsDir) } : {}),
    ...(enrichFromDir ? { enrichFromDir: resolve(enrichFromDir) } : {}),
    ...(maxTarballBytes ? { maxTarballBytes } : {}),
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

/** Writes the six-artifact trio (+ enrichment report) to an output directory. */
function writeArtifacts(out: string, artifacts: ScanArtifacts): void {
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/extraction.json`, stableJson(artifacts.extraction));
  writeFileSync(`${out}/snapshot.json`, stableJson(artifacts.snapshot));
  writeFileSync(`${out}/view.json`, stableJson(artifacts.view));
  writeFileSync(`${out}/story.json`, stableJson(artifacts.story));
  writeFileSync(`${out}/scene.json`, stableJson(artifacts.scene));
  writeFileSync(`${out}/timeline.json`, stableJson(artifacts.timeline));
  if (artifacts.enrichmentReport) {
    writeFileSync(`${out}/enrichment-report.json`, stableJson(artifacts.enrichmentReport));
  }
}

function summaryLines(artifacts: ScanArtifacts): string {
  const { snapshot, pin, enrichmentReport, discoverySummary } = artifacts;
  const enrichedNote = enrichmentReport
    ? `  enriched ${enrichmentReport.enrichedContainers.length}/${enrichmentReport.results.length} containers (see enrichment-report.json)\n`
    : "";
  const systemScopeNote = enrichmentReport?.systemScope
    ? (enrichmentReport.systemScope.accepted
      ? `  system-scope: added ${enrichmentReport.systemScope.persons} actor(s) + ${enrichmentReport.systemScope.relations} relation(s)\n`
      : `  system-scope: rejected (${enrichmentReport.systemScope.reasons.length} reason(s), see enrichment-report.json)\n`)
    : "";
  // Never hide what was left out — surface the redaction/omission decisions.
  const modeNote = discoverySummary.singlePackage ? "  single-package repo (no workspace) -> one root container\n" : "";
  const jsNote = discoverySummary.skippedJsFiles > 0
    ? `  skipped ${discoverySummary.skippedJsFiles} .js file(s) (TypeScript repo; use a pure-JS repo to include them)\n`
    : "";
  const membersNote = discoverySummary.skippedMembers.length > 0
    ? `  skipped ${discoverySummary.skippedMembers.length} fixture/example member(s): ${discoverySummary.skippedMembers.slice(0, 5).join(", ")}${discoverySummary.skippedMembers.length > 5 ? " ..." : ""} (--include-members to scan)\n`
    : "";
  return `okie-scan: ${snapshot.entities.length} entities, ${snapshot.relations.length} relations\n` +
    `  commit ${pin.commitSha}\n  tree   ${pin.treeHash}\n` +
    modeNote + jsNote + membersNote + enrichedNote + systemScopeNote;
}

/** Rewrites <scanRoot>/index.json to index every per-repo scan slot deterministically. */
function refreshManifest(scanRoot: string): number {
  const manifest = regenerateScanManifest(scanRoot);
  mkdirSync(scanRoot, { recursive: true });
  writeFileSync(`${scanRoot}/index.json`, stableJson(manifest));
  return manifest.repos.length;
}

async function runGithubScan(args: CliArgs): Promise<void> {
  const github = args.github!;
  if (args.emitPacketsDir) {
    process.stderr.write("okie-scan: --emit-packets is local-only (needs the working tree); skipping for gh source.\n");
  }
  const scanOptions = {
    ...args.options,
    ...(args.enrichFromDir ? { enrichmentDocs: readEnrichmentDocs(args.enrichFromDir) } : {}),
    ...(args.maxTarballBytes ? { maxTarballBytes: args.maxTarballBytes } : {}),
  };
  const { artifacts, commitSha } = await scanGithubRepository(github, scanOptions);
  writeArtifacts(args.out, artifacts);
  const manifestCount = args.scanRoot ? refreshManifest(args.scanRoot) : 0;
  process.stdout.write(
    summaryLines(artifacts) +
    `  source gh:${github.owner}/${github.repo}${github.ref ? `@${github.ref}` : ""} -> ${commitSha.slice(0, 12)}\n` +
    `  wrote snapshot/view/story/scene/timeline to ${args.out}\n` +
    `  manifest: ${manifestCount} repo(s) indexed in ${args.scanRoot}/index.json\n` +
    `  load in the app with ?fixture=scan:${github.dirSlug}\n`,
  );
}

function runLocalScan(args: CliArgs): void {
  const scanOptions: ScanOptions = { ...args.options };
  if (args.enrichFromDir) scanOptions.enrichmentDocs = readEnrichmentDocs(args.enrichFromDir);

  const artifacts = scanRepository(args.source, scanOptions);
  writeArtifacts(args.out, artifacts);

  if (args.emitPacketsDir) {
    const readFile = (repoRelativePath: string): string => readFileSync(`${args.source}/${repoRelativePath}`, "utf8");
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

  const packetNote = args.emitPacketsDir ? `  wrote enrichment packets to ${args.emitPacketsDir}\n` : "";
  process.stdout.write(summaryLines(artifacts) + packetNote + `  wrote snapshot/view/story/scene/timeline to ${args.out}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.github) await runGithubScan(args);
  else runLocalScan(args);
}

main().catch((error: unknown) => {
  if (error instanceof GithubAcquisitionError) {
    process.stderr.write(`okie-scan: ${error.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`okie-scan: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
