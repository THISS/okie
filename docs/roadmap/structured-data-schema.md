# Structured data schema evolution

Status: proposed roadmap.

How `packages/architecture/src/model.ts` grows from an embedded-facts model into the stored-provenance model that [`../architecture/deterministic-first-ingestion.md`](../architecture/deterministic-first-ingestion.md) requires, without breaking the current shapes or the renderer contract. Identity rules follow [`../architecture/ingestion-golden-tests.md`](../architecture/ingestion-golden-tests.md) ("Stable identity contract").

## Current shape (grounded)

- `ArchitectureEntity` / `ArchitectureRelation` embed `sourceRefs: SourceRef[]` and an optional flat `confidence?` directly on the object. `lineageId?` and `fingerprint?` fields exist but no runtime maintains them across scans.
- `normalized.ts` already does two things the identity contract demands: every row `id` is snapshot-qualified and each record carries a `logicalId` (see `NormalizedEntity`, `NormalizedRelation`). This is the right substrate for a claim store.
- Provenance exists only in the UI: `apps/web/src/provenance/presentation.ts` defines `ClaimOrigin = 'observed' | 'inferred' | 'ai-explanation'` and `presentClaimProvenance`. Nothing in the stored model records origin, so the badge is re-derived heuristically at render time.

## Gap vs deterministic-first

1. No first-class `Claim`/`Explanation`. `deterministic-first-ingestion.md` prescribes both; the model has neither.
2. `confidence?` sits on the visual object. The doc forbids a confidence on observed facts and requires confidence to describe a *derived claim or its supporting claims*, never source text.
3. No derivation chain: an `inferred` fact cannot record its rule/version and input claims.
4. No rescan diff status and no reconciliation runtime, so a rescan cannot mark facts `unchanged|changed|new|no-longer-observed` or carry explanations forward.

## Proposed types (additive; extend `model.ts`, break nothing)

Reuse the existing `SourceRef` and id aliases. All new snapshot/entity fields are **optional**, so a v1 document without them stays valid; when present, observed entity/relation facts become *projections* of their claims.

```ts
import type { EntityId, RelationId, SnapshotId, SourceRef } from './model.js';

/** Stored provenance. UI 'ai-explanation' is an Explanation, not a Claim origin. */
export type ClaimOrigin = 'observed' | 'inferred';

export interface Claim {
  id: string;                    // snapshot-qualified row id (normalized.ts Ident<'claim'>)
  logicalId: string;             // stable identity across snapshots (from fingerprint)
  snapshotId: SnapshotId;
  subjectId: EntityId | RelationId;
  predicate: string;             // 'responsibility' | 'technology' | 'calls' | ...
  value: unknown;                // canonical JSON value
  origin: ClaimOrigin;
  sourceRefs: SourceRef[];       // existing model.ts SourceRef (path+commit+symbol+lines)
  derivation?: {                 // present iff origin === 'inferred'
    rule: string; version: string; inputClaimLogicalIds: string[];
  };
  confidence?: number;           // ABSENT when observed; calibrated [0,1] when inferred
  fingerprint: string;           // host-computed; see below
}

export interface Explanation {
  id: string;
  snapshotId: SnapshotId;
  subjectId?: EntityId | RelationId;
  text: string;                  // never inserted into any sourceRefs
  supportingClaimLogicalIds: string[];
  generation: {
    provider: string; model: string; promptVersion: string;
    generatedAt: string; responseHash: string;
  };
  review: {
    status: 'unreviewed' | 'accepted' | 'rejected';
    reviewerId?: string; reviewedAt?: string; carriedForward?: boolean;
  };
}
```

Additive links on existing records (all optional):

```ts
// ArchitectureSnapshot gains:
  claims?: Claim[];
  explanations?: Explanation[];

// ArchitectureEntity / ArchitectureRelation gain:
  claimLogicalIds?: string[];    // supporting claims; sourceRefs/confidence stay for back-compat
```

Rescan diff and lineage:

