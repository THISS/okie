# Jev block planner: browser QA

Date: 2026-09-29. Tree: uncommitted `okie-work-4`. Web on 4196, scan server on 4197 (`apps/server/dist`, rebuilt).
Scan root: a scratch APFS clone of `okie-next/fixtures/scan/operator-v1`. Atlas: `/r/THISS/okie`, publication `publication-aaa7ff3b…`.
Jev spend: 10 live calls (9 planned, 1 `invalid-response`), about $0.001. The invalid-key run spent nothing.

## Findings, ranked

1. **Bug: `?planner=jev` never applies a plan, but it still spends.** On boot the app rewrites the URL (`nav=1&repo=…`) and drops `planner`. `blockPlannerFlagEnabled()` reads `window.location.search` on every render, so the flag turns off before the answer arrives. The dev note goes `Order: default (Jev plan pending)` → `Order: default`. The `POST /api/block-plan` still returns `planned`, and the plan is written to `block-plans/`.
   Repro: clear `okie.blockPlanner` in localStorage, open `/r/THISS/okie?planner=jev&sel=container%3Apackages-scan&detail=context`, turn on dev mode, wait 3s. See `bug-query-flag-dropped.png`. The localStorage flag works.
2. **Key points get demoted and the reorder jumps visibly.** On 6 of the 9 containers, Jev puts a one-line block (`relations:parent`, "okie · Software system") and/or the diagram above "Worth a look". On @okie/scan, key points drop to 7th, below parent, dependents, dependencies and related. When the order switches (~0.5s after an in-app click), the key points the reader has started on jump below the fold. See `switch-engine-before-after.png`.
3. **The switch takes ~1.4s on a cold page load, not ≤1s.** The network request takes 35–45 ms on a server cache hit and ~450–550 ms on a live Jev call. But on a cold load the re-compose lands ~1.3–1.4s after the first render, because the main thread is busy booting the canvas. When you click a node inside the app, the switch lands in ~0.45–0.6s.
4. **One intermittent `invalid-response` from Jev** (@okie/scene-compiler, first call). The client fell back cleanly to `Order: default (Jev invalid-response)`. After a reload, the retry planned fine. The server logs nothing when this happens, so operators can't see the failure rate. This is minor.
5. **Dev-only layout shift.** The "Order: …" note is added about 1.2s after the first paint on a cold load (`useAtlasDevMode` observes `data-dev-mode`), which pushes the summary down one line. Readers never see this.

## Verified OK

- **Flag off (default):** system, @okie/web, @okie/scan and atlas-protocol all show the default order. No `/api/block-plan` request is made (checked with a fetch hook and resource timing). With dev mode on, the note reads `Order: default`.
- **Flag on (localStorage):** the default order renders first, then the Jev order. With dev mode on, the note reads `Order: Jev planner`, and its `title` tooltip lists each block's reason ("Later (73%): …").
- **Readers:** with dev mode off there is no note, no reason text and no reason tooltips in the DOM.
- **Cache:** system → @okie/web → okie → @okie/web → okie made 2 requests in total. Reloads get server cache hits (`replayed: true`, ~40 ms).
- **Server flag off:** the response is `{state:"unavailable",reason:"disabled"}`, the order is the default, and the note reads `Order: default (Jev disabled)`. It is asked once per node per session.
- **`JEV_API=invalid`:** uncached nodes (atlas-wasm) get `provider-failure`, and the note reads `Order: default (Jev provider-failure)`. Plans already on disk are still served (@okie/web). The key did not appear in the logs.
- **Console:** there are no new errors. The only errors are two `enrichment-report.json` / `enrichment-status.json` 404s from the fixture, and they happen with the planner off as well.

## Qualitative read (default vs Jev)

- **okie (system):** Jev moves the diagram above key points. The diagram is tiny at inspector width, so key points were the better second block. Slightly worse.
- **@okie/web:** Jev orders it diagram, parent, key points. Parent is one line of no-news, and key points (the best content) drop to 4th. Worse.
- **@okie/scan:** Jev puts four relation lists ahead of key points (7th). Clearly worse.
- **atlas-protocol:** Jev orders it diagram, key points, and sinks related and dependents. This is the only case that reads about as well as the default, or marginally better.
- **@okie/server, atlas-engine, atlas-gpu:** Jev puts parent (and dependents on engine) above key points. Worse.

