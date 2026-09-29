/**
 * Deterministic, typed stable-ID derivation for scanned entities and relations.
 *
 * Every ID must satisfy `stableIdPattern` from @okie/architecture's extraction
 * gate: `^[a-z][a-z0-9]*(?::[a-z0-9]+(?:-[a-z0-9]+)*)+$` — a lowercase-alnum
 * prefix followed by one or more `:`-separated groups of hyphenated alnum tokens.
 * IDs derive only from canonical source identity (path/symbol), never from
 * discovery order, so the same repository content always yields the same IDs.
 *
 * IDs are length-bounded by {@link boundStableId}: an ID within the gate's
 * `maxIdCharacters` (192) is returned unchanged; a longer one (two long path slugs in
 * a relation id, a deeply nested generated file) becomes a readable prefix plus a
 * hash of the full ID.
 */

import { createHash } from "node:crypto";
import { ARCHITECTURE_EXTRACTION_LIMITS } from "@okie/architecture";

/** The extraction gate's ID length limit; every scanner ID must fit it. */
export const MAX_STABLE_ID_CHARACTERS = ARCHITECTURE_EXTRACTION_LIMITS.maxIdCharacters;
/** Hex characters of sha256(full id) appended to a bounded ID (64 bits). */
export const BOUNDED_ID_HASH_CHARACTERS = 16;
/**
 * Room a bounded ID leaves below the limit so `resolveCollisions` can append
 * `-N` (up to 7 digits) without re-bounding. Bounded IDs are therefore at most
 * 192 - 8 = 184 characters.
 */
export const BOUNDED_ID_SUFFIX_HEADROOM = 8;

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
  return boundStableId(unboundedTypedId(prefix, ...groups));
}

/**
 * {@link typedId} WITHOUT length bounding. Only for snapshot-only overlays that never
 * pass the extraction gate (the `duplicates` clone edges attached after extraction and
 * filtered out of every extraction/enrichment path): their ids were never subject to
 * the 192-character limit, so bounding them would only move ids already published.
 */
export function unboundedTypedId(prefix: string, ...groups: string[]): string {
  return `${prefix}:${groups.map(group => slug(group)).join(":")}`;
}

/**
 * Bounds a pattern-valid stable ID to {@link MAX_STABLE_ID_CHARACTERS}. Identity for
 * any ID that already fits (so existing IDs, publications and incremental reuse never
 * move). A longer ID keeps its readable head — cut back to the last `-`/`:` token
 * boundary so no token is split — followed by `-` and the first
 * {@link BOUNDED_ID_HASH_CHARACTERS} hex characters of sha256 of the FULL ID, so two
 * long IDs sharing a head stay distinct. The result is at most
 * `MAX_STABLE_ID_CHARACTERS - BOUNDED_ID_SUFFIX_HEADROOM` characters and still matches
 * the gate's stable-ID pattern (the hash joins the last kept group as a hyphen token).
 */
export function boundStableId(id: string): string {
  if (id.length <= MAX_STABLE_ID_CHARACTERS) return id;
  const hash = createHash("sha256").update(id).digest("hex").slice(0, BOUNDED_ID_HASH_CHARACTERS);
  const budget = MAX_STABLE_ID_CHARACTERS - BOUNDED_ID_SUFFIX_HEADROOM - BOUNDED_ID_HASH_CHARACTERS - 1;
  const firstColon = id.indexOf(":");
  // Degenerate input (no typed prefix within budget): hash only, still pattern-shaped.
  if (firstColon <= 0 || firstColon >= budget - 1) return `id:${hash}`;
  let head = id.slice(0, budget);
  if (!/[-:]/.test(id.charAt(budget))) {
    const boundary = Math.max(head.lastIndexOf("-"), head.lastIndexOf(":"));
    // Keep at least one token after the prefix; otherwise hard-cut mid-token.
    if (boundary > firstColon + 1) head = head.slice(0, boundary);
  }
  head = head.replace(/[-:]+$/, "");
  return `${head}-${hash}`;
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
    // Re-bound the suffixed form: an unbounded ID of 185-192 characters plus `-N`
    // would otherwise overflow the limit (a bounded ID has headroom for it).
    let suffix = 2;
    while (used.has(boundStableId(`${id}-${suffix}`))) suffix += 1;
    const resolved = boundStableId(`${id}-${suffix}`);
    used.add(resolved);
    return resolved;
  });
}
