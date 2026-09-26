import { readFileSync } from "node:fs";
import { formatDependencyConsumerReport, parsePortableAtlas, queryDependencyConsumers, type DependencyEcosystem } from "@okie/architecture";
import { stableJson } from "./scan.js";

export const CONSUMERS_USAGE = "Usage: okie-scan consumers <dependency> --bundle <atlas.okie.json> [--ecosystem npm|cargo] [--json] [--runtime-only]";

/**
 * `okie-scan consumers`: answer "who uses <dependency>?" from a bundle's captured
 * dependency facts. Exit 0 even with no consumers; throws on bad arguments or bundle.
 */
export function runConsumersQuery(args: readonly string[], read: (path: string) => string = path => readFileSync(path, "utf8")): string {
  let dependency: string | undefined;
  let bundlePath: string | undefined;
  let ecosystem: DependencyEcosystem | undefined;
  let json = false;
  let includeTypeOnly = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const value = (): string => {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`Missing value for ${arg}. ${CONSUMERS_USAGE}`);
      index += 1;
      return next;
    };
    if (arg === "--bundle") bundlePath = value();
    else if (arg === "--ecosystem") {
      const next = value();
      if (next !== "npm" && next !== "cargo") throw new Error(`--ecosystem must be npm or cargo. ${CONSUMERS_USAGE}`);
      ecosystem = next;
    } else if (arg === "--json") json = true;
    else if (arg === "--runtime-only") includeTypeOnly = false;
    else if (arg.startsWith("--") || dependency !== undefined) throw new Error(`Unexpected argument: ${arg}. ${CONSUMERS_USAGE}`);
    else dependency = arg;
  }
  if (!dependency || !dependency.trim()) throw new Error(`Missing dependency name. ${CONSUMERS_USAGE}`);
  if (!bundlePath) throw new Error(`Missing --bundle. ${CONSUMERS_USAGE}`);
  let text: string;
  try { text = read(bundlePath); } catch { throw new Error(`Bundle not found: ${bundlePath}`); }
  const bundle = parsePortableAtlas(text);
  const report = queryDependencyConsumers(bundle.dependencies, dependency, { ...(ecosystem ? { ecosystem } : {}), includeTypeOnly });
  return json ? stableJson(report) : formatDependencyConsumerReport(report);
}
