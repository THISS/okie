---
name: okie-enrich
description: Fill Okie ArchitectureExtraction JSON from a deterministic scan packet. Use after okie-scan --emit-prompt or --emit-packets; checkout the stamped SHA, write one JSON per packet, merge with okie-scan --enrich-from.
---

# Okie enrichment (OSS loop)

Okie already has a working loop. Do not invent a second pipeline, merge path, or product UI.

```
okie-scan --source <path> --emit-packets <packets-dir>
# or, same packets plus concatenated prompts:
okie-scan --source <path> --emit-prompt <prompt-dir>
```

Then fill one `ArchitectureExtraction` JSON per packet and merge:

```
okie-scan --source <path> --enrich-from <docs-dir>
```

`--emit-prompt` is concat only: frozen `packages/scan/enrichment-prompt.md` (`okie-enrichment/v2`) by default, or `packages/scan/enrichment-prompt-v3.md` (`okie-enrichment/v3`) when the packet carries observed untested ranges from an optional lcov sidecar. Do not Jinja or rewrite those prompts. Do not silently change v2 — v3 is a versioned contract.

## Steps

1. **Checkout the stamped SHA.** Each `.prompt.md` appendix includes `commitSha` (and `treeHash`). `git checkout <commitSha>` (detached is fine) so you edit the tree the scan pinned. If HEAD is already that SHA, leave it.
2. **One JSON per packet.** For every `container__<id>.json` / `container__<id>.<n>.json` /
   `system__<id>.json` packet (skip `manifest.json`), write **one** `ArchitectureExtraction`
   document. Follow the frozen prompt for that packet's `promptVersion`: restated
   scanner-scoped ids, summaries in `responsibility`, empty `relations`. When the packet
   is `okie-enrichment/v3` and code entries carry observed `untestedRanges`, you MAY name
   those untested behaviours in `untestedBehaviours` (grounded in those ranges + `nearbyTests`).
   Without ranges, omit that field — do not invent coverage. Do not invent ids. Hallucinated
   ids or hallucinated untested ranges reject that document; sibling remainder packets for
   the same container can still merge. A rejected document's scope stays deterministic.
3. **Same filename as the packet.** Write the document to the enrich-from directory as
   `container__<id>.json` / `container__<id>.2.json` / `system__<id>.json` — the appendix
   `packetFile` value. Not a new name, not a nested folder unless the user named one.
4. **Merge with the existing gate.** `okie-scan --source <path> --enrich-from <docs-dir>`.
   Do not call a new merge command. Atomic rejection leaves that document's ids on the
   deterministic base. Remainder packets union onto the same container.

## Do not

- Template or edit `packages/scan/enrichment-prompt.md` (frozen v2). Add a new
  versioned file if the contract must change.
- Regroup files or mint component/code ids.
- Put API keys, tokens, or host paths in the JSON.
- Build product UI, a hosted runner, or a second enrich path.
