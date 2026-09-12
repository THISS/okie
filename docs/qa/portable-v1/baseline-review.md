# Preserved pre-portable baseline review

Reviewed 2026-09-13 against `CLAUDE.md` and the captured inspector integration/browser reports. This is a preservation and evidence audit, not a fresh implementation acceptance run. No source edits, broad tests, commit, push, PR, paid scan, or secret-file reads were performed for this review.

The baseline is HEAD `91baeee0e460c33504104aa0f394b8cf1d985108` plus the captured working changes in `/tmp/okie-portable-v1-baseline`. All 189 archive files match their SHA-256 values in `manifest.json`; the archive has no extra file entries. Applying `tracked.patch` to temporary copies of its 59 original HEAD files succeeds, and every resulting file matches the manifest. The patch alone is insufficient: 130 additional files are preserved in the archive. The current inspector final report matches its captured copy.

Integration copied all three capture files, byte-for-byte with matching SHA-256 values, into the gitignored workspace directory `.okie-review/pre-portable-baseline/`. This local backup survives temporary-directory cleanup and is excluded from shipped changes.

| Capture | SHA-256 |
| --- | --- |
| `manifest.json` | `497ba08be92766f5741fab52425eb19ae485414ac0b0e4e735682b1158367844` |
| `tracked.patch` | `a9cae603e71ad234460bbcc270ea5074acc34c90230a9a01fe0063cba0f6043e` |
| `working-changes.tar.gz` | `2615a12d10658e06f2eeeb0176e7c1b561140d3d1a4dfb69a6adc4dbf2cfadb0` |

## Change groups already present

- Inspector selection/tab preservation, scoped Overview, bounded expandable lists, canonical relationship inventory/reveal, evidence context, separate dependency/code/story diagrams, and tooltip behavior.
- Historical source retrieval and cancellation/cache handling; stronger deterministic TypeScript/JavaScript binding, export/API and executable-entry evidence.
- Earlier semantic zoom, C4 projection/layout/typography, minimap/camera and expanded Mermaid work. These are preserved preexisting changes, not portable-v1 deliverables.
- WebGPU binding visibility correction, relationship flight rendering/ownership and diagnostic deferral, with corresponding regressions.
- Generated golden excerpts/demo fixtures, deliberate evidence hash `77d88d5b`, architecture/scan/compiler tests, and accumulated audit/QA/roadmap documents.

The tracked diff contains 2,880 insertions and 812 deletions across 59 files. The full archive includes 67 app files, one Rust file, 17 package files, three fixture files and 101 documentation/evidence files. Review baseline and subsequent portable changes separately; current concurrent source edits are not part of this capture.

## Prior verification, with attribution

[Final inspector integration](../inspector-team/final-integration.md) records `pnpm check`, `pnpm test` (1,583 passed, one skipped, including 1,004 web tests), `cargo test --workspace` (81 passed, one ignored), `pnpm build`, and `git diff --check` as passed. Scan/server tests required Homebrew Git first in PATH; the reported final totals include that rerun. The referenced `/tmp/okie-inspector-team/final-build.log` still exists, but is not inside this capture. The manifest has no test-run timestamp or binding between a gate run and these exact file hashes, so these remain prior reported gates rather than newly verified gates for this snapshot.

[Browser acceptance](../inspector-team/browser-acceptance.md) records actual interactions on `/`, `/new`, the published Okie route, and `/?fixture=scan`; a paused guided-story step and nonblank inspector; source loading at the frozen commit; separate diagrams/Main return; selection/list behavior; map/minimap movement; tooltip keyboard/tap/hover; synthetic extraction metadata; and final WebGPU relationship flights. Final trace files supersede earlier slow traces: reported moving intervals are 8.3 ms median, 17.7 ms maximum individually and 17.0 ms maximum for aggregate reveal. This audit checks preservation, not those browser interactions or measurements anew.

## Review and release limits

- The capture is a delta requiring the stated Git HEAD, not a standalone checkout. Its `/tmp` location is temporary; retain the capture somewhere durable before relying on it as the only recovery point. No files were moved or deleted here.
- Archive path inspection found no `.env`, credential-directory, `.git`, `node_modules`, `dist`, WASM `pkg`, Rust `target`, or local scan-store entries. This is not a content-level secret certification; screenshots and trace payloads were not individually inspected for publication. Keep the entire recovery archive out of a release artifact.
- Evidence is substantial: 19 PNGs, 41 JSON files and 13 text files across the capture. `docs/qa/zoom-continuity/coverage.json` alone is 3,976,413 bytes. Earlier failure screenshots, intermediate traces and ad-hoc test-source `.txt` files are legitimate chronology, but candidates for exclusion from a distributable package or consolidation in a later evidence cleanup. Preserve final reports and linked evidence; do not silently delete baseline material. Generated golden source/fixtures are required checked artifacts, unlike ignored build output.
- Prior evidence explicitly limits extraction to a supported TS/JS slice; old published scans lack the new labels. Historical source depends on anonymous public GitHub availability. Adversarial cancellation and sub-120 ms input overlap rely on controlled tests, not browser timing injection. Render traces are not screen recordings.
- New portable code, package contents, installability, clean-machine behavior and public release readiness are not established by this baseline. Follow `CLAUDE.md` gates for the final changes, regenerate any affected pinned fixtures, and explore the running changed flow before opening or closing a PR as required by `AGENTS.md`. No baseline commit or public release is proposed as already completed.
