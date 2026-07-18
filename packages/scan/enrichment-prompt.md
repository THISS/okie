# Okie enrichment prompt — `okie-enrichment/v2`

There are two packet kinds. A **container packet** (`container__<id>.json`) asks you to group
one container's files into logical components. A **system packet** (`system__<id>.json`, with
`"scope": "system"`) asks you to name the top-level actors that interact with the whole system.
Each packet is bounded — reason only about what it contains. Pick the section below that matches
the packet you were handed.

---

## A. Container packet — group files into logical components

You are grouping one container's source files into **logical components** for an
architecture atlas. You receive one bounded packet (JSON) describing exactly one
container; you must not reason about anything outside it.

## Your input (the packet)

- `containerId`, `containerName` — the container you are enriching.
- `scopePaths` — every file in scope. **Cite nothing outside this list.**
- `components` — the deterministic file-components (one per source file).
- `code` — every top-level declaration: `{ id, name, symbol, path, startLine, endLine, componentId }`.
  These are **observed facts**. Their `id`, `name`, `symbol`, `path`, and line ranges are frozen.
- `relations` — import edges touching this container, for context only.
- `excerpts` — capped file headers, for understanding intent.

## Your task

Propose **3–9 logical components** that group the files by responsibility (e.g. "Navigation",
"Rendering host", "Semantic schema"), then re-parent every code entity into one of them.

Output **one `ArchitectureExtraction` JSON document and nothing else**:

```json
{
  "schemaVersion": 1,
  "entities": [
    { "id": "<system id from packet>", "kind": "softwareSystem", "name": "…", "sourceRefs": [] },
    { "id": "<containerId>", "kind": "container", "parentId": "<system id>", "name": "…", "sourceRefs": [] },
    { "id": "component:<container-slug>-navigation", "kind": "component", "parentId": "<containerId>",
      "name": "Navigation", "responsibility": "One sentence on what this group does.", "sourceRefs": [] },
    { "id": "<code id, verbatim>", "kind": "code", "parentId": "component:<container-slug>-navigation",
      "name": "<code name, verbatim>", "sourceRefs": [ <the code's sourceRefs, verbatim> ] }
  ],
  "relations": []
}
```

## Rules (any violation rejects the WHOLE document — the scope then keeps its file-components)

1. **Never change observed fields.** Copy each code entity's `id`, `name`, and `sourceRefs`
   (path/symbol/lines) exactly. You may change ONLY its `parentId`.
2. **Cover every code entity exactly once.** Every `code` id in the packet must appear exactly
   once, re-parented into one proposed component. No omissions, no additions, no duplicates.
3. **Keep whole files together (file cohesion).** All code entities that share a `path` must go
   into the SAME component. Group by file, not by symbol.
4. **Propose meaningful components.** 3–9 per container; a clear `name` and a one-sentence
   `responsibility`. Namespace every id as `component:<container-slug>-<something>` (the
   `<container-slug>` is the container id after `container:`). Component ids must be new.
5. **Do not propose relations** — leave `relations` empty. Import edges are deterministic and are
   remapped for you.
6. **Stay in scope.** Cite only `scopePaths`. Restate the system and container exactly (id match);
   their content is ignored, but they must be present so the document validates.

Output is validated by `validateArchitectureExtraction` plus the rules above. It is merged
deterministically in canonical container order; your file ordering and completion time never
affect the result.

---

## B. System packet — propose the top-level actors (persons)

The deterministic scan already derives the system, its containers, and its third-party
`externalSystem` dependencies (from `package.json` + imports). What it *cannot* derive is
**who** interacts with the system — that is judgement, not parsing. Your job: name the human and
automated **actors** (persons) at the edge of the system and connect them to what they use.

### Your input (the system packet)

- `systemId`, `systemName` — the software system.
- `containers` — every container `{ id, name }`. **Relate actors to these (or to the system).**
- `externalSystems` — the deterministic third-party dependencies, for context.
- `readme` — short README teasers, to understand who the system is for.
- `scopePaths` — **the only paths you may cite** (the READMEs + container evidence anchors).

### Your task

Propose the **actors** (kind `person`) that use the system — e.g. `User`, `Developer`,
`AI Agent (MCP)`, `CI pipeline` — and one relation per interaction. Output **one
`ArchitectureExtraction` JSON document and nothing else**:

```json
{
  "schemaVersion": 1,
  "entities": [
    { "id": "<systemId, verbatim>", "kind": "softwareSystem", "name": "…", "sourceRefs": [] },
    { "id": "<containerId you relate to, verbatim>", "kind": "container", "parentId": "<systemId>", "name": "…", "sourceRefs": [] },
    { "id": "person:user", "kind": "person", "name": "User",
      "responsibility": "One sentence on who they are and why they interact.",
      "sourceRefs": [ { "path": "README.md" } ] },
    { "id": "actor:ai-agent", "kind": "person", "name": "AI Agent (MCP)", "sourceRefs": [ { "path": "README.md" } ] }
  ],
  "relations": [
    { "id": "relation:user-uses-system", "from": "person:user", "to": "<containerId or systemId>",
      "kind": "uses", "evidence": [ { "source": { "path": "README.md" } } ] }
  ]
}
```

### Rules (any violation rejects the WHOLE document — the base then keeps its deterministic shape)

1. **Add only persons.** Every new entity must be `kind: "person"` with a `person:` or `actor:`
   id. You may **not** add or modify a container, component, code, or external system.
2. **Restate anchors, don't change them.** Restate the system and every container/external you
   reference in a relation, id-matched; their content is ignored (the base wins), they exist only
   so the document validates.
3. **Every relation must touch a proposed person.** The other endpoint must be the system, a
   container, or an external system. No structural (non-person) edges — those are deterministic.
4. **Stay in scope.** `person.sourceRefs` and every relation `evidence.source.path` must be one
   of `scopePaths`. Propose at least one actor.

Merged deterministically: accepted persons + person-relations are added to the atlas and render
in the L1 system-context band alongside the deterministic external systems. Rejection is atomic
and leaves the deterministic base untouched.
