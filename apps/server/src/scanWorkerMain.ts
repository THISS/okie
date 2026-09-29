import { parentPort, workerData } from "node:worker_threads";
import { createAnonymousGithubClient, scanGithubRepository, scrubGithubTokens } from "@okie/scan";
import { githubClientForAccess } from "./githubAccess.js";
import type { WorkerScanInput } from "./scanWorker.js";

// Worker entry for scanInWorker: the GitHub client is built here (clients are not cloneable); only data crosses back.
const input = workerData as WorkerScanInput;
try {
  const client = input.access.kind === "unauthenticated" ? createAnonymousGithubClient() : githubClientForAccess(input.access);
  const result = await scanGithubRepository(input.source, { ...input.options, client });
  parentPort!.postMessage({ ok: true, value: { commitSha: result.commitSha, artifacts: result.artifacts } });
} catch (error) {
  // Messages can quote request URLs or headers: never let a token cross back into run errors.
  parentPort!.postMessage({ ok: false, error: scrubGithubTokens(error instanceof Error ? error.message : String(error)) });
}
