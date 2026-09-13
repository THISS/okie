# Operator scans, hierarchical enrichment and publication

Status: implementation started. Portable v1 is on main at `2c7a7e7`; integration is isolated on `codex/operator-workflow`. This plan does not authorize deployment or publication of an atlas.

Linear parent: [CLA-131](https://linear.app/clabrate/issue/CLA-131). Work packages: CLA-132 durable drafts/publication; CLA-133 operator scans; CLA-134 hierarchical enrichment; CLA-135 review UI; CLA-136 observability/readiness; CLA-137 integrated QA/final review. Foundation and operator-access work are underway; dependent packages follow the shared contracts.

## Goal

Deliver an operator-only workflow for public repositories: request a committed scan, observe deterministic analysis and hierarchical enrichment, inspect a draft, retry individual areas, and explicitly publish an immutable atlas version. The public repository URL serves the latest published version. Failed scans, enrichment and unpublished drafts leave it unchanged.

Hosted runs attempt enrichment by default. The operator can publish a deterministic-only or partially enriched draft with clear coverage and gap acknowledgement. Local CLI enrichment stays optional. Ask Atlas, billing/credits, self-service scans, private repositories, premium/public history UI, Python/Go and dependency exploration are separate goals.

## Existing foundations and required changes

Reuse committed acquisition, TypeScript/Rust adapters, portable bundles, evidence validation, enrichment gates, source/Mermaid viewers, GitHub sessions and spend controls. Do not rebuild those systems.

`apps/server/src/scanService.ts` currently publishes deterministic output directly into the public slot and overwrites it after enrichment. `jobs.ts` keeps the queue and progress in memory. GitHub sign-in alone does not establish the new operator permission. Hosted scan options do not yet request full semantic analysis. These are concrete gaps to address.

## Product contract

- Only configured operator identities can start scans, inspect drafts, retry, cancel or publish. Check authorization on every endpoint, including artifact/source reads; hiding controls is insufficient. Recheck public repository eligibility during acquisition. Published viewing remains public.
- Keep source commit, deterministic scan identity, draft revision, enrichment attempt and publication version distinct. Retrying explanations for a commit does not rescan or change its source identity.
- Drafts, assignments, attempts, validation results, events and publication metadata survive server restart. Resume or explicitly mark interrupted work; never silently lose it. Persist non-secret references rather than credentials.
- Store immutable publication artifacts and atomically update the repository's current-version pointer. Pin all resources for a page load to one publication, including neighborhood, source, story, embed and cache identity. Concurrent publishing must detect a stale draft/base instead of overwriting silently.
- Retain internal versions for recovery under a documented, configurable retention policy. Public history browsing and permanent free access to historical versions are not promised. Older version IDs remain stable; draft/version reads obey their access policy.
- Publishing freezes the selected draft revision. Work finishing afterward contributes to a subsequent draft, never to the frozen publication. Keep the existing public URLs compatible and migrate existing published scans without hiding them.

## Hierarchical enrichment

Runtime agents use the existing OpenRouter gateway and configurable model selection. The current code default is `z-ai/glm-5.3-flash`; preserve local/env overrides and record the resolved model per attempt. Coordinator and area-owner roles must not hard-code a vendor or model. Terra builders, Astra low QA and Astra medium reviewers describe the development team building this functionality, not the models used when a customer repository is scanned.

The deterministic scan emits bounded evidence packets and structured explanation templates. A coordinator assigns ownership down the containment tree; area coordinators may delegate further within global depth, concurrency and spend limits. Batch small leaves where useful while recording per-node coverage. This must implement real task dependencies and ownership, not merely issue one flat prompt labelled as a coordinator.

Leaf owners explain their source-backed area. Parent owners synthesize accepted child results and their own evidence only after children reach a terminal state. Cross-area relationships remain available as referenced evidence. Missing children are explicit inputs to partial synthesis. Failed or invalid proposals do not overwrite deterministic facts or previously accepted explanations.

Each node can expose a short contextual summary, role within its parent, important interactions and optional explanatory diagrams. Validate entity/source references and diagram content before accepting it; render inline Mermaid through the existing expandable viewer. Do not require diagrams where prose is clearer. Preserve authored explanations separately from observed facts and record evidence and generation provenance.

Retry targets the selected area, preserves successful sibling work, and records a new attempt/draft revision. Any affected ancestor synthesis becomes stale. Show those ancestors and offer an explicit refresh; do not silently rerun the entire tree or spend on unrelated work. Review remains available with failed, missing or stale explanations.

## Work packages and ownership

1. **Contracts and durable publication foundation.** Coordinator settles IDs, state transitions, API shapes and persistence/migration contracts with a Terra foundation builder. Own new server storage/publication modules and shared contract definitions. Decide storage based on deployment constraints; prefer a transactional local store plus immutable artifact directories for the current single-server setup. Prove restart, atomic publication and compatibility before consumers depend on it.
2. **Operator access and scan execution.** Terra server builder owns operator authorization, `scanService.ts`, queue integration and scan endpoints. Enable full analysis with truthful reduced coverage; document analyzer provisioning. Scan into drafts, preserve committed evidence, handle cancellation/restart without auto-publication. Starts after package 1 contracts.
3. **Hierarchical enrichment and targeted retries.** Terra enrichment builder owns scheduler/assignment modules, prompt/template integration and enrichment adapters. Reuse existing gates. Prove child-before-parent synthesis, bounded recursive delegation, failure isolation, cost limits and scoped retry. Starts after package 1 contracts; runs alongside package 2.
4. **Operator review UI and contextual explanations.** Terra UI builder owns operator screens, API client and inspector explanation rendering. Use agreed API fixtures while backend work proceeds. Provide draft preview, scope progress/errors/usage, source/diagram evidence, retry and stale-parent refresh, publication acknowledgement and clear success/failure states. Shared App integration belongs to this builder only.
5. **Observability and deployment readiness.** Terra integration builder owns instrumentation conventions, durable event queries, operational docs and tooling checks. Show run/scope/attempt IDs, stage timing, queue status, provider/model, token usage, measured versus estimated cost, artifact sizes, coverage and validation failures. Redact secrets; report unknown cost explicitly. Reuse global budgets and add hierarchical enforcement. Integrate instrumentation with owners rather than editing their modules concurrently.
6. **Integration, browser acceptance and final review.** Coordinator integrates commits in dependency order and owns repository gates. Astra low performs real browser QA. Only after builds, tests and browser QA are ready does Astra medium perform independent review. Terra fixes findings, relevant tests and Astra low QA rerun, then Astra medium rechecks the fixes.

Use separate `codex/` worktrees for independent builder packages. Each package has one integration owner; child agents receive bounded tasks and the same file boundaries. The coordinator maintains the dependency graph and Linear status. Do not launch all teams before the shared contracts stabilize. Do not use Astra medium for building or early exploratory review.

## Completion evidence

- Operator and non-operator API/browser checks; draft artifacts cannot be reached through public scan routes.
- Existing public atlas stays unchanged through scan failure, enrichment failure, retry and draft edits. Publication switches every resource consistently; rollback/recovery is operator-only.
- Deterministic-only and partial drafts can be published explicitly; hosted enrichment still starts by default. Invalid source/diagram proposals are rejected with useful diagnostics.
- A fixture tree demonstrates bottom-up synthesis, nested ownership, targeted retry, unchanged sibling outputs and stale ancestor handling. Restart and concurrent publish tests prove durable state and conflict behavior.
- End-to-end TypeScript and Rust public-repo fixtures verify coverage, committed source, enriched node summaries, expanded Mermaid, preview navigation and publication. Exercise Okie web and atlas-protocol. Missing toolchains remain honest reduced coverage.
- Required `pnpm check`, `pnpm test`, `cargo test --workspace`, `pnpm build` and portable regression checks pass. No live paid LLM calls in CI; use controlled fake gateway scenarios. Any live operator smoke run has an explicit bounded budget and its own recorded evidence.
- Astra low explores the running operator and public flows, including failures/retries and existing map/story/source flows; screenshots or recordings show meaningful transitions. Tool limitations are stated, never treated as a pass.
- Astra medium final review has no unresolved blocking findings. Operational docs explain configuration, storage/backup/retention, analyzer prerequisites, restart/recovery and manual publication. Deliver locally reviewable commits; deployment and public publication remain explicit operator actions.
