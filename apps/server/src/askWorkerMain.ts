import { parentPort, workerData } from "node:worker_threads";
import { createAskIndexCache } from "./askRetrieval.js";
import { handleAskWorkerRequest, type AskWorkerHooks, type AskWorkerRequest, type AskWorkerSettings } from "./askWorker.js";

// Worker entry for createAskRetrievalWorker: owns the parsed snapshots / built indexes and answers one request at a time,
// in order. Only plain data crosses back; errors are scrubbed in handleAskWorkerRequest.
const cache = createAskIndexCache(workerData as AskWorkerSettings);
const failedBuilds = new Set<string>();
parentPort!.on("message", (request: AskWorkerRequest) => {
  const hooks: AskWorkerHooks = {
    failedBuilds,
    onBuilding: key => parentPort!.postMessage({ type: "building", id: request.id, key }),
    onBuilt: (key, ok) => parentPort!.postMessage({ type: "built", id: request.id, key, ok }),
  };
  parentPort!.postMessage(handleAskWorkerRequest(cache, request, hooks));
});
