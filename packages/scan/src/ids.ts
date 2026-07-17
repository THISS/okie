/**
 * Deterministic, typed stable-ID derivation for scanned entities and relations.
 *
 * Every ID must satisfy `stableIdPattern` from @okie/architecture's extraction
 * gate: `^[a-z][a-z0-9]*(?::[a-z0-9]+(?:-[a-z0-9]+)*)+$` — a lowercase-alnum
 * prefix followed by one or more `:`-separated groups of hyphenated alnum tokens.
 * IDs derive only from canonical source identity (path/symbol), never from
 * discovery order, so the same repository content always yields the same IDs.
 */

/** Lowercases, splits camelCase, and collapses any non-alnum run to a single hyphen. */
export function slug(text: string): string {
  const hyphenated = text
    // insert a boundary between a lowercase/digit and an uppercase letter (camelCase)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    // and between consecutive uppercase followed by lowercase (e.g. WASMBridge -> WASM-Bridge)
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2");
  const cleaned = hyphenated
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "x";
}

/** A single hyphenated group derived from a repository-relative path. */
export function pathSlug(path: string): string {
  return slug(path);
}

/** Builds a typed stable ID from a prefix and one or more already-computed groups. */
export function typedId(prefix: string, ...groups: string[]): string {
  return `${prefix}:${groups.map(group => slug(group)).join(":")}`;
}

/**
 * Assigns final IDs from a canonical list of desired IDs, appending a numeric
 * suffix to the second and later occurrences of any collision. The input MUST be
 * pre-sorted canonically (e.g. by desired ID then natural key) so the assignment
 * is independent of discovery order — the canonically-first item keeps the bare ID.
 */
export function resolveCollisions(desired: readonly string[]): string[] {
  const used = new Set<string>();
  return desired.map(id => {
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
    let suffix = 2;
    while (used.has(`${id}-${suffix}`)) suffix += 1;
    const resolved = `${id}-${suffix}`;
    used.add(resolved);
    return resolved;
  });
}
