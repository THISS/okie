# THISS/okie OSS enrichment (CLA-48)

Accepted `ArchitectureExtraction` section summaries for this repository at
commit `b6b83d8d0e92c3353e5eb0f8e4bf696a8814971c` (tree `da112ef8c615c79a11b7b425658a412e15bd20ef`).
`promptVersion` is `okie-enrichment/v2`.

Replay with the existing scan CLI (do not pass this directory as `--enrich-from`
while `enrichment-report.json` is present — that filename is not a packet):

```sh
mkdir -p tmp/enrich-from
cp fixtures/enrichment/thiss-okie/container__*.json \
   fixtures/enrichment/thiss-okie/system__*.json \
   tmp/enrich-from/
node packages/scan/dist/cli.js --source . --enrich-from tmp/enrich-from
```

Then load `http://localhost:4173/?fixture=scan`. Do not commit `fixtures/scan/`
or `tmp/`.

All six code-bearing containers and the system scope were accepted. `@okie/web`
restates 22 of 68 file-components (the 64-entity extraction cap plus melted
single-agent context — not a gate rejection). Opaque Rust crates have no
container packet; their `responsibility` is the first paragraph of each crate
`README.md` listed in the system packet's `scopePaths`. Ownership / CODEOWNERS
is not in the scan. No persons were added.
