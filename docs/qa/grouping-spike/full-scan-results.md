# Full unpublished scan result

The pilot is viable as a reviewed mapping plus deterministic evidence workflow.
It does not establish automatic architecture discovery across arbitrary repositories.
The accepted source-viewing capability owns three files; minimap remains separate.
Only this four-file pilot mapping was applied during the whole-repository scan.

## Artifact and preservation

Pinned public Okie commit: `6a65b895f8a6f23c3da7f254734933ef64e72a71`.
Deterministic output: `.okie-review/grouping-full-scan/atlas.okie.json`.
Final enriched draft: `.okie-review/grouping-full-enrichment/2026-09-13T23-24-19.346Z/atlas.okie.json`.

The graph contains 3,580 entities and 8,812 relationships, including 3,350 code
symbols and 218 components. Enrichment changes exactly 208 non-code responsibility
fields. A deep comparison of the complete bundles after restoring those entity
responsibilities passes: source bytes, code identities/anchors, relationships,
repository metadata, views, and stories are identical. Failed outputs are retained
for review and are not applied to the atlas or supplied as accepted child summaries.

## Coverage and usage

| Phase | Requests | Tokens | Reported USD | Unknown-cost requests |
| --- | ---: | ---: | ---: | ---: |
| Initial full enrichment | 161 | 2,045,370 | 0.33681992602 | 2 |
| Resume failed/limited scopes and rebuild parents | 121 | 1,775,239 | 0.26783587621 | 4 |
| Full enrichment total | 282 | 3,820,609 | 0.60465580223 | 6 |

This excludes earlier grouping/adjudication experiments; costs are a known-cost
subtotal, not a complete bill. Reused summaries are not counted as fresh calls.
The initial two-million-token stopping threshold overshot due to in-flight requests.

Final structural results: 208 accepted, 21 failed, zero limited out of 229 scopes.
Failures: seven entity-citation failures, four relationship-citation failures,
three with both citation problems, two unparseable outputs, four request errors, and one oversized input packet
(the web container). The 3,350 individual code symbols were
not separately enriched. Five container summaries remain gaps, including web and
atlas-protocol; the system summary explicitly lists missing child explanations.

## Semantic spot review

Structural acceptance establishes valid references, not that prose is entailed.
The mapped Source Viewer summary names fetching, request cancellation, highlighting,
and navigation helpers and explicitly acknowledges source truncation and sanitizer
omissions. It avoids treating every implementation file as an independent capability.
The geometry summary describes Point/Rect/Color and validators; external-use and
call assertions still require inspecting their cited source evidence.

ArchitectureBriefView was explicitly retried after a reviewer flagged a re-export
being described as a consumer. The retry still uses “consumed by” for
ArchitectureBrief.tsx, whose relationship is a re-export. This remains a semantic
review finding; the raw model output has not been silently rewritten or claimed
publication-ready. Root synthesis retains missing-child uncertainty, though its
short responsibility labels should also be checked against supplied evidence.

These findings support a review step and targeted retry, not unattended publication.
No scan was published and no stored published snapshot was changed.

## Reproduce

Build the scan/server packages, prepare the pinned deterministic scan with the
accepted candidate map from `grouping-adjudication/2026-09-13T22-54-18.270Z`, then:

```sh
node scripts/spikes/enrich-grouped-scan.mjs
node scripts/spikes/enrich-grouped-scan.mjs --live
node scripts/spikes/enrich-grouped-scan.mjs --resume .okie-review/grouping-full-enrichment/<prior-run> --retry-scope component:apps-web-src-inspector-architecture-brief-view-tsx --live
```

Live calls require configured gateway access and authorization. Each run retains
prepared metadata, request payload hashes, attempts, usage, validation failures,
explanations, and the unpublished atlas. The current probe uses OpenRouter with
`z-ai/glm-5.3-flash`; credentials are never stored in those payloads. The harness
is experimental and is not wired into unattended production scanning.

## Browser acceptance

Astra low confirmed the enriched artifact displays the multi-file Source Viewer
summary, preserves its 16/5/2 declarations, and opens the selected request-controller
card at canonical L4 with automatic Source lines 4–15. Initial browser automation
load timeouts recovered; limited-analysis coverage remains visible as expected.
See [browser-qa.md](./browser-qa.md) for the full exploration and Back limitation.
