# Deterministic C4 component membership contract

## Decision

Keep C4 L3 as the existing `component` entity kind.  A component is a coherent
responsibility within one container and may own code from more than one file.
Do not add a C4 level, a folder-derived entity kind, or a second graph.

The scan's present base remains the conservative fallback: one file component
per source file, with its extracted code children. An optional deterministic
component-membership document layers an authored architectural interpretation
over that observed graph. It replaces only the explicitly listed code-bearing
file components with logical components; unlisted files stay file-components.
It uses the same reparent/remap semantics already implemented for accepted
enrichment `regroup` documents in `packages/scan/src/enrich.ts`; it must not
depend on an LLM response.

Published snapshots and portable atlases remain schema version 1.  They already
express the resulting graph using `component.parentId`, code `parentId`, source
refs, and relations.  Old artifacts contain no membership document and are
therefore read exactly as their existing file-component graph; their entity
URLs, evidence URLs, source IDs, and call graph IDs are not rewritten.

## Proposed scan-owned input

This is an optional scanner input / persisted scan metadata document, not an
addition to `ArchitectureSnapshot`, `ArchitectureExtraction`, or
`ArchitectureAuthoringDocument`. The local CLI input is explicitly external to
the scanned commit and its path plus SHA-256 are recorded in
`component-map-report.json`; a future committed-map loader must report `kind:
"committed"` and its committed path/hash.

```ts
export interface ComponentMembershipDocument {
  version: 1;
  containers: Array<{
    containerId: `container:${string}`;
    components: Array<{
      // Caller-authored, typed, stable across scans; never derived from order.
      id: `component:${string}`;
      name: string;
      responsibility?: string;
      tags?: string[];
      // Each path belongs to exactly one logical component in this container.
      paths: string[];
    }>;
  }>;
}
```

Example:

```json
{
  "version": 1,
  "containers": [{
    "containerId": "container:apps-web",
    "components": [
      {
        "id": "component:apps-web-semantic-navigation",
        "name": "Semantic navigation",
        "responsibility": "Controls movement through C4 levels, including branch focus, reveal, reversal and camera framing.",
        "paths": [
          "apps/web/src/semantic/semanticLensEngine.ts",
          "apps/web/src/semantic/semanticLens.ts"
        ]
      }
    ]
  }]
}
```

The document deliberately records paths, not symbols: all retained code entities
from a source file move together.  This preserves the current file-cohesion
rule, avoids splitting private helpers from their module, and makes ownership
auditable.  A component's emitted `sourceRefs` are the sorted, unique member
paths; maps exceeding the existing extraction limit are rejected, never truncated. its code children retain their
unchanged path/symbol/range refs.

Every emitted logical component carries the reserved presentation/provenance tag
`okie:component-mapping`; authored tags may not use the `okie:` namespace. A
file-derived fallback has no such tag. This signal is in the v1 portable
snapshot, while the map's external/committed path and SHA-256 remain in the
adjacent scan report rather than adding volatile metadata to the snapshot.

## Validation and application

Validate before mutating the base extraction, atomically for the entire document:

1. `containerId` must identify an extracted container.  Component IDs must be
   unique document-wide, typed, non-colliding, and parented to that container.
2. Every listed path must be an in-container source path which currently owns a
   code-bearing file component.  No duplicate paths, no cross-container paths,
   and no path assigned to two components.
3. Each listed code-bearing file component is assigned once. Unlisted files,
   including files with no retained declarations, remain their deterministic
   file components. This permits a focused three-file component without making
   an author enumerate an entire large container.
4. Reject a component with more than the architecture extraction's source-ref
   limit; never cap or omit authoritative membership paths. Canonicalize
   containers, components, paths, tags, source refs, and generated
   relations lexically before minting output.  Reapplying the same document must
   be byte-identical.
5. On any failure, reject the entire mapping and retain the untouched
   file-component base.  A rejected mapping never partially
   reparents code or drops a file component.

