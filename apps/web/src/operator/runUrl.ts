/**
 * The selected run lives in the operator URL (`/operator?run=<runId>`) so a reload reopens it (CLA-259). Pure helpers;
 * the workspace reads the parameter on mount and replaces it (no new history entry) when the selection changes.
 */
export function runIdFromSearch(search: string): string | undefined { return new URLSearchParams(search).get('run') || undefined; }
export function searchWithRun(search: string, runId: string | undefined): string {
  const params = new URLSearchParams(search);
  if (runId) params.set('run', runId); else params.delete('run');
  const next = params.toString();
  return next ? `?${next}` : '';
}
/** The run to open on load: the requested one when it exists, else the only run when there is exactly one. */
export function initialRun<T extends { runId: string }>(runs: readonly T[], requestedRunId: string | undefined): T | undefined {
  return (requestedRunId ? runs.find(run => run.runId === requestedRunId) : undefined) ?? (runs.length === 1 ? runs[0] : undefined);
}
