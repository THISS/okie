# Semantic navigation example

`okie-component-map.json` is an explicit, partial architectural interpretation
of Okie web. It groups `semanticLens.ts` and `semanticLensEngine.ts` because they
jointly own the semantic navigation policy and its execution: branch targeting,
level transitions, reversal, session restoration, and camera framing. The engine
imports and applies the lens policy. Membership was checked against the source
at commit `6a65b895f8a6f23c3da7f254734933ef64e72a71`.

This is a reviewed example, not a claim that two files exhaust all navigation
behavior. App wiring, renderer geometry, and relation framing remain separate
file-based components. Cross-boundary dependencies still point to them. A later
review can extend the same component ID without rewriting a published scan.

Run from the repository root after building the scanner:

```sh
pnpm --filter @okie/scan build
node packages/scan/dist/cli.js --source . --revision 6a65b895f8a6f23c3da7f254734933ef64e72a71 --out /tmp/okie-components --repo okie --full --component-map docs/examples/okie-component-map.json --repository-url https://github.com/THISS/okie
```

The mapping is an external input even when its file lives in the checkout.
`component-map-report.json` pins its exact bytes by SHA-256; source references in
`atlas.okie.json` remain pinned to the scanned commit. The overview identifies
this as an authored component. Expand Implementing files to select declarations,
then use Source to inspect their evidence or open a dedicated source tab.

Full semantic analysis is recommended. `--quick` exercises membership without
requiring the language toolchains, but captures fewer symbol relationships.
Nothing in this command publishes the artifact or invokes an LLM.
