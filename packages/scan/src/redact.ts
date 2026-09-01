/**
 * Existing token-shaped redaction (GitHub PATs and `gh` CLI tokens).
 * Applied to acquisition errors and to enrichment packet source bytes so a
 * planted credential cannot leave the machine toward a model gateway.
 * Not a new taxonomy — the same patterns the `gh` error path already used.
 */
export function scrubGithubTokens(text: string): string {
  return text
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted-token]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[redacted-token]");
}
