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

`--emit-prompt` is concat only: frozen `packages/scan/enrichment-prompt.md` (`okie-enrichment/v2`) + packet JSON + optional appendix (file tree, ownership tree, SHA stamp). Do not Jinja or rewrite that prompt.

## Steps

1. **Checkout the stamped SHA.** Each `.prompt.md` appendix includes `commitSha` (and `treeHash`). `git checkout <commitSha>` (detached is fine) so you edit the tree the scan pinned. If HEAD is already that SHA, leave it.
2. **One JSON per packet.** For every `container__<id>.json` / `system__<id>.json` packet (skip `manifest.json`), write **one** `ArchitectureExtraction` document. Follow the frozen prompt: restated scanner-scoped ids, summaries in `responsibility`, empty `relations`. Do not invent ids. Hallucinated ids reject the whole scope; that scope stays deterministic.
3. **Same filename as the packet.** Write the document to the enrich-from directory as `container__<id>.json` / `system__<id>.json` — the appendix `packetFile` value. Not a new name, not a nested folder unless the user named one.
4. **Merge with the existing gate.** `okie-scan --source <path> --enrich-from <docs-dir>`. Do not call a new merge command. Atomic rejection leaves that scope on the deterministic base.

## Do not

- Template or edit `packages/scan/enrichment-prompt.md`.
- Regroup files or mint component/code ids.
- Put API keys, tokens, or host paths in the JSON.
- Build product UI, a hosted runner, or a second enrich path.
