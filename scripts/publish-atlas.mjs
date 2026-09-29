#!/usr/bin/env node
// CLA-266: publish one repository's CURRENT operator publication to the published-atlas R2 store.
//
//   pnpm publish:atlas --repo owner/name --env staging|production|local [--scan-root <dir>] [--dry-run [--out <dir>]]
//                      [--persist-to <dir>] [--license-override <SPDX id or expression>] [--yes]
//   pnpm publish:atlas --repo owner/name --env <env> --set-latest <versionId> [--out <dir>] [--persist-to <dir>] [--yes]
//   pnpm publish:atlas --env <env> --backfill-names [--dry-run [--out <dir>]] [--persist-to <dir>] [--yes]
//
// Reads the operator store read-only (never takes its lock, never writes). Looks up the upstream licence (GitHub
// licence API at the pinned commit, unauthenticated), then uploads version files, gzip packs and source-paths.json,
// then manifest.json, then latest.json, then index.json (merged with the existing remote index). `--set-latest` is the
// rollback: it points latest.json + index.json at a version already in the store and uploads nothing else.
// `--backfill-names` (CLA-318, one-off) fills GitHub's owner/repo casing (`ownerLogin`/`repoName`) on index.json rows that
// lack it and rewrites index.json only (no new versions); `--dry-run` alone reads the env's index and reports, `--dry-run
// --out <dir>` runs against a directory store instead.
// Remote envs use the `wrangler login` OAuth session; the account is apps/edge/wrangler.jsonc `account_id`
// (CLOUDFLARE_ACCOUNT_ID overrides it when set);
// API tokens are stripped from the wrangler child. Prints keys and sizes only — never environment values.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(repoRoot, "apps/server/dist");

function usage(message) {
  if (message) process.stderr.write(`publish:atlas: ${message}\n`);
  process.stderr.write("usage: pnpm publish:atlas --repo owner/name --env staging|production|local [--scan-root <dir>] [--dry-run [--out <dir>]] [--persist-to <dir>] [--license-override <SPDX id or expression>] [--yes]\n");
  process.stderr.write("       pnpm publish:atlas --repo owner/name --env staging|production|local --set-latest <versionId> [--dry-run --out <dir>] [--persist-to <dir>] [--yes]\n");
  process.stderr.write("       pnpm publish:atlas --env staging|production|local --backfill-names [--dry-run [--out <dir>]] [--persist-to <dir>] [--yes]\n");
  process.exit(2);
}

let args;
try {
  args = parseArgs({
    options: {
      repo: { type: "string" },
      env: { type: "string" },
      "scan-root": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      out: { type: "string" },
      "persist-to": { type: "string" },
      "license-override": { type: "string" },
      "set-latest": { type: "string" },
      "backfill-names": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
    },
    strict: true,
  }).values;
} catch (error) {
  usage(error instanceof Error ? error.message : String(error));
}

if (!existsSync(join(dist, "publishAtlas.js"))) {
  process.stderr.write("publish:atlas: apps/server is not built. Run `pnpm --filter @okie/server build` first.\n");
  process.exit(1);
}
const publish = await import(pathToFileURL(join(dist, "publishAtlas.js")).href);
const { loadOperatorDotenv } = await import(pathToFileURL(join(dist, "llmGateway.js")).href);

const backfill = args["backfill-names"];
if (backfill) {
  if (args.repo !== undefined || args["set-latest"] !== undefined || args["license-override"] !== undefined || args["scan-root"] !== undefined) usage("--backfill-names works on the whole index: no --repo, --set-latest, --license-override or --scan-root");
  if (args.out !== undefined && !args["dry-run"]) usage("--backfill-names --out <dir> needs --dry-run (without it the backfill writes to the env's bucket, never to --out)");
} else if (!args.repo) usage("--repo owner/name is required");
if (!publish.isPublishEnv(args.env)) usage("--env must be staging, production or local");
if (args.env === "production" && !args["dry-run"] && !args.yes) usage("production publishes (and --set-latest, --backfill-names) need an explicit --yes");
if (args["persist-to"] && args.env !== "local") usage("--persist-to only applies to --env local");
const rollback = args["set-latest"];
if (rollback !== undefined && args["license-override"] !== undefined) usage("--license-override does not apply to --set-latest");
if (rollback !== undefined && args["dry-run"] && !args.out) usage("--set-latest --dry-run needs --out <dir> (the directory store to roll back)");

