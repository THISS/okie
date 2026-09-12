# Portable v1 skill forward test

Date: 2026-09-13 (Australia/Brisbane).

User request exercised: “Map my committed TypeScript repository locally, then enrich its explanation and prepare a static viewer I can host later.”

## Result

The Scan → Enrich → Package workflow succeeded with the current workspace CLI. The scan used committed source despite a dirty checkout, one selected enrichment scope was accepted on the first attempt, and a browser loaded the exported site over static HTTP without a scan server. The enriched container, component, and code summaries appeared in the inspector. The dedicated source tab displayed the original revision's excerpt and returned to the selected map.

No repository or generated atlas was published. The source repository was unchanged. Test artifacts are under `/tmp/okie-skill-forward-test`; this report is the only repository file created by the skill test.

## Inputs and commands

Read and followed `skills/okie-scan/SKILL.md`, `skills/okie-enrich/SKILL.md`, and `skills/okie-package/SKILL.md`. The task explicitly substituted `node packages/scan/dist/cli.js` for an installed `okie-scan` executable because the installed smoke-test tarball was stale. This test therefore verifies the current CLI and skills, not the previously installed tarball.

Source path came from `/tmp/okie-cli-smoke-source-path`. The supplied prompts at `/tmp/okie-cli-smoke-prompts` were inspected; the Scan step also emitted a fresh matching prompt set for the forward test. The existing portable viewer build was `apps/web/dist-portable`.

```sh
node packages/scan/dist/cli.js --help
node packages/scan/dist/cli.js --source <source-path-from-file> \
  --revision 272a0322a9542516ec48a8f2b2c8a8b09db49392 \
  --out /tmp/okie-skill-forward-test/scan --full \
  --emit-prompt /tmp/okie-skill-forward-test/prompts
node packages/scan/dist/cli.js enrich \
  --bundle /tmp/okie-skill-forward-test/scan/atlas.okie.json \
  --docs /tmp/okie-skill-forward-test/docs \
  --out /tmp/okie-skill-forward-test/enriched.okie.json
node packages/scan/dist/cli.js export \
  --bundle /tmp/okie-skill-forward-test/enriched.okie.json \
  --viewer apps/web/dist-portable \
  --out /tmp/okie-skill-forward-test/site
python3 -m http.server 4186 --bind 127.0.0.1 \
  --directory /tmp/okie-skill-forward-test/site
```

Browser verification URL: `http://127.0.0.1:4186/`. Port 4176 was occupied, so the static server used 4186. Loopback serving required the environment's sandbox escalation; no public interface was bound.

## Source identity and semantic output

- Commit: `272a0322a9542516ec48a8f2b2c8a8b09db49392`.
- Tree: `cb363ed0a87662c8c749a670615abf78f093845e`.
- The checkout contained a modified `src/index.ts` with `export const dirtyWorktree = true;`. The committed file instead defines `greet(name)` and `main()`, with `main()` calling `greet("Atlas")`.
- Full scan output: five entities, one resolved `calls` relation from `main` to `greet`, TypeScript compiler 5.9.3 semantic coverage, no reported limitations for this small repository.
- Commit/tree identity, snapshot timestamp, analyzer coverage, source references, source excerpts, and deterministic relations were equal before and after enrichment. The packaged bundle was equal to the enriched output.
- Git HEAD, porcelain status, and the dirty file's bytes were unchanged after the workflow.
- The bundle contains excerpts; full source was not requested or included. No repository URL was supplied.

Machine-checked results are in `/tmp/okie-skill-forward-test/verification.json`. Source baseline is in `source-before.json`, and CLI scan output is in `scan.log` in the same directory.

## Accepted enrichment

Read the emitted v2 container prompt, its packet, the matching system packet, the existing bundle, and the committed source. Submitted only `docs/container__portable-cli-smoke.json`, with the exact existing system/container/component IDs and one optional code entity. Relations remained empty as the prompt requires.

The gate accepted `container:portable-cli-smoke` with no rejection reasons. Added descriptions:

- Container: “Provides a greeting formatter and a main function that greets Atlas.”
- Component: “Defines greet and main; main calls greet with the name Atlas.”
- `greet`: “Formats the supplied name as a Hello greeting.”

These describe the visible source. No caller, dependency, or user flow was invented. The report is `/tmp/okie-skill-forward-test/enriched.okie.json.enrichment-report.json`.

## Browser exploration and package inspection

The exported package contained 100 files totaling 29,072,379 bytes. Packaged bundle SHA-256: `6b0877f02c7dff744dbda75208b6ab87c012a195ebcb055ede09c8e283bf6ff2`. Exported `index.html` SHA-256: `04a87bbdd38f27c48aa98f9486f2aef7cd0203531a842b2f665d590d6e520bdf`.

Opened the page in Chrome. Traversed system → container → source component → `greet` through inspector child controls. Confirmed all three new descriptions and the `main calls` dependent row. Selected Source, confirmed the committed `greet` excerpt and `Frozen @ 272a0322a954`, opened “Open source in a tab,” and returned to “Main diagram, pinned.” The source view truthfully said “Full source is not bundled. The saved excerpt remains available.” The same symbol selection and URL camera values remained after returning to the map.

Evidence files:

- `/tmp/okie-skill-forward-test/source-viewer.png`
- `/tmp/okie-skill-forward-test/source-viewer-ax.txt`
- `/tmp/okie-skill-forward-test/map-restored.png`
- `/tmp/okie-skill-forward-test/map-restored-ax.txt`

The supplied viewer build was older than concurrent App source fixes. It displayed a header repository link to `github.com/THISS/okie` despite this bundle having no URL, and made a failing `GET /api/auth/me` request. These were reported immediately. The integrating agent reports fixing the source link, hosted account/Ask controls, and auth request in portable mode; this forward test did not rebuild the viewer or verify those fixes. The static atlas/source flow itself worked. Rebuild and final browser QA must verify the updated chrome.

## Skill and prompt ambiguities

1. The container prompt requests “system id from packet,” but neither its container packet nor its appended ownership context includes `systemId`. It can be obtained from the existing bundle or companion system packet, which the overall workflow supplies. The Enrich skill should name that lookup so a future agent does not invent an ID.
2. The prompt asks to copy a code entity's `sourceRefs` verbatim, while packet code records expose flattened `path`, `symbol`, `startLine`, and `endLine`, not a `sourceRefs` array. The portable snapshot has `sourceRefs`, but includes `commitSha`, which is not allowed in `ArchitectureExtractionSourceRef`. The accepted forward-test document reconstructed the extraction source reference from packet fields. The skill should explicitly describe this mapping and omission of snapshot-only revision fields.
3. An installed scan CLI alone does not supply a built viewer. The Package skill accurately discloses this requirement and gives the source-checkout build command. This test had the supplied matching viewer directory; obtaining a viewer when only the standalone CLI is installed remains a prerequisite, not an exercised installation flow.

No unsupported CLI flag or packaging instruction was encountered. Empty-viewer import, replacement, Forget, Rust, v3 coverage enrichment, and deployment were outside this bounded scenario and were not retested here.