```ts
export type ClaimStatus = 'unchanged' | 'changed' | 'new' | 'no-longer-observed';

export interface ClaimLineageEntry {
  logicalId: string; status: ClaimStatus;
  priorFingerprint?: string; fingerprint?: string;
}

export interface SnapshotLineage {
  priorSnapshotId?: SnapshotId;
  claims: ClaimLineageEntry[];   // never deletes history; marks no-longer-observed
}
```

Add `'claim'`, `'explanation'`, `'claimLineage'` to `normalized.ts` `NormalizedTable`; claims normalize like relations (snapshot-qualified `id`, `logicalId`, `Ident` foreign keys to subject and input claims).

## Confidence and fingerprint rules (enforce in validators)

- Observed claims: `confidence` must be **absent**. Inferred: finite and in `[0,1]`. This is the `validateSnapshot`-level rule matching the inspector policy.
- `fingerprint` is host-computed and covers, per `ingestion-golden-tests.md`: subject identity, predicate, canonical `value`, `origin`, deterministic `derivation.rule/version`, and sorted input-claim fingerprints. Never LLM-supplied. `logicalId` derives from `fingerprint`; the snapshot-qualified `id` is `[snapshotId, logicalId]`.
- `ClaimOrigin` unification: the UI's three-way `presentClaimProvenance` tone becomes a pure function of stored data — `observed`/`inferred` from `Claim.origin`, `explanation` from the presence of an accepted `Explanation`. The heuristic in `presentation.ts` is deleted, not extended.

## Versioning and migration

Six independent version constants exist today; keep them independent and add a compatibility note per bump:

| Constant | File |
|---|---|
| `ARCHITECTURE_SCHEMA_VERSION` | `model.ts` |
| `ARCHITECTURE_EXTRACTION_SCHEMA_VERSION` | `extraction.ts` |
| `NORMALIZED_ARCHITECTURE_VERSION` | `normalized.ts` |
| `RENDERER_PROTOCOL_VERSION` | `scene-compiler/protocol.ts` |
| `DYNAMIC_FLOW_ARTIFACT_VERSION` | `scene-compiler/dynamic-flow.ts` |
| `ARCHITECTURE_AUTHORING_VERSION` | `authoring.ts` |

Discipline:

- **Additive optional field** = update the field, the matching validator (`validateSnapshot`/`validateArchitectureExtraction`, which reject unknown keys), and regenerate fixtures in the same change. No consumer breaks; a version bump is optional but recommended once claims are first-classed.
- **Breaking change** = major bump + a pure `migrateV{n}ToV{n+1}(doc)` function + read both versions during a transition window. Persisted rows are snapshot-qualified, so old snapshots remain valid under their own version.
- The extraction schema (`ARCHITECTURE_EXTRACTION_SCHEMA_VERSION`) and the stored schema evolve independently: an extractor may emit v1 facts that a v2 host materializes into claims.

## Milestones

- **M1 — claims as an additive projection.** Add `Claim`/`Explanation` types, optional snapshot arrays, normalized tables, and validator rules. `adaptArchitectureExtraction` also emits observed `Claim`s for each entity/relation fact. The golden fixture stays hand-authored but now carries observed claims for its anchors. *Acceptance:* existing `pnpm check`/`pnpm test`/`cargo test` stay green (additive only); a snapshot with `claims` round-trips through `normalizeArchitecture` → `selectArchitectureSnapshot` unchanged; observed claims carry no confidence.
- **M2 — rescan lifecycle.** Compute `SnapshotLineage` by matching `logicalId`/`fingerprint` across two snapshots; recompute inferred claims when an input fingerprint or rule version changes. *Acceptance:* the `ingestion-golden-tests.md` "Rescan unchanged" and "Rescan change" rows — unchanged facts keep fingerprints and only audit time differs; a changed source/value/rule flips exactly the dependent fingerprints and marks dependents stale, unrelated claims untouched.
- **M3 — explanations and review.** Add the `Explanation` review lifecycle and carry-forward. *Acceptance:* a changed/disappeared supporting fingerprint invalidates or stales its explanation; an accepted explanation is carried forward only when all supporting fingerprints and the prompt policy are unchanged, and records that it was carried forward.
