# Portable atlas v1 integration evidence

Completed locally, September 13, 2026. Final acceptance is recorded in `completion-audit.md`, including user-confirmed import/persistence and automated static/navigation QA. CLA-123 through CLA-128 are complete; CLA-129 and CLA-130 remain outside this slice. Historical progress entries below retain their original check status.

Latest integration pass: all required gates pass against the final implementation (1,625 TypeScript tests; 81 Rust tests and one existing ignored test). The final installed CLI scanned original issue revision `722ea2862304eae579a7b354bc7cfa0697f4e997`, preserving four unique callers and seven `is_valid_color` call sites. `dist/okie-scan-0.1.0.tgz` and `dist/portable-atlas/` are prepared locally. Browser acceptance passed; the final navigation fix is exported in `dist/portable-atlas-reviewed/`. See [final artifact evidence](./final-artifact-evidence.json), [independent review](./final-independent-review.md), and [skill forward test](./skill-forward-test.md).

## Preserved baseline

The pre-portable uncommitted work is preserved separately; see [baseline review](./baseline-review.md). Nothing has been committed, pushed, merged, deployed or published during this slice.

## Verified this pass

- Strict runtime portable import shape checks: architecture build and 7 focused tests passed, including malformed entity fields that previously survived compilation and crashed selection.
- Committed source acquisition: 3 pin tests passed, including raw Git blobs unaffected by export attributes and Git replacement references.
- Independent adapter review verified TypeScript local call evidence with an unavailable external dependency: the call remains and TS2307 is reported.
- Dedicated source tabs: builder browser exploration verified source opening and exact Main camera/selection restoration. Separate imported-bundle browser acceptance is still pending.
- Portable replacement/forget: web typecheck and 24 focused portable/source tests passed; session-only operation no longer requires successful IndexedDB writes. Real browser acceptance is in progress.
- CLI distribution: `pnpm package:cli`, `npm pack`, and installation of the tarball into `/tmp/okie-cli-install-smoke` succeeded. Installed `okie-scan --help` works outside the workspace.
- Installed CLI full scan of a temporary committed TypeScript repository succeeded with one `calls` relationship and full source. A deliberate dirty working-tree replacement was absent from the bundle; committed `greet` and `main` were present. Commit: `272a0322a9542516ec48a8f2b2c8a8b09db49392`. This smoke preceded the latest distribution rebuild and does not verify later CLI edits.
- Static export test passed for relative asset URLs, exact bundled JSON, and nonempty-output protection. `node scripts/build-portable-viewer.mjs` built the actual relocatable viewer successfully. CLI exported it to `/tmp/okie-portable-static/site`; browser acceptance under a subpath is pending.
- Scan, Enrich and Package skills passed the skill-creator frontmatter validator. Behavioral evaluation remains pending.

## Open integration work

The historical findings listed below have since been fixed, regression-tested and reviewed. Only final real-browser acceptance and the resulting completion report/status update remain open.

- The first full Okie scan failed while optional full source attempted to read a directory reference. Fix and rerun with actual Rust call evidence.
- Independent review found Rust coverage included files absent from SCIP and omitted nested-module edges. Fixes and regressions are underway.
- Rebuild/install the final CLI package after remaining edits, evaluate skills against actual commands, and verify accepted offline enrichment.
- Complete static-only and local-import browser acceptance, including source controls and replacement/persistence.
- Regenerate pinned fixtures and verify the deliberate evidence hash after final App changes. Run all required repository gates (`pnpm check`, `pnpm test`, `cargo test --workspace`, `pnpm build`) against the integrated state. Earlier baseline gates do not establish these new features pass.
