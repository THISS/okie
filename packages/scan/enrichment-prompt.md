# Okie enrichment prompt — `okie-enrichment/v1`

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