On balance, the default order is easier to take in. Jev's one consistent win is sinking the evidence and duplicate relation lists. It also keeps promoting `relations:parent` even when its chosen level is "Later" (for example 38% on @okie/web), probably because the probability spread pulls its expected rank up.

## Screenshots (this folder)

- Side by side (default | Jev, reader mode): `side-by-side-{system,web,scan,protocol}.png`. Singles are `off-*.png` and `jev-*.png`.
- Dev mode, with the note: `jev-{system,web,scan,protocol,server}-dev.png` and `off-web-devmode.png`.
- The switch: `switch-engine-a-default.png`, `switch-engine-b-jev.png` and `switch-engine-before-after.png`.
- Server flag off: `server-off-web-dev.png`. Invalid key: `badkey-wasm-dev.png` (fallback) and `badkey-web-cached-dev.png` (a cached plan still served).
- The `?planner=jev` bug: `bug-query-flag-dropped.png`.

## r2: recheck of the fixes (2026-09-29)

Setup: server dist rebuilt, a fresh scratch clone of `operator-v1` (`qa-planner-r2/`), ports 4196/4197, and `OKIE_JEV_PLANNER_MAX_DOLLARS=0.02`.
Jev spend: 2 live calls (@okie/web and okie), about $0.0002.

| Check | Result |
|---|---|
| Without `OKIE_LLM_GLOBAL_MAX_DOLLARS` | Pass. The server answers `unavailable: no-global-cap`, and the dev note reads `Order: default (Jev no-global-cap)` (`r2-no-global-cap-dev.png`). |
| Request shape | Pass. The client sends only `{id, type}` per candidate, and `node` is just `{kind}`. There are no previews and no sizes. |
| `?planner=jev`, localStorage cleared | Pass. The flag survives the boot URL rewrite, and a plan is fetched and applied. |
| Cold node | Pass. The first view stays in the default order with no reorder after paint (one order state throughout). The note goes `…(Jev plan pending)` → `Order: default (Jev plan cached for next visit)` (`r2-web-cold-dev.png`). |
| Revisit | Pass. After web → okie → web, the Jev order is in the first paint of @okie/web (~80 ms after the click), with no jump and no second request. The note reads `Order: Jev planner` and the reasons tooltip is present (`r2-web-revisit-dev.png`, `r2-system-revisit-dev.png`). |
| Current publication only | Pass, observed. A POST with a made-up `versionId` returns `404 {"error":"Not the current publication of a published scan."}`. |
| Readers (dev mode off) | Pass. There is no note, no reason text and no reason tooltips, whether the page is cold (default order) or revisited (Jev order) (`r2-web-reader.png`, `r2-web-reader-revisit.png`). |

### r2 findings

1. **The global cap is a durable, lifetime ledger that is shared with operator enrichment.** The `operator-v1` fixture's `state.json` already records $0.703 of settled `global-operator-enrichment` spend. With `OKIE_LLM_GLOBAL_MAX_DOLLARS=0.02` (or 0.05), every planner request answers `global-budget` before it reaches Jev (`r2-global-budget-dev.png`). For this run I set the global cap to 0.75 and let the planner cap (0.02) bind. The fallback is clean, but the "e.g. 0.05" recipe does nothing against this fixture, and operations.md should say the cap is cumulative across restarts and across operator runs.
2. **Readers only see the Jev order on their second visit to a node in a session.** This is by design: the client cache lives per page load. After a full reload, the server has the plan (a disk/memory hit, no spend), but the first view still shows the default order and "cached for next visit". So most first-time readers never see the Jev order. That is fine for a pilot, but worth knowing when judging impact.
3. There are no new console errors. The only errors are the same two fixture `enrichment-*.json` 404s as in r1.
