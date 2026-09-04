# Okie enrichment prompt — `okie-enrichment/v3`

There are two packet kinds. A **container packet** (`container__<id>.json`) asks you for a
short section summary of that container's scanner-scoped components. A **system packet**
(`system__<id>.json`, with `"scope": "system"`) asks you for a short summary of the system
and its containers. Each packet is bounded — reason only about what it contains. Pick the
section below that matches the packet you were handed.

The live sprinkle is **section summaries**, not a free-form dump and not a file regrouping.
Accepted documents merge only if the enrichment gate accepts them. Hallucinated ids and
out-of-scope entities reject the whole scope; that scope then stays deterministic.

This is **v3**. Frozen `okie-enrichment/v2` (`enrichment-prompt.md`) is unchanged. Packets
stamp `okie-enrichment/v3` only when observed untested ranges from an optional lcov sidecar
are present on in-scope code. Without those ranges, do not invent coverage or untested
behaviours.

---

## A. Container packet — summarize this packet's scope

You are writing a **short summary** of one container for an architecture atlas. You receive
one bounded packet (JSON) describing exactly one container; you must not reason about
anything outside it.

## Your input (the packet)

- `containerId`, `containerName` — the container you are summarizing.
- `scopePaths` — every file in scope. **Cite nothing outside this list.** (`nearbyTests`
  paths are observed context, not citable `sourceRefs`.)
- `components` — the deterministic file-components (one per source file). **Restate these ids.**
- `code` — every top-level declaration: `{ id, name, symbol, path, startLine, endLine, componentId }`.
  These are **observed facts**. Their `id`, `name`, `symbol`, `path`, and line ranges are frozen.
  When an optional lcov sidecar overlapped this symbol, the entry may also carry
  `untestedRanges`, `fileHitRate`, and `nearbyTests` (capped sibling test excerpts). Those
  fields are observed facts. **Omit means no sidecar / no overlapping uncovered DA lines —
  never invent 0% or untested behaviours.**
- `relations` — import edges touching this container, for context only.
- `excerpts` — capped file headers, for understanding intent.

## Your task

Write a short summary of **this packet's scope only**: the container and its in-scope
components, and optionally in-scope code. Do not regroup files. Do not dump the packet.

When a restated code entity (or its file-component) has `untestedRanges`, you MAY name the
untested behaviours in `untestedBehaviours` — a sibling of `responsibility`. Each item copies
an observed range (or a sub-range of one) and a short phrase grounded in that range plus
`nearbyTests`. You may also mention those behaviours in `responsibility`. Without
`untestedRanges` on that entity, omit `untestedBehaviours` and do not write coverage prose.

Output **one `ArchitectureExtraction` JSON document and nothing else**:

```json
{
  "schemaVersion": 1,
  "entities": [
    { "id": "<system id from packet>", "kind": "softwareSystem", "name": "…", "sourceRefs": [] },
    { "id": "<containerId>", "kind": "container", "parentId": "<system id>", "name": "…",
      "responsibility": "One sentence on what this container is for.", "sourceRefs": [] },
    { "id": "<component id, verbatim from the packet>", "kind": "component", "parentId": "<containerId>",
      "name": "…", "responsibility": "One sentence on what this file-component does.", "sourceRefs": [] },
    { "id": "<optional code id, verbatim>", "kind": "code", "parentId": "<its scanner parent, verbatim>",
      "name": "<code name, verbatim>", "responsibility": "One sentence on this symbol.",
      "untestedBehaviours": [
        { "startLine": 12, "endLine": 14, "behaviour": "Short name of the untested behaviour." }
      ],
      "sourceRefs": [ <the code's sourceRefs, verbatim> ] }
  ],
  "relations": []
}
```

## Rules (any violation rejects the WHOLE document — the scope then keeps its file-components)

1. **Summaries only.** Put the summary in `responsibility` (one or two sentences). Do not
   invent a free-form dump of the packet.
2. **Never change observed fields.** Copy each restated code entity's `id`, `name`,
   `parentId`, and `sourceRefs` (path/symbol/lines) exactly. Do not author `coverageFileHitRate`,
   `coverageUntestedRanges`, or a CRAP score — those are scan-time overlays, not yours.
3. **Stay on scanner-scoped ids.** Restate the packet's existing container/components.
   Do not invent component ids. Do not regroup files into new logical components.
4. **Code is optional.** Restate in-scope code entities copied verbatim. Prefer code that
   carries `untestedRanges`. Omissions are fine; additions are not.
5. **Do not propose relations** — leave `relations` empty. Import edges are deterministic.
6. **Stay in scope.** Cite only `scopePaths` in `sourceRefs`. Restate the system and
   container exactly (id match). Hallucinated ids reject the document.
7. **Untested behaviours are grounded.** `untestedBehaviours[].startLine` / `endLine` must
   equal or sit inside an observed `untestedRanges` entry on that code entity (or, on a
   file-component, on one of its child code entries). Hallucinated ranges reject the
   document. `behaviour` is one short phrase from those lines and `nearbyTests`.
8. **No invented coverage.** If a code/component has no `untestedRanges` in this packet,
   omit `untestedBehaviours`. Do not invent hit rates, uncovered lines, or untested-behaviour
   prose. Do not compute CRAP.

Output is validated by `validateArchitectureExtraction` plus the rules above. It is merged
deterministically in canonical container order; your file ordering and completion time never
affect the result.

---

## B. System packet — summarize this system's containers

The deterministic scan already derives the system, its containers, and its third-party
`externalSystem` dependencies (from `package.json` + imports). Your job: a short summary of
**this system packet's scope** — the system and its scanner-scoped containers.

System packets never carry lcov ranges. Do not invent coverage or untested behaviours here.

### Your input (the system packet)

- `systemId`, `systemName` — the software system.
- `containers` — every container `{ id, name }`. **Summarize these (exact ids).**
- `externalSystems` — the deterministic third-party dependencies, for context.
- `readme` — short README teasers, to understand what the system is for.
- `scopePaths` — **the only paths you may cite** (the READMEs + container evidence anchors).

### Your task

Write a short summary of this system and each container. Output **one
`ArchitectureExtraction` JSON document and nothing else**:

```json
{
  "schemaVersion": 1,
  "entities": [
    { "id": "<systemId, verbatim>", "kind": "softwareSystem", "name": "…",
      "responsibility": "One sentence on what the system is for.", "sourceRefs": [] },
    { "id": "<containerId, verbatim>", "kind": "container", "parentId": "<systemId>", "name": "…",
      "responsibility": "One sentence on what this container is for.", "sourceRefs": [] }
  ],
  "relations": []
}
```

### Rules (any violation rejects the WHOLE document — the base then keeps its deterministic shape)

1. **Add no new entities.** Restate the system and the packet's containers only. You may
   **not** add a person, component, code, or unknown container.
2. **Restate anchors, don't change them.** Id-match the system and every container you
   summarize; observed names and sourceRefs stay base-owned. Only `responsibility` is
   judgement. Do not add `untestedBehaviours` at system scope.
3. **Do not propose relations** — leave `relations` empty.
4. **Stay in scope.** Cite only `scopePaths`. Never invent a container id.

Merged deterministically: accepted summaries are attached to the existing entities.
Rejection is atomic and leaves the deterministic base untouched.
