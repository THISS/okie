import { createAnonymousGithubClient, scanGithubRepository, scrubGithubTokens } from "@okie/scan";
import { githubClientForAccess } from "./githubAccess.js";
import type { WorkerScanInput } from "./scanWorker.js";

// Child-process entry for scanInWorker (CLA-305): the input (and its GitHub token) arrives over IPC, never the
// environment; the GitHub client is built here; only data crosses back. A lost parent ends the scan.
process.on("disconnect", () => process.exit(1));
process.once("message", async (message: unknown) => {
  const input = message as WorkerScanInput;
  let reply: { ok: true; value: unknown } | { ok: false; error: string };
  try {
    const client = input.access.kind === "unauthenticated" ? createAnonymousGithubClient() : githubClientForAccess(input.access);
    const result = await scanGithubRepository(input.source, { ...input.options, client });
    reply = { ok: true, value: { commitSha: result.commitSha, artifacts: result.artifacts } };
  } catch (error) {
    // Messages can quote request URLs or headers: never let a token cross back into run errors.
    reply = { ok: false, error: scrubGithubTokens(error instanceof Error ? error.message : String(error)) };
  }
  process.send!(reply, () => process.exit(0));
});
