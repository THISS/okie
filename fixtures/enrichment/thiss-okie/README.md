# THISS/okie OSS enrichment (CLA-48 + CLA-50)

Accepted `ArchitectureExtraction` section summaries for this repository at
commit `5d5157ea322254266ecd4ea2fe6fa1f644f3676b` (tree from `origin/main` at
CLA-48 squash). `promptVersion` is `okie-enrichment/v2`.

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
file-components:

- **68 / 68 code-bearing** restated across `container__apps-web.json` (22) and
  remainder packet `container__apps-web.2.json` (46). The packet generator splits
  a container that exceeds `MAX_COMPONENTS_PER_PACKET` (61); `--enrich-from`
  unions remainder docs onto the same container.
- **1 documented skip:** `src/inspector/inspectorSupport.ts`
  (`component:apps-web-src-inspector-inspector-support-ts`) is an empty
  file-component (re-exports only, no top-level declaration) and is not an
  enrichment target.

Opaque Rust crates have no container packet; their `responsibility` is the first
paragraph of each crate `README.md` listed in the system packet's `scopePaths`.
Ownership / CODEOWNERS is not in the scan. No persons were added.
