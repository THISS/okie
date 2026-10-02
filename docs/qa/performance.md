# Atlas performance profiling

Use the local performance panel to find startup and interaction stalls before choosing an optimization. This first slice records browser timings; it does not move work into threads or claim a speed improvement. Worker scheduling, progressive loading and repeated agent reads are follow-up work under CLA-357.

## Enable recording

Append `perf=1` to the page query before loading, for example `/?perf=1` or `/?fixture=stress&perf=1`. Alternatively press Shift+Alt+P to start or stop a session. Late activation cannot reconstruct the application bootstrap; reload with the query flag for that measurement. The panel appears outside the application root, including on `/new` and error pages.

Choose **Export safe timing JSON** before **Stop recording**. Stopping discards the local session and removes observers, the frame loop and refresh timer. The query does not persist a preference. Recording is disabled by default and has no network endpoint or account synchronization.

The export contains only a schema version, capability states, a dropped-sample count and at most 240 samples with fixed metric identifiers and numeric start/duration values. It does not collect resource URLs, event names/targets, question text, source excerpts, credentials, heap dumps or attribution. Review any separate DevTools trace before sharing: those traces can contain information excluded from this export.

## Interpret the measurements

Navigation duration is a browser document timing. First paint, first contentful paint and largest contentful paint are timestamps since navigation. They do not prove the atlas is usable. Bootstrap start/completion are application timestamps; completion means the bootstrap requested a render, rather than the renderer finished a frame or the inspector is ready.

Interaction durations are sampled browser Event Timing entries, not a complete INP score. Long tasks are browser-reported main-thread work. Frame stalls are gaps above 50 milliseconds in visible-page animation callbacks, not renderer FPS; hidden-page time is excluded. The diagnostic panel and export themselves add work, so use the same instrumentation setting when comparing runs, then verify improvements with recording disabled too.

A capability marked unsupported or failed has no trustworthy zero result. An available capability with no samples means no matching entry was retained. Old samples roll out of the bounded buffer; inspect the dropped count and export short scenarios separately. The report has no event names, so keep a separate scenario note to identify which actions you performed.

## Repeatable browser scenarios

Use a production build for timing comparisons. Dev mode, HMR and build activity can distort results. Record the commit, browser version, operating system, machine class, renderer backend, viewport, fixture/publication pin, network/CPU throttling, cache state, run count and instrumentation setting alongside results. Keep the window visible and close unrelated workloads. Use the same environment for before/after comparisons.

Run golden, deterministic stress and a pinned published large atlas separately. For each dataset:

1. Perform a cold load with HTTP cache disabled. Record paint and bootstrap timestamps, then manually verify a rendered map and populated inspector. Time to a usable atlas remains a separate measurement until an explicit readiness hook is implemented.
2. Repeat with a warm cache. Do not combine cold and warm samples. For public data, distinguish browser HTTP cache from server/index cache.
3. Select nodes, type a symbol search, open source/evidence, pan/zoom and play a guided story while data arrives. Jump to a known story step and await the paused playback state for correctness checks; separately exercise continuous playback for responsiveness.
4. Exercise `/new`, error/recovery routes and rapid navigation between nodes/scopes. Record frame stalls, long-task durations and sampled interaction durations. Avoid live scans or model calls in automated runs.
5. Export each short scenario and repeat enough times to report run count, median and p95 with an honest sample-size limit. Do not adopt a universal device-independent budget from a single run.

Browser DevTools can provide the missing phase breakdown: fetch/transfer, decode/parse, normalize/index, compile/layout, renderer setup/upload and first usable frame. Measure worker processing and message-transfer cost explicitly when work moves off the main thread. Moving expensive work to a worker does not remove its cost or guarantee prompt cancellation.

## Agent read benchmarks

The excerpt-heavy edge fixture is a correctness test: it creates/stores a snapshot above 16 MiB with 20,000 entities and performs two complete reads. Its timeout is a runner safety bound, not an API latency target. An isolated local run took about 2 seconds before tuning; that result includes setup and cannot isolate parser performance.

Benchmark cold and repeated version-pinned reads separately under CLA-361. Record raw/projected bytes, R2 fetch duration, parse/projection CPU and wall time, query time, peak memory and concurrency. Compare bounded caches or prebuilt public indexes only after measuring those costs; preserve complete graph coverage, public-field allowlists, immutable version pins and evidence honesty.

## Delivery order

CLA-358 supplies instrumentation and reproducible scenarios. CLA-359 schedules measured expensive browser processing in cancellable workers. CLA-360 prioritizes the first useful view and selected evidence while limiting speculative background loading. CLA-361 measures and optimizes repeated server/edge reads. Each optimization needs a before/after comparison and a regression check tied to the measured behavior.