// Same .env the server loads; values stay in process.env and are only handed to the wrangler child by name.
loadOperatorDotenv(repoRoot);

const scanRoot = resolve(args["scan-root"] ?? process.env.OKIE_SCAN_ROOT ?? join(repoRoot, "fixtures/scan"));
const log = line => process.stdout.write(`[publish:atlas] ${line}\n`);
const fail = error => {
  process.stderr.write(`publish:atlas: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
};
const mb = bytes => `${(bytes / 1e6).toFixed(1)} MB`;

function storeClient({ readEnvOnDryRun = false } = {}) {
  if (args["dry-run"] && (args.out || !readEnvOnDryRun)) {
    const out = resolve(args.out ?? mkdtempSync(join(tmpdir(), "okie-publish-dry-")));
    log(`dry run: objects under ${out}`);
    return publish.createDirectoryStoreClient(out);
  }
  let childEnv;
  try {
    const result = publish.wranglerChildEnv(args.env);
    childEnv = result.env;
    if (result.ignored.length) log(`ignoring ${result.ignored.join(", ")} from the environment/.env: wrangler uses your \`wrangler login\` session`);
  } catch (error) { fail(error); }
  return publish.createWranglerStoreClient({
    env: args.env,
    ...(args["persist-to"] ? { persistTo: args["persist-to"] } : {}),
    run: publish.pnpmWranglerRunner(repoRoot),
    childEnv,
  });
}

if (backfill) {
  // A plain --dry-run reads the env's index.json (read-only) and writes nothing; --dry-run --out uses that directory store.
  const write = !args["dry-run"] || Boolean(args.out);
  log(`backfill GitHub names in index.json (bucket ${publish.PUBLISH_BUCKETS[args.env]}, ${args["dry-run"] ? (args.out ? "dry run, directory store" : "dry run, read only") : args.env})`);
  try {
    const result = await publish.backfillPublishedNames({ client: storeClient({ readEnvOnDryRun: true }), write, log: line => log(`  ${line}`) });
    log(`done: ${result.filled} filled, ${result.alreadySet} already set, ${result.failed} unchanged after a failed lookup; index.json ${result.wrote ? "rewritten" : "not written"}`);
  } catch (error) { fail(error); }
  process.exit(0);
}

if (rollback !== undefined) {
  log(`${args.repo}: set latest → ${rollback} (bucket ${publish.PUBLISH_BUCKETS[args.env]}, ${args["dry-run"] ? "dry run" : args.env})`);
  try {
    const result = await publish.setPublishedLatest({ repo: args.repo, versionId: rollback, client: storeClient(), log });
    log(`done: ${result.slug} now points at ${result.versionId}; ${result.objects.length} objects written`);
  } catch (error) { fail(error); }
  process.exit(0);
}

let built;
try {
  built = await publish.preparePublishedVersion({ scanRoot, repo: args.repo, ...(args["license-override"] !== undefined ? { licenseOverride: args["license-override"] } : {}) });
} catch (error) { fail(error); }
const { stats } = built;
log(`${args.repo} → ${built.slug}@${built.versionId} (bucket ${publish.PUBLISH_BUCKETS[args.env]}, ${args["dry-run"] ? "dry run" : args.env})`);
log(`licence ${built.manifest.license.spdxId}${built.manifest.license.url ? ` (${built.manifest.license.url})` : " (operator override)"}`);
log(built.githubNames?.ok ? `GitHub names ${built.githubNames.ownerLogin}/${built.githubNames.repoName}` : `GitHub names not recorded (${built.githubNames?.reason ?? "no lookup"}); the index row keeps the stored owner/repo`);
log(`built in ${Math.round(stats.buildMs)} ms (packs ${Math.round(stats.packMs)} ms)`);
log(`  neighborhood pack: ${stats.neighborhoodEntries} entries, ${mb(stats.neighborhoodRawBytes)} raw → ${mb(stats.neighborhoodPackBytes)} gzip`);
log(`  excerpt pack: ${stats.excerptEntries} entries, ${mb(stats.excerptRawBytes)} raw → ${mb(stats.excerptPackBytes)} gzip`);
for (const object of built.objects) log(`  ${object.key} ${object.bytes.byteLength} bytes`);

try {
  const result = await publish.publishBuiltVersion(built, storeClient(), log);
  const total = result.objects.reduce((sum, object) => sum + object.bytes, 0);
  log(`done: version ${result.version}; ${result.objects.length} objects written (${total} bytes)`);
} catch (error) { fail(error); }
