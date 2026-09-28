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

/** Id-, handle-, email-, or key-shaped: one token of 6+ id characters with a digit, `@`, an inner `.`/`_` (`bob.smith`), or an uppercase letter after the first. Prose words are not. */
function idShaped(value: string): boolean {
  return value.length >= 6 && /^[A-Za-z0-9._@+:/=-]+$/.test(value) && /[0-9@]|.[A-Z]|[A-Za-z0-9][._][A-Za-z0-9]/.test(value);
}

/**
 * Identifier keys a provider (OpenRouter, OpenAI, and similar gateways) may
 * echo in an error body, with an optional prefix (`end_user_id`,
 * `X-User-Id`) and `_`/`-`/no separator inside. The bounded prefix keeps the
 * scan linear. Groups: 1 prefix, 2 key, 3 key's closing quote, 4 separator.
 */
const IDENTIFIER_KEY =
  /(?<![A-Za-z0-9])((?:[A-Za-z0-9]{1,32}[_-]){0,4})(user[_-]?id|user|organi[sz]ation(?:[_-]?id)?|org[_-]?id|account[_-]?id|account|e-?mail(?:[_-]?address)?|api[_-]?key)(?![A-Za-z0-9_])(\\*["']?)(\s*[:=]\s*|\s+)/gi;
const REDACTED = "[redacted]";
const VALUE_RUN = /[A-Za-z0-9._@+-]+/y;

/** Index of the first of `chars` at or after `from`, else the text length. */
function firstOf(text: string, from: number, chars: string): number {
  for (let index = from; index < text.length; index += 1) if (chars.includes(text[index]!)) return index;
  return text.length;
}

/** Backslashes immediately before `index`. */
function backslashesBefore(text: string, index: number): number {
  let count = 0;
  while (index - count - 1 >= 0 && text[index - count - 1] === "\\") count += 1;
  return count;
}

/**
 * True when the quote at `index` is a real delimiter at escape depth `k`
 * (k = backslashes in the opening quote: 0 for `"`, 1 for `\"`, 3 for `\\\"`).
 * At that depth a delimiter has k backslashes plus whole escaped-backslash
 * groups of 2k+2; any other count is an escaped quote inside the string.
 */
function delimiterAt(text: string, index: number, k: number): boolean {
  const n = backslashesBefore(text, index);
  return n >= k && (n - k) % (2 * k + 2) === 0;
}

/** Index of the closing quote for a string opened at `from` (just after the opening quote), or -1. */
function closingQuote(text: string, from: number, quoteChar: string, k: number): number {
  for (let index = text.indexOf(quoteChar, from); index >= 0; index = text.indexOf(quoteChar, index + 1)) {
    if (delimiterAt(text, index, k)) return index;
  }
  return -1;
}

/** End (exclusive) of a balanced `{…}`/`[…]` at `start`, skipping quoted strings at depth `k`; undefined if unbalanced within 8192 chars. */
function balancedEnd(text: string, start: number, k: number): number | undefined {
  let depth = 0; let inString = false;
  for (let index = start; index < Math.min(text.length, start + 8192); index += 1) {
    const char = text[index];
    if (char === "\"") { if (delimiterAt(text, index, k)) inString = !inString; continue; }
    if (inString) continue;
    if (char === "{" || char === "[") depth += 1;
    else if ((char === "}" || char === "]") && --depth === 0) return index + 1;
  }
  return undefined;
}

/**
 * Replace the values of identifier keys (best effort; gateway errors are
 * normalized before this runs). Strong keys (`user_id`, `org_id`,
 * `organization`, `account_id`, `email`, `api_key`) lose any value; generic
 * `user`/`account` keys and whitespace-separated values only an id-shaped one.
 * Quoted values end at their real closing quote; object/array values are
 * replaced whole; a JSON value is replaced by a quoted `"[redacted]"`.
 */
function scrubIdentifierFields(text: string): string {
  let out = ""; let last = 0;
  IDENTIFIER_KEY.lastIndex = 0;
  for (let match = IDENTIFIER_KEY.exec(text); match; match = IDENTIFIER_KEY.exec(text)) {
    const key = match[2]!; const keyQuote = match[3]!; const separator = match[4]!;
    const k = keyQuote.length > 0 ? keyQuote.length - 1 : 0;
    const whitespaceOnly = !/[:=]/.test(separator);
    // `email: must be a string` is prose; an email address is caught by its own shape rule below.
    const prose = !keyQuote && /^e-?mail/i.test(key) && /^\s*:\s/.test(separator);
    const strong = !/^(?:user|account)$/i.test(key) && !whitespaceOnly && !prose;
    const start = match.index + match[0].length;
    const q = keyQuote || "\"";
    let end: number | undefined; let replacement = REDACTED;
    const quote = whitespaceOnly ? undefined : /^\\*["']/.exec(text.slice(start, start + 16))?.[0];
    if (quote) {
      // `close` is the quote character itself; its k escaping backslashes precede it.
      const close = closingQuote(text, start + quote.length, quote[quote.length - 1]!, quote.length - 1);
      const valueEnd = close >= 0 ? close - (quote.length - 1) : firstOf(text, start, "\n");
      const value = text.slice(start + quote.length, valueEnd);
      if (value && !value.startsWith("[redacted") && (strong || idShaped(value))) { end = close >= 0 ? close + 1 : valueEnd; replacement = `${quote}${REDACTED}${quote}`; }
    } else if (!whitespaceOnly && (text[start] === "{" || (text[start] === "[" && !text.startsWith("[redacted", start)))) {
      end = balancedEnd(text, start, k) ?? firstOf(text, start, ",}\n");
      replacement = `${q}${REDACTED}${q}`;
    } else {
      VALUE_RUN.lastIndex = start; const value = VALUE_RUN.exec(text)?.[0];
      if (value && (strong || idShaped(value))) { end = start + value.length; replacement = keyQuote ? `${q}${REDACTED}${q}` : REDACTED; }
    }
    if (end === undefined) { IDENTIFIER_KEY.lastIndex = match.index + match[1]!.length + key.length; continue; }
    out += text.slice(last, start) + replacement; last = end; IDENTIFIER_KEY.lastIndex = end;
  }
  return out + text.slice(last);
}

const EMAIL_LOCAL = /[A-Za-z0-9._%+-]/;
const EMAIL_DOMAIN = /[A-Za-z0-9.-]/;

/**
 * Email addresses, found from each `@` outward (one linear pass; no length cap
 * on the local part). The domain needs 2+ labels ending in a 2+ letter label.
 */
function scrubEmails(text: string): string {
  let out = ""; let last = 0;
  for (let at = text.indexOf("@"); at >= 0;) {
    let left = at; while (left > last && EMAIL_LOCAL.test(text[left - 1]!)) left -= 1;
    let right = at + 1; while (right < text.length && EMAIL_DOMAIN.test(text[right]!)) right += 1;
    while (right > at + 1 && /[.-]/.test(text[right - 1]!)) right -= 1;
    const labels = text.slice(at + 1, right).split(".");
    if (left < at && labels.length >= 2 && labels.every(Boolean) && /^[A-Za-z]{2,}$/.test(labels.at(-1)!)) {
      out += `${text.slice(last, left)}[redacted-email]`; last = right; at = text.indexOf("@", right);
    } else at = text.indexOf("@", at + 1);
  }
  return out + text.slice(last);
}

/**
 * Shape-only scrub (no key rule): credential- and account-id-shaped values.
 * Safe on structured strings such as scope ids (`component:email:sender`).
 * Every pattern starts at an anchor, so long unbroken runs stay linear.
 */
export function scrubIdentifierValues(text: string): string {
  return scrubEmails(scrubGithubTokens(text)
    .replace(/\bBearer\s+(?!\[redacted)[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted-key]")
    // Bare provider ids (`user_2fAb…`, `user-AbC1…`, `proj_…`): long, with a digit, and mixed-case or 20+ — not a code identifier like `user_service2`.
    .replace(/\b(?:user|org|acct|account|proj)_(?=[A-Za-z0-9]*\d)(?:(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{16,}|[A-Za-z0-9]{20,})\b/g, "[redacted-id]")
    .replace(/\buser-(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{16,}\b/g, "[redacted-id]")
    // OpenAI-style organization ids (`org-AbCd…`): 12+ id characters with a digit or uppercase letter, or any 20+.
    .replace(/\borg-(?:(?=[A-Za-z0-9]*[0-9A-Z])[A-Za-z0-9]{12,}|[A-Za-z0-9]{20,})\b/g, "[redacted-id]")
  );
}

/**
 * CLA-261: scrub provider account identifiers and credential-shaped values
 * from error text before it is stored, logged, or shown. Extends
 * {@link scrubGithubTokens}' shape-based approach with identifier keys
 * (`"user_id":"…"`, `organization org-…`, `email=…`) and the value shapes in
 * {@link scrubIdentifierValues}. Applying it to its own output is a no-op.
 * For error text only — never for source bytes sent to a model.
 */
export function scrubProviderIdentifiers(text: string): string {
  return scrubIdentifierValues(scrubIdentifierFields(text));
}
