#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { scanRepository, stableJson, type ScanOptions } from "./scan.js";

interface CliArgs {
  source: string;
  out: string;
  options: ScanOptions;
}

function printUsage(): void {
  process.stdout.write([
    "okie-scan — deterministic local-path repository scan (R1)",
    "",
    "Usage: okie-scan [--source <path>] [--out <dir>] [--system-name <name>] [--repo <slug>]",
    "",
    "  --source <path>   git working tree to scan (default: cwd)",
    "  --out <dir>       output directory (default: <source>/fixtures/scan)",
    "  --system-name     display name for the software system (default: derived from dir)",
    "  --repo <slug>     repository slug for snapshot/repo IDs (default: derived from dir)",
    "",
  ].join("\n"));
}

function parseArgs(argv: readonly string[]): CliArgs {
  let source = process.cwd();
  let out = "";
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
      case "--help": case "-h": printUsage(); process.exit(0); break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  const resolvedSource = resolve(source);
  return { source: resolvedSource, out: out ? resolve(out) : resolve(resolvedSource, "fixtures/scan"), options };
}

function main(): void {
  const { source, out, options } = parseArgs(process.argv.slice(2));
  const artifacts = scanRepository(source, options);
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/extraction.json`, stableJson(artifacts.extraction));
  writeFileSync(`${out}/snapshot.json`, stableJson(artifacts.snapshot));
  writeFileSync(`${out}/view.json`, stableJson(artifacts.view));
  writeFileSync(`${out}/story.json`, stableJson(artifacts.story));
  writeFileSync(`${out}/scene.json`, stableJson(artifacts.scene));
  writeFileSync(`${out}/timeline.json`, stableJson(artifacts.timeline));
  const { snapshot, pin } = artifacts;
  process.stdout.write(
    `okie-scan: ${snapshot.entities.length} entities, ${snapshot.relations.length} relations\n` +
    `  commit ${pin.commitSha}\n  tree   ${pin.treeHash}\n  generatedAt ${pin.generatedAt}\n` +
    `  wrote extraction/snapshot/view/story/scene/timeline to ${out}\n`,
  );
}

main();
