export const UNREADABLE_SAVED_ASK = 'This reply could not be formatted. Your other conversations are still available.';

/** Repair older replies whose completion envelope was stored as the answer. No citation data is trusted here. */
export function readableAskAnswer(raw: string, depth = 0): string {
  if (depth > 2 || raw.length > 100_000) return UNREADABLE_SAVED_ASK;
  const text = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  const payload = fenced ? fenced[1]!.trim() : text;
  try {
    const value: unknown = JSON.parse(payload);
    if (typeof value === 'string' && /^\s*\{\s*"answer"\s*:/.test(value)) return readableAskAnswer(value, depth + 1);
    if (value && typeof value === 'object' && !Array.isArray(value) && 'answer' in value) {
      const answer = (value as { answer: unknown }).answer;
      return typeof answer === 'string' && answer.trim() ? readableAskAnswer(answer, depth + 1) : UNREADABLE_SAVED_ASK;
    }
  } catch {
    // The model may have finished the answer but exhausted its tokens in the following citation list.
    if (/^\{\s*"answer"\s*:/.test(payload)) {
      const complete = /^\{\s*"answer"\s*:\s*("(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*")/.exec(payload);
      if (!complete) return UNREADABLE_SAVED_ASK;
      try { return readableAskAnswer(JSON.parse(complete[1]!) as string, depth + 1); }
      catch { return UNREADABLE_SAVED_ASK; }
    }
  }
  return text;
}