For an accepted container, emit each logical component with `parentId` equal to
the container and reparent every code entity from each member file to it.  Code
entity IDs, source refs, exposures, coverage and complexity overlays remain
unchanged.  Component IDs are the explicit document IDs; no path hash or list
position becomes identity.

Relations are projected from the observed base rather than authored anew:

* remap a file-component endpoint to its logical component;
* retain code-to-code relations and their source-line evidence unchanged;
* merge equal `(from, to, kind, label, technology, optional)` component edges,
  sorting and de-duplicating evidence by its full source ref plus reason;
* when both endpoints collapse to the same logical component, apply the current
  `mergeEnrichment` behavior: drop non-`calls` self edges and retain `calls`
  self edges;
* mint only new aggregate relation IDs deterministically.  Old snapshots retain
  their original relation IDs because they are never migrated.

The mapping is an authored architectural interpretation, not an observed source
fact and not a user authoring override. Existing `ArchitectureAuthoringDocument`
owns relation/tombstone/route intent, while `ArchitectureOverrides` owns
presentation patches. Membership belongs beside scan configuration/provenance,
and its committed-versus-external origin must be explicit.

## Implementation ownership

* `packages/scan/src/extract.ts` continues to produce the complete file-based
  base and observed file/code relations.
* Add the membership types, canonicalizer, validator, and application step in
  `packages/scan/src` adjacent to `enrich.ts` (or factor the shared regroup
  mechanics there).  `scan.ts` applies it after deterministic extraction and
  before `adaptArchitectureExtraction` / overlays / stories.
* Reuse `packages/architecture/src/extraction.ts` validation for the resulting
  extraction and `packages/architecture/src/validation.ts` after adaptation;
  neither public artifact schema needs a field or version bump.
* `packages/scan/src/portable.ts` and `packages/architecture/src/portable.ts`
  continue to serialize/validate the resulting v1 snapshot unchanged.  The
  scan metadata document is not required to view an immutable portable atlas.
* `packages/scan/src/enrich.ts` remains the LLM-gated judgement/regroup path.
  If mechanics are shared, keep its atomic acceptance and file-cohesion tests;
  deterministic membership must not widen enrichment authority.

## Required tests

1. A two-file explicit component reparents all of both files' code, emits sorted
   multi-path component refs, preserves every code ID/source ref/exposure, and
   validates as extraction and snapshot.
2. Reordered input arrays produce byte-identical entities, relations, and
   aggregate evidence.
3. File-to-file imports become logical-component edges with all original
   evidence; code call graph edges remain code-to-code.
4. Duplicate/missing/out-of-container paths, duplicate IDs, ID collision, and a
   split-file assignment reject atomically and retain exactly the base file
   components.
5. A partial mapping preserves files without retained code as file components.
6. A legacy snapshot and a portable atlas with no mapping document parse and
   render byte-identically; existing component/source/relation deep links still
   resolve.
7. Repeated scan with the same explicit IDs preserves logical-component IDs;
   changing membership only changes the affected new snapshot, never a
   previously published artifact.

## Enrichment extension point

An agent may propose this same membership document, accompanied by source-backed
reasoning for each boundary. Review the proposal before passing it explicitly
to the CLI. Applying a map is deterministic; deciding a responsibility boundary
is authored interpretation. No automatic clustering or live enrichment is
introduced by this slice.

Existing enrichment `regroup` requires a complete container code partition;
this map instead permits partial ownership. The two input contracts remain
separate. Mapping currently runs before enrichment merge, whose observed-fact
and scope gates still apply: stale documents that restate removed file component
IDs can be rejected. `--emit-packets` still describes the original deterministic
base, not a new partial-mapping proposal protocol. A follow-up should provide
mapping-aware enrichment packets, preserve reviewed ownership through retries,
and surface the mapping report in operator review before enabling that combined
workflow.
