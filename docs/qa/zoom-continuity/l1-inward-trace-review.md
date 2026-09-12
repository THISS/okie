# Independent L1 inward capture review

Reviewed 2026-09-09 from `/tmp/okie-goal-l1-inward.json` and `/tmp/okie-goal-l1-inward.mov`. This is an offline evidence review, not a browser acceptance run or a smoothness pass.

## Confirmed trace finding

The trace contains 18 wheel input samples and 232 frame samples, with `truncated: false` and `droppedSamples: 0`. Its backend is `canvas2d-preview`, snapshot is `snapshot:okie:722ea2862304`, and scene is `scan:repo:okie:c4`. Every input has `deltaY = -30.485000610351562`, `deltaX = 0`, pixel delta mode, and no modifiers. No contrary-direction wheel input is recorded.

Exactly one adjacent pair of recorded frame samples decreases camera zoom:

| Sequence | timeMs | Camera zoom | Camera x | Camera y |
| --- | ---: | ---: | ---: | ---: |
| 230 | 90082.8 | 1.4968528420290035 | -226.86650437623462 | -360.99622269777115 |
| 232 | 90132.798 | 1.5526246157842183 | -223.5428285625528 | -360.9602262088143 |
| 233 | 90149.6 | 1.4968528420290035 | -226.86650437623462 | -360.99622269777115 |
| 234 | 90199.5 | 1.5526246157842183 | -223.5428285625528 | -360.9602262088143 |

Sequence 233 returns exactly to the preceding camera values, including both coordinates. The zoom decrease is approximately 3.5921%, over 16.802 ms between samples; the next recorded sample returns to the larger zoom after 49.9 ms. All these frames report projection progress 1 and the same settled projection ID, `semantic-path:context:system:okie:settled`. Thus a sampled camera reversal is confirmed without a recorded direction reversal or projection-ID change. The trace alone does not identify the code path that wrote the old camera, prove a stale React echo, or establish how long a physical display presented each state.

The final input is sequence 231 at timeMs 90079.19999980927. Its timestamp precedes sequence 230's frame timestamp even though its sequence follows it. Sequence order and timestamp order are therefore not globally identical across sample kinds; do not infer exact input-to-paint latency merely by subtracting neighboring mixed-kind entries.

## Input cadence limits

Inputs span 76918.19999980927 to 90079.19999980927 (13.161 seconds). Consecutive gaps, in milliseconds, are approximately:

`305.7, 236.1, 205.3, 1102.1, 388.3, 341.5, 292.8, 281.0, 202.2, 362.9, 303.8, 7627.1, 362.9, 358.2, 155.4, 348.5, 287.2`.

This is evidence of repeated same-direction inputs in separated bursts, including a 7.627-second pause. It is not evidence of uninterrupted trackpad input, a complete outward/inward matrix, or continuous traversal of every semantic level. Trace recording started at timeMs 38237.7, well before its first retained sample; that start field must not be used as the beginning of visible wheel activity.

## Video scope and synchronization

`ffprobe` reports a 1966×1742 H.264 ReplayKit movie, duration 30.018333 seconds, 1707 frames, and average frame rate about 56.84 fps. Its nominal `r_frame_rate` is 240 fps; that field must not be presented as the actual constant capture rate. Both stream and format creation time are `2026-09-09T13:47:09.000000Z`.

Decoded contact sheets covering the movie at three-second intervals and 24–25.5 seconds at eight samples per second show the Okie canvas, the populated Overview inspector, level controls, and the bottom-right minimap. The app is visible and the framing is usable for inspecting that canvas and minimap, although peripheral application content is clipped at the recording edges. The inspector displays 3121 entities. That label does not establish that every entity was rendered or visually checked. Minimap visibility likewise does not prove minimap continuity.

Using trace `timeOrigin = 1788961563477.2`, the first input has wall time 13:47:20.3954 UTC and the reversal sample has wall time 13:47:33.6268 UTC. Subtracting the movie creation time suggests approximately 11.395 and 24.627 seconds into the movie. These are candidate offsets only: the creation timestamp has whole-second precision, and there is no verified shared sync marker establishing that metadata creation time equals presentation timestamp zero. The eight-fps contact sheet cannot resolve or certify the short reversal. No exact video frame is attributed to trace sequence 233 in this review.

## Result

The trace independently confirms a brief return to an earlier camera during same-direction wheel input. The recording is usable visual evidence of the application and minimap, but exact temporal alignment and a code-level cause remain unproven here. This capture does not justify a Figma-like smoothness pass across 3121 nodes or all zoom levels. Recheck the same interaction after the fix with synchronized recording and trace evidence, including minimap behavior and sustained inward/outward gestures.

## After-fix comparison

A second independent offline review examined `/tmp/okie-goal-l1-inward-after.json` and `/tmp/okie-goal-l1-inward-after.mov`. It confirms the parent's narrow numerical observation:

| Evidence | Before | After |
| --- | ---: | ---: |
| Wheel samples | 18 | 18 |
| Frame samples | 232 | 234 |
| Recorded zoom decreases | 1 | 0 |
| First sampled zoom | 0.8336453448652353 | 0.8336453448652353 |
| Final sampled zoom | 1.5526246157842183 | 1.5526246157842183 |
| Dropped samples | 0 | 0 |
| Truncated | false | false |

The after trace uses the same snapshot, scene and `canvas2d-preview` backend. All 18 inputs again have deltaY -30.485000610351562 and pointer location (450, 384). Recorded zoom is nondecreasing throughout this capture. Final camera coordinates differ from before: after is (-220.32653510735395, -357.6099038224616), before is (-223.5428285625528, -360.9602262088143). Equal initial/final zoom does not make these pixel-identical replays.

The projection follows the same context-base → context/container transition → settled system path, with the same recorded progress values from 0 through approximately 0.9773 and then 1. In the after trace the transition ID first appears at timeMs 41549.1 (sequence 90), and the settled system ID appears at 45349.2 (sequence 222). There is no sampled projection-progress reversal within that transition. These state observations do not measure visual interpolation quality.

After input gaps, in milliseconds, are approximately:

`1196.4, 1179.8, 393.6, 251.2, 205.0, 333.8, 431.2, 347.5, 325.7, 325.1, 201.7, 1159.6, 364.3, 975.2, 477.8, 194.5, 322.3`.

The input span is 8.685 seconds. This is still a burst/pause interaction, with three gaps exceeding one second, not continuous physical input. The before/after cadence differs materially. The largest after inter-frame-sample gap is 908.3 ms; because trace sampling may be event-driven, this alone is not a measured display stall or a frame-rate claim.

The after movie is 1966×1742, 30.008333 seconds, 1711 frames, average approximately 56.99 fps, with creation time 13:54:50 UTC. Its decoded three-second contact sheet shows the L1 software-system card transitioning to visible L2 container cards, with the Overview inspector populated and the minimap remaining inside the captured area. The minimap layout and highlighted viewport visibly change between sampled states. Sparse stills cannot prove that those changes are smooth or perfectly synchronized with the main canvas.

Trace timeOrigin plus its first input gives 13:55:04.2847 UTC; its last frame gives 13:55:13.2843 UTC. Relative to movie creation time these suggest approximately 14.285–23.284 seconds into the movie, consistent with its broad visible action interval. As before, metadata is not a verified synchronization marker; no frame-accurate alignment is claimed.

**Limited result:** the previously observed sampled camera reversal does not recur in this after capture. That supports the fix on this specific L1-to-L2 inward path. It does not establish the code-level cause of the original sample, a continuous-input smoothness pass, outward behavior, alternate branches, all 3121 entities, or Figma-like feel including minimap continuity. Those remain separate acceptance work.

## After-fix outward capture

`/tmp/okie-goal-l1-outward-after.json` independently confirms 18 positive-delta wheel samples (`deltaY = 30.485000610351562`) and 199 frame samples, with zero dropped samples and no truncation. The backend/snapshot/scene match the inward captures. Zoom decreases from 1.4968528420290035 to 0.8037000000000003 with **zero sampled zoom increases**. Projection IDs proceed from settled system, through the context/container transition, to settled context base.

Input gaps are approximately `336.8, 362.9, 193.6, 314.3, 330.6, 306.6, 220.9, 536.1, 413.0, 237.3, 274.7, 208.8, 308.8, 460.1, 296.5, 229.6, 474.2` milliseconds. These are discrete repeated outward inputs; no claim of continuous physical input is supported.

The companion movie is 1966×1742, 25.03 seconds, 1423 frames (average approximately 56.81 fps), creation time 13:56:04 UTC. Decoded three-second samples show L2 container cards returning to the L1 software-system card, with the minimap within the recording and the Overview inspector populated. A diagnostics panel appears near the end. Empty cells at the end of the generated 5×2 contact sheet are padding for a movie shorter than 30 seconds, not evidence of a black application frame. Exact trace/video synchronization was not established.

This adds narrow outward direction evidence for the same L1/L2 path. Together the two after traces have no zoom reversal against their respective recorded input direction. Neither trace nor sparse video stills establish perceptual smoothness, complete branch/entity coverage, or minimap frame-by-frame continuity.

## Dense web inward capture: L2 to L3

An independent file-only review of `/tmp/okie-goal-web-inward-after.json` confirms 30 inward wheel samples and 252 frame samples, no drops, and no truncation. Every input has deltaY -30.485000610351562 at pointer (330, 282). Sampled zoom rises from 1.2862016021312577 to 3.715716036501138 with **zero decreases**. The same snapshot/scene/backend identifiers remain in use.

Projection IDs proceed from settled system (first frame sequence 1, timeMs 193969.8), to the `container:apps-web:container:component` transition (sequence 121, timeMs 202016.2), to settled `system:okie>container:apps-web` (sequence 268, timeMs 209395). This is evidence of the web L2-to-L3 path, not evidence of every dense branch.

The camera moves substantially during the transition. For example, sequences 254→256 change x from 372.72278417981886 to 416.6413466365898 and y from -262.4097066498766 to -250.04719603065004 while zoom increases from 3.4535662752965948 to 3.5822439325427102. Their frame timestamps are 8.4 ms apart. Similar roughly 44-world-unit x movements occur earlier. These values warrant evaluating the intended semantic camera path, but do not by themselves prove an anchor glitch: geometry is also changing during the semantic transition, and trace samples do not establish display presentation timing. This review does not label those movements a defect without the camera/geometry contract.

Inputs remain spaced events: gaps range from 169.0 to 1353.2 ms, including three over one second. Thus the no-reversal finding is not a continuous-gesture or perceptual smoothness pass.

The companion movie is 1966×1742, 30.006667 seconds, 1696 frames, average approximately 56.49 fps, creation time 13:57:34 UTC. Three-second decoded samples show the selected web container expanding, component cards appearing, and the L3 level becoming active. A separately decoded frame at video time 26 seconds confirms that the main canvas has large component cards while the bottom-right minimap packs the component grid into a small central group, surrounded by faint broader-context boxes. The group is approximately 30–40 CSS pixels wide when accounting for the capture's 2× scale; this is a visual estimate, not a DOM measurement. Most of the minimap's interior is consequently unused for the currently visible component group. The minimap is fully inside the recording, so this observation is not caused by cropping it away.

The selected web container's Details inspector remains populated while the canvas is at L3; selection persistence is not itself an error. No exact trace/video frame alignment or anchor-error measurement was established. **The dense web capture passes only the sampled zoom-direction check. Its cramped minimap component group remains a concrete visual concern, and this review does not grant a Figma-like smoothness pass.**

## Protocol inward capture: partial L2-to-L3 transition

File-only review of `/tmp/okie-goal-protocol-inward-after.json` confirms 30 inward wheel samples (`deltaY = -30.485000610351562`), 254 frame samples, no drops, no truncation, and zero sampled zoom decreases. Zoom spans 1.2862016021312577–3.715716036501138, with the same snapshot/scene/backend as the other captures.

Unlike web, this capture **does not reach settled L3**. The settled-system projection persists until sequence 252 at timeMs 68431.4, zoom 3.5822439325427102, where the protocol container/component transition appears with progress 0.07305073076771834. At sequence 262, timeMs 68804.8, zoom 3.715716036501138, progress reaches 0.14610146153543666. That value and transition ID persist through the final frame at 69023.3. Only about 219 ms of trace follows the final progress change. The final wheel input is at 68778. This proves an incomplete captured transition; it does not prove a stuck animation, since a semantic transition can depend on further zoom input. Matching web's terminal zoom does not imply matching semantic progress across differently sized branches.

Input gaps range from 172.9 to 2345.7 ms, including 1143.6, 2345.7 and 1036.0 ms pauses. The inputs span 14.7414 seconds and again are separated repeated events, not uninterrupted physical input.

The companion movie is 1966×1742, 30.006667 seconds, 1692 frames (average approximately 56.35 fps), creation time 13:59:30 UTC. Decoded three-second samples show the protocol container enlarging and faint component content emerging within its still-prominent rounded outline near the end. L2 remains highlighted in those late sampled frames; the inspector remains populated for atlas-protocol. The minimap stays within the recording and retains broad context with a highlighted viewport. This partial-transition recording cannot assess the final protocol L3 minimap scale or readability. Exact trace/video synchronization and camera-anchor correctness were not established.

**Limited result:** sampled inward zoom direction is consistent, but settled protocol L3 coverage remains missing. Continue inward far enough to settle before judging this branch's final scene or minimap; do not record this as a completed L2-to-L3 acceptance pass.

## Protocol full transition candidate: visual discontinuity remains

`/tmp/okie-goal-protocol-full-after.json` contains 45 wheel inputs and 344 frames, no drops or truncation, and zero sampled zoom decreases over 1.2862016021312577–6.4321021454687415. Input gaps range from 137.1 to 1948.1 ms. The protocol component transition begins at timeMs 66561.6, zoom 3.5822439325427102, and reaches settled L3 at 71111.5, zoom 5.763560409402874. The final frame is at 72401.9. This resolves the previous capture's missing settled-L3 evidence.

However, direct decoded video evidence reveals a **remaining visual discontinuity** that the scalar zoom test misses. The 40.023333-second companion movie (creation time 14:02:14 UTC) was sampled at three frames per second from video time 20 through 24 seconds. Across those ordered samples, the protocol outline/component grid repeatedly changes between a central position beneath the pointer and a position largely above the viewport. For example, the approximately 20.667-second sampled state has the selected protocol card centered; the approximately 21.333-second state places its lower outline near the top of the canvas, leaving a large dark area under the pointer; the approximately 21.667-second state shows it central again. The approximately 22.333-second state again has the protocol content largely above the pointer before later samples return the visible component grid. Neighboring context boxes and minimap geometry change with these shifts. Sampling does not establish each jump's exact onset or duration, but the repeated large position changes are present in the video itself. A monotonic zoom scalar therefore cannot support a motion pass. No exact trace timestamp is assigned to these video samples, and the responsible geometry/camera code path is not proven by this review.

A separately decoded endpoint at video time 32 seconds shows L3 active and five protocol component cells filling a substantial portion of the minimap. This is visibly more useful than the earlier tiny central component group. The main canvas shows large component cards and the inspector remains populated. One separate layout concern is visible: the floating Guided tours chip overlaps the minimap's lower-left portion, obscuring some map content. This overlap is in the recorded app and is not recording-edge clipping.

**Result:** settled L3 and improved endpoint minimap scale are confirmed, but the repeated transitional position shifts prevent a visual continuity pass. Investigate synchronized camera/projection geometry and repeat motion review after correction. This review supplies visual evidence of the issue, not a quantified pointer-anchor error or a claim of full branch coverage.

### Defect clip and trace pairing candidates

The playable `/tmp/okie-protocol-pairing-defect.mp4` extracts source video time 20–24 seconds with presentation cadence preserved (`-fps_mode passthrough`, H.264 re-encode, no fps filter). It retains consecutive source frames rather than the sparse contact-sheet sampling used above.

A search of adjacent protocol frame samples found no x/y movement exceeding five world units at unchanged zoom. Thus the trace does not support a simple alternating-camera-values explanation. It does show camera/projection changes recorded separately:

| Sequence | timeMs | Camera x | Camera y | Zoom | Projection progress |
| --- | ---: | ---: | ---: | ---: | ---: |
| 330 | 70619.8 | -192.575985 | 513.585577 | 5.356932 | 0.876609 |
| 332 | 70628.2 | -195.992632 | 581.884550 | 5.556528 | 0.876609 |
| 333 | 70634.8 | -195.992632 | 581.884550 | 5.556528 | 0.949659 |

Sequence 332 has the new camera with the preceding progress; sequence 333 changes progress with exactly the same camera 6.6 ms later. Similarly, sequences 341/342 have zoom 5.763560 with progress 0.949659 before sequence 343 reports settled progress 1. These are useful camera/projection pairing candidates to inspect in code, not proof that those states correspond to specific displayed video frames. The minimap/Guided tours overlap remains a separate layout issue.

### Web minimap candidate follow-up

`/tmp/okie-goal-web-minimap-after.mov` was decoded across the movie at three-second intervals and over video time 12–16 seconds at three samples per second. Its endpoint shows the dense component grid occupying substantially more minimap area than the earlier tiny central group. The Guided tours overlap remains visible. The closer motion samples show changing component layout and scale, but this review does not confidently identify the same large repeated above-viewport excursion seen in protocol; absence from sparse samples is not proof of absence in the movie.

The web trace likewise has no adjacent x/y movement above five world units at unchanged zoom. Candidate sequences 225→227 change camera from (372.722784, -262.409707, zoom 3.453566) to (416.641347, -250.047196, zoom 3.582244) while both retain progress 0.876609. This supports inspecting the same camera/projection update boundary on web. Improved minimap footprint is confirmed visually, while atomic pairing, pointer anchoring, and full perceptual smoothness remain unverified.

## Atomic-update protocol repeat

`/tmp/okie-goal-protocol-atomic-after.json` independently confirms 45 inward inputs, 380 frame samples, zero dropped trace samples, no truncation, and zero sampled zoom decreases over 1.2862016021312577–6.4321021454687415. Searching adjacent frames for a changed camera with unchanged fractional projection progress finds zero candidates of the earlier kind. Input gaps remain 112.2–1188.3 ms, so this remains a repeated-event capture rather than continuous physical input.

The new movie was inspected across its 40.006667 seconds and more closely through video time 18–24 seconds at three decoded samples per second. In those samples the protocol card stays central as it expands and its component grid emerges; the previously observed repeated movement far above the viewport does **not recur in the inspected samples**. This is a concrete visual improvement alongside the eliminated trace pairing candidates. The minimap is now above the floating controls, its five-cell endpoint is usefully sized, and the earlier Guided tours overlap is no longer visible. The populated inspector and active L3 control remain visible at the endpoint.

`/tmp/okie-protocol-atomic-after-clip.mp4` preserves consecutive source frames for video time 18–24 seconds without fps resampling. This is a comparable transition-stage clip, not a timestamp-synchronized replay of the older 20–24-second clip. The source reports 2252 container frames and approximately 56.26 fps; ffprobe decoded 2251 timestamped frames. Decoded presentation gaps have median 16.667 ms and maximum 33.334 ms, with none over 50 ms. The active 18–24-second window likewise has no gap over 33.334 ms. These figures characterize the encoded movie cadence; they do not prove the producer dropped no frames or that the application rendered every display refresh.

One trace detail remains worth distinguishing from the earlier defect: sequence 200 at timeMs 50890.4 reports transition progress 0; sequence 201 at 50914.4 returns to settled-system progress 1 with exactly the same camera; sequence 210 at 51089.2 enters the transition at progress 0.07305. Because the zero-progress transition can be geometrically equivalent to its settled source, this ID bounce is not by itself a demonstrated visual regression. Settled protocol L3 is reached at 55314.1.

**Limited result:** the specific large protocol excursion and minimap overlap are absent from the inspected repeat samples, and the camera-before-progress candidate pattern is absent from the trace. This supports the targeted fix. It is not a blanket Figma-like smoothness certification: frame-accurate pointer-anchor measurement, uninterrupted input, outward transition, other branches, and all-entity coverage remain separate evidence requirements.

## Final checked web atomic repeat

Independent inspection of `/tmp/okie-goal-web-atomic-after.json` confirms 30 inward inputs, 226 frames, no trace drops or truncation, zero zoom decreases, and zero changed-camera/unchanged-fractional-progress candidates. It reaches settled `system:okie>container:apps-web`, progress 1, over zoom 1.2862016021312577–3.715716036501138. Input gaps are 177.2–1403.4 ms.

The companion movie was decoded across its duration at three-second intervals and through video time 13–18 seconds at three samples per second. Those closer samples show the web container enlarging, component content becoming visible, and the component grid expanding around the pointer. No repeated large offscreen/return excursion is evident in the inspected sequence. This supports the targeted atomic-update improvement; sparse decoded inspection does not quantify subframe anchoring or certify the absence of every short transient.

Compared with the earlier web capture, the endpoint minimap now uses most of its available width for the dense component grid rather than a tiny central cluster. Its viewport indicator remains visible and it sits above the floating controls, with no Guided tours overlap visible. The Details inspector remains populated. No new concrete visual defect was identified in this inspection. This is a bounded inward web result, not a complete gesture, branch, backend, or all-entity acceptance pass.

## Web outward atomic repeat

`/tmp/okie-goal-web-outward-atomic.json` confirms 30 positive-delta inputs (`deltaY = 30.485000610351562`), 327 frames, no drops or truncation, zero contrary zoom increases, and zero changed-camera/unchanged-fractional-progress candidates. Zoom decreases from 3.5822439325427102 to 1.2400000000000007 and the endpoint is settled system/context-container view, progress 1. Input gaps are 174.6–835.0 ms.

The movie was inspected across its duration at three-second intervals and more closely at three decoded samples per second through video time 7–13 seconds. The visible L3 component grid contracts and fades back into the web container, ending with L2 active. The ordered sampled sequence shows no repeated large position excursion. Minimap content changes from the dense component grid to the container context, with its viewport indicator remaining visible and its box above the floating controls. Because fitting bounds change with semantic content, “monotonic minimap scale” is not an established invariant; no quantitative monotonicity or frame-accurate viewport alignment is claimed. No new concrete defect was identified in the inspected reverse transition. The Details inspector remains populated, and a diagnostics overlay appears later in the recording.

This adds a bounded web L3-to-L2 outward result to the checked inward result. It does not establish continuous physical gesture quality or complete matrix coverage.

## L4 arrival before correction

Independent review of `/tmp/okie-goal-web-l4-before.json` confirms 30 inputs and 349 frame samples. A large same-direction camera discontinuity occurs between sequences 232 and 233:

| Sequence | timeMs | x | y | zoom | semanticRevision |
| --- | ---: | ---: | ---: | ---: | ---: |
| 232 | 117273.3 | 464.903347 | -252.777111 | 7.723074 | 187 |
| 233 | 117280.2 | 497.868225 | -99.108421 | 13.960000 | 0 |

Both frames report the same settled hosted-atlas component path and projection progress 1. Zoom increases approximately 80.76% in 6.9 ms between recorded samples, far above the ordinary approximately 3.73% step. The semantic revision resets at the same boundary. The numeric evidence establishes a camera discontinuity at arrival; the specific code cause requires inspection. Zero contrary-direction zoom or fractional-progress split candidates would miss it.

The 30.025-second companion movie was decoded across its duration and more closely at three samples per second over video time 13–17 seconds. It shows the component card, an almost empty canvas state near the transition, a briefly visible grid of L4 source nodes, and then a much larger `DOGFOOD_ATLAS_OWNER` node occupying most of the canvas. The endpoint has L4 active and a populated inspector. The minimap is above controls but changes from the source-node grid to a viewport occupying much of its area as the camera jumps. This supports a visible arrival reframe rather than a perceptual continuity pass. The nearly empty sampled state is an additional observed transition symptom; its duration and exact cause are not measured here.

`/tmp/okie-web-l4-arrival-defect.mp4` preserves consecutive source frames from video time 13–17 seconds without fps resampling. Trace/video exact synchronization remains unproven, so the sample sequence numbers above are not assigned to exact movie frames. Correct the arrival behavior and repeat L4 review before accepting this path.

## Fixture bundle L4 bridge capture

`/tmp/okie-goal-fixturebundle-l4-after.json` confirms 40 inward inputs, 371 frames, no trace drops or truncation, and zero zoom decreases. Zoom spans 3.8541653363477075–16.05230571592096. Its largest adjacent-frame increase is 3.7259356557%, consistent with the regular wheel increment rather than the earlier 80.76% hosted-atlas arrival jump. The endpoint is the settled fixture-bundle component/source path, progress 1.

The movie was decoded across its duration and more closely at three samples per second through video time 12–18 seconds. The selected fixture-bundle card enlarges and source cards appear within it; later samples show `getActiveScanFixture` and an active L4 control. No comparable sudden oversized-node arrival reframe is evident in these sampled states. The main content remains near the lower-left pointer position, leaving substantial empty space above, which is consistent with this capture's off-center zoom target rather than proof of a camera defect. The minimap changes from a small context/viewport representation to the source-node layout and remains above the floating controls. Its changing fit is visible; exact frame-by-frame viewport alignment and continuous fit interpolation are not established by this inspection.

`/tmp/okie-fixturebundle-l4-after-clip.mp4` preserves consecutive source frames from video time 12–19 seconds without fps resampling. This is **a different file from the hosted-atlas before capture**. It supports the bridge behavior on fixtureBundle, but cannot establish a matched same-file before/after fix for hostedAtlas. No full perceptual or all-file pass is claimed.

### Separate failed Show on map setup

`/tmp/okie-goal-web-l4-morph-after.json` is not valid L4 acceptance evidence: its 40 inputs and 435 frames end at settled web-container L3, zoom 16.052288593184187, not a component/source path. A decoded movie frame at time 27 seconds independently shows a blank main canvas, L3 active, hostedAtlas selected in the populated inspector, and the component minimap visible without an obvious viewport rectangle. This is a separate baseline/navigation failure requiring investigation, not a successful L4 arrival.

The parent identifies the preceding setup as Show on map restoring an inconsistent L3 baseline and replaying L2/L3. That causal/setup attribution comes from the parent's interaction, not this file-only review. The retained trace itself starts at zoom 3.854161225171426; it does not independently show the earlier reported zoom-1.24 setup state. Keep this failed capture separate from the valid fixtureBundle L4 result.

## Fixture bundle L4 outward repeat: camera roundtrip, context concern

Independent review of `/tmp/okie-goal-fixturebundle-l4-outward.json` confirms 40 positive-delta inputs, 387 frames, no drops/truncation, zero contrary zoom increases, and zero changed-camera/unchanged-fractional-progress candidates. The final camera is x 446.95900000000006, y -241.815, zoom 3.7157200000000024, matching the stated starting L3 camera to floating-point precision. Its projection ID is settled web-container L3. Input gaps are 67.4–603.6 ms: these are separated CUA wheel inputs, not a continuous physical trackpad gesture.

The movie was inspected across its duration at three-second intervals and through video time 10–16 seconds at three decoded samples per second. Source nodes contract and fade into the fixtureBundle component, and L3 becomes active. No repeated large shaking excursion is evident in the inspected reverse transition, and the inspector stays populated.

**A separate endpoint context concern remains:** late movie samples show only the selected fixtureBundle card on an otherwise largely empty main canvas, while the minimap is mostly empty with a small rectangle. The valid inward movie's starting samples showed surrounding component cards (including relationshipFlow) and a dense component minimap. Thus this is a numeric camera roundtrip, but not a demonstrated visual/scene roundtrip. The persistent lack of surrounding component context deserves inspection of focus/sibling visibility and minimap content before acceptance. File-only evidence cannot determine whether this is intended persistent focus or erroneous visibility state; it should not be silently treated as equivalent to the original dense L3 endpoint.

Minimap placement still clears the floating controls. No frame-accurate anchoring, complete geometry equality, or full-matrix pass is established.

## HostedAtlas semantic-frame inward repeat

`/tmp/okie-goal-hostedatlas-semantic-frame-inward.json` independently confirms 35 inward inputs, 364 frames, no drops/truncation, and zero zoom decreases. Its recorded zoom range is 5.466356809057845–18.961306225200918 and its maximum adjacent increase is 3.7259356557%. It reaches the settled hostedAtlas component/source path. This is the same source file as the earlier 80.76% arrival-jump capture; that oversized step does not recur in this trace. Starting camera and setup differ, so this is same-file corroboration, not an identical replay.

The movie was inspected across its duration and at three decoded samples per second through video time 12–18 seconds. It shows the hostedAtlas card expanding and source cards gradually appearing, followed by visible `DOGFOOD_ATLAS_REPO`, `HostedAtlasBootStep`, and other L4 nodes. The inspected sequence does not show the earlier brief source-grid-to-single-oversized-node reframe or a blank L3 endpoint. The main inspector remains populated. This supports both valid arrival and the targeted camera-step improvement on hostedAtlas.

The minimap changes from the small focused component representation to a source-node grid using its area, with its viewport indicator visible and controls below it. A fit change is visible during source entry; these sparse samples do not quantify how continuously it interpolates. No new concrete motion defect is identified here, while the separately reported missing-neighbor roundtrip issue remains unresolved by an inward-only capture. Full physical-input, anchor, and matrix acceptance are not established.

## Runtime residency evidence for missing neighbors

Independent parsing of `/tmp/okie-goal-hostedatlas-residency.json` confirms the resident scene changes that the earlier camera-only trace could not expose:

| Sequence | timeMs | sceneRootId | Resident components | Resident code |
| --- | ---: | --- | ---: | ---: |
| 1 | 20082.5 | container:apps-web | 62 | 0 |
| 8 | 21100.73 | container:apps-web | 13 | 0 |
| 100 | 24508.3 | component:apps-web-src-hosted-atlas-ts | 13 | 26 |
| 634 | 42440.8 | container:apps-web | 13 | 26 |

Sequences 1 and 8 have exactly the same camera (x 672.4316306339822, y -376.4655174837282, zoom 5.466356809057845), the same settled web projection ID, and progress 1. Semantic revision changes from 1 to 0. Nevertheless resident components fall from 62 to 13 before entry into L4. The 13-component resident population persists through source-root entry and the return to web root. This proves an actual runtime resident-scene reduction; it is stronger evidence than a helper-only contract check or a camera roundtrip. It does not, by itself, identify the code statement responsible or measure renderer visibility of every resident node.

The parent separately reports that the matching hostedAtlas outward failure occurred without opening a code entity or Source tab, so lazy excerpt loading is not a necessary trigger in that interaction. This report does not independently replay that UI history. The missing-neighbor defect remains unresolved until a candidate preserves/restores the intended residency and passes visual roundtrip review.

## HostedAtlas residency-fixed roundtrip candidate

The available trace is `/tmp/okie-goal-hostedatlas-residency-fixed.json` (not a `-full.json` filename). Independent parsing confirms 70 inputs, 660 frames, no drops/truncation, 35 inward inputs followed by 35 outward inputs, and resident component count **62 in every sampled frame**. Splitting frame samples at the first positive-delta input yields 304 inward-phase frames and 356 outward-phase frames, with zero contrary zoom changes within either phase. A mixed-direction run must not be judged by a single global monotonicity check. The endpoint is web root with camera x 672.4077742059252, y -376.3734998326499, zoom 5.270000000000004.

The movie was inspected across its duration at four-second intervals and through video time 31–37 seconds at three decoded samples per second. Its endpoint visibly restores neighboring component cards, including SemanticDiagramSurface and scanOnePager, alongside hostedAtlas. The dense component minimap also returns. This directly addresses the previous selected-file-only endpoint and is supported by the preserved resident count. The inspector remains populated, and the minimap clears controls.

During the reverse morph, source nodes and larger neighboring component outlines temporarily coexist and overlap while their geometry changes. This review confirms the restored endpoint, but does not certify the aesthetic quality of that overlap or quantify transient anchor errors from sparse samples. No new endpoint loss is evident. The numeric and visual evidence supports the residency fix on this hostedAtlas roundtrip; it does not establish complete matrix or physical-trackpad smoothness.

`/tmp/okie-hostedatlas-neighbors-restored.mp4` preserves consecutive source frames for video time 30–43 seconds, covering source exit and restored component context, without fps resampling. Exact trace/video frame synchronization is not claimed.

### Closer inspection: overlap includes a residual displacement

The overlapping geometry must not be dismissed as a verified intentional crossfade. A closer inspection sampled video 34.8–35.4 seconds at 15 fps, then decoded twelve **consecutive source frames** starting at PTS 35.108333. The relevant neighboring frames are PTS 35.141667 and 35.166667, 25 ms apart.

Across that pair, the large blue rounded outline associated with the scanOnePager neighboring component moves its bottom border substantially downward, roughly 45 pixels in a 400-pixel-wide thumbnail (approximately 110 CSS pixels under the capture's 2× scale). Its large label becomes more visible at the top. Meanwhile the smaller hostedAtlas source-card grid, including HostedAtlasBootStep, remains approximately in place. The moving outline encloses/overlays source-card content and overlaps the hostedAtlas component labeling. Both semantic levels are visibly present.

This establishes an abrupt relative geometry change in consecutive captured frames, not merely the existence of an opacity crossfade. The exact implementation cause and whether the larger node's relocation is intended are unproven. The observed blue lines are node borders; this inspection does **not** identify a specific stale relationship edge. Consequently “no wrong-level edges” is also not certified. Endpoint neighbor restoration remains confirmed, but motion smoothness remains unverified and this displacement needs investigation against the intended transition contract. Earlier language about temporary coexistence should be read with this stricter qualification.

## Compiler-aligned HostedAtlas roundtrip

`/tmp/okie-goal-hostedatlas-aligned-roundtrip.json` contains 70 inputs and 658 frames with zero dropped samples. The endpoint returns to web L3 with 62 resident components and 26 resident code entries. It uses shifted world coordinates compared with the preceding layout, so raw positions must not be compared without accounting for the changed origin.

For the same reverse progress interval that previously accompanied the large neighboring-border movement:

| Sequence | Progress | Camera x | Camera y | Zoom |
| --- | ---: | ---: | ---: | ---: |
| 534 | 0.5113551154 | 654.7281274064 | -409.6091478915 | 10.1808283255 |
| 540 | 0.4383043846 | 654.7153182573 | -409.5597411736 | 9.8151231523 |

Camera y now changes only 0.0494067179 world units, compared with the previously reported approximately 11.528-world-unit compensation. Zoom follows the ordinary outward factor. This removes the large camera-translation contribution numerically. Exact scanOnePager corner displacement requires its current world bounds; those were not included in this trace, and no exact pixel result is inferred from camera values alone.

Decoded inspection across the movie and more closely at three samples per second over video time 40–46 seconds shows the source grid contracting without the previous large neighboring outline sweeping through it. scanOnePager becomes visible from below the source region as L3 returns. Some source/target content coexists during the morph, but this inspection finds no specific stale relationship edge. The dense L3 context and minimap return at the endpoint, with controls clear of the minimap. This supports the targeted alignment improvement; sparse visual inspection does not certify every transient, anchor error, or edge lifetime. A separately known code-paging issue is outside this capture's confirmation and prevents a broad product pass.

The earlier border displacement should be understood as observed motion that may have resulted from designed camera compensation applied to differently centered layouts, rather than proof of stale geometry or a wrong representation. That mechanism attribution depends on the parent's code audit; this review independently establishes the smaller camera change and improved sampled motion in the new capture.

### Aligned sibling displacement calculation

Using scanOnePager source bounds from `component-anchor-audit-after.json` (y -385.8958847946992, height 42.50474383301708) and trace sequences 534→540, the projected top border moves from y 623.9206606 to 614.7636646 CSS pixels: **-9.1569960 px**. The bottom border moves from 1056.6541606 to 1031.9529599: **-24.7012007 px**. These use `(worldY - cameraY) * zoom + viewportHeight / 2`; viewport height is 765.

The trace pointer is y 369, and the ordinary outward zoom ratio is `9.8151231523 / 10.1808283255`. Applying that ratio around pointer y 369 predicts the same top and bottom displacements. Thus the audited fixed component's movement in this interval is ordinary pointer-anchored zoom, not the prior roughly 110–134 CSS-pixel compensation excursion. This is a model/trace calculation with audited fixed bounds, not an exact video pixel measurement or proof of every edge's behavior.

## Read-only cold-L4 reverse ownership audit

At the reviewed source state, cold-restored L4 does **not** get the same retained L3↔L4 bridge installed by wheel entry. `App.tsx:2626` calls `shouldStartScanContainerReverseMorph`; `semantic/scanContainerMorph.ts:135` accepts only outward input with `currentDetail === 'component'`. A cold L4 session has detail `code`, so this installer declines. Its accepted path also explicitly composes the view-root source and calls the L2/L3-specific `createScanContainerMorph` at `App.tsx:2645`, rather than a generic component/code source pair.

The contrast is concrete: `applyScanZoomHandoff` at `App.tsx:3314` installs `createScanDetailMorph(..., 'component', 'code', ...)` for wheel entry into L4, keeping source/target ownership for reverse samples. A cold scene has no such retained ref. It falls through `handleSemanticZoom` after `App.tsx:2695` into `maybeScanZoomHandoff` (`App.tsx:3382`) and, if no compile handoff is yet needed, the generic settled-entry reversal path (`App.tsx:2769`) with bounds read from the resident scene. This generic path can still interpolate; absence of the dedicated bridge is not proof of a visible jump.

Once the camera's level requests component detail, `scanZoomCompileHandoff` (`renderer/goldenC4Scene.ts:704`) can return the containing container as a new compile focus for a current file-root scene. `maybeScanZoomHandoff` waits for `ensureNeighborhood`, rechecks the live band, and calls `applyScanZoomHandoff`. Because the live root is a component rather than the top-level view root, its component-detail condition does not create the L2/L3 bridge; it replaces the scene/session and uses `scanZoomHandoffCamera` (`semantic/semanticLensEngine.ts:498`). That helper preserves zoom while translating between source/target centers when bounds are present, or uses component-peer framing otherwise. Thus a cold-L4 exit has a recompile/adoption boundary and potentially a translation, rather than proven equivalent retained ownership. Whether aligned bounds make it visually continuous requires a recording.

Existing tests in `semantic/scanContainerMorph.test.ts:20` cover cold/rail L3 reverse eligibility, not cold L4. The test at line 191 builds an L3→L4 bridge explicitly and reverses that retained bridge; it does not model a reload with no bridge. `scanZoomHandoff.qa.test.ts` covers helper/handoff behavior and source wiring but the inspected tests do not establish a cold-L4 browser reverse contract.

Smallest meaningful reproduction: open a hostedAtlas L4 URL directly or reload at settled L4; confirm the file root, code detail, and visible code peers before any wheel; capture sceneRootId, revision, resident counts, camera and projection while wheeling outward to settled L3. Compare boundary step size and neighbor/minimap restoration against the retained roundtrip. A focused integration test should initialize that cold state with no bridge and verify that outward samples preserve zoom increments, stable owner anchoring and complete target component residency across the compile boundary. A pure test that merely constructs a retained bridge would not exercise the missing route. This audit reports a coverage/ownership difference, not a recorded visual defect.

## Actual cold-L4 outward capture

`/tmp/okie-goal-cold-l4-outward.json` confirms 35 outward inputs and 406 frame samples. The cold source root initially has 10 resident components and 26 code entries. Sequence 310 at timeMs 37471.7 reports component/code progress 0.2756859866 and camera (654.5937589548, -409.0919273972, zoom 7.3248199048). Sequence 311 at 37847.3 has **exactly the same camera**, but changes to settled web L3, 62 resident components and zero code entries. Thus the observed boundary is a representation/residency replacement, not a camera zoom jump. The 375.6-ms sample interval is not itself a measured display stall.

The completed movie has duration 60.021667 seconds. Decoded inspection covers the active transition and endpoint, with a closer four-fps sequence from video time 12–16 seconds. It shows a compact source-node grid shrinking and fading, then a visibly larger hostedAtlas component card with neighboring component cards appearing near video time 15 seconds. This is a discrete scene replacement in the inspected sequence, consistent with the cold-path recompile audit; it should not be reported as proven equivalent to the retained bridge's gradual return. No repeated camera shaking is demonstrated by these samples, but full perceptual continuity is not established.

The endpoint is populated L3 with a dense component minimap, at camera (654.4074499123, -408.3733068048, zoom 5.2700010491). The breadcrumb still identifies hostedAtlas while the compiled root is its web container; that combination can describe a selected file within a container and is not independently classified as a navigation bug here. The inspector shows a populated Overview rather than a blank pane. Minimap placement clears controls. No specific stale relationship edge is identified.

Compared with the retained aligned reverse, the cold route has a different residency boundary and shorter generic reverse progression before adoption. Camera metrics alone do not settle whether its visible replacement meets the requested feel. Cold-L4 smoothness remains unverified pending an explicit transition continuity check or equivalent retained ownership; no full pass is granted.

## Read-only review of cold reverse installer fix

The new installer accepts code detail, resolves the focused file's parent as source root, and builds `createScanReverseMorph`. This addresses the previously missing retained cold-L4 route. At a high-zoom cold endpoint (camera at or above fullZoom), the new progress/baseline values of 1 sample back to 1, so installation alone adds no camera compensation. The actual scene stitching still needs visual verification with current aligned bounds.

**Uncovered lower-zoom installation edge case:** the helper uses a fixed code interval 7.6–12.54 while initializing progress and baseline to 1. The App immediately samples that interval at the first outward camera zoom and publishes the sampled session. A cold *settled* L4 scene restored at zoom 10 would therefore go from a fully displayed endpoint to progress approximately 0.475 after one ordinary outward wheel (zoom approximately 9.64079). A restored code view at or below 7.6 can collapse to progress 0 immediately. This is a source-level progress discontinuity risk even if aligned owner centers prevent camera translation. A partially active restored session also deserves explicit coverage: the helper reconstructs progress from zoom rather than adopting the currently displayed active progress.

The added helper test verifies fullZoom camera equality, parent residency, an independently sampled midpoint, and the source endpoint. It does not initialize a cold settled L4 below fullZoom and exercise the actual install→first-wheel sequence. Add that focused case (e.g. settled code at zoom 10) and a restored active-progress case; assert the intended first-frame representation continuity, not merely that the sampled midpoint is fractional. The implementation needs an explicit contract for reconciling the restored display with its zoom interval—such as preserving the current endpoint when installing—before lower-zoom cold views can be assumed safe. No new visual failure is claimed here without a capture.

### Arrival-zoom amendment review

The amendment passes `sample.renderedCamera?.zoom ?? sample.gestureStartZoom` through the App installer into `createScanReverseMorph`. The actual wheel call at `App.tsx:654` computes the new raw camera first but supplies the still-current `liveCameraRef.current` as renderedCamera, then updates live camera only after the semantic callback. Thus the helper receives the intended pre-input zoom rather than the already-decreased zoom. Pinch and zoom-control callers likewise supply their live pre-update camera; assist callbacks use direction `none` and do not install a reverse bridge.

For a positive finite arrival zoom below the normal full endpoint, the helper now uses fullZoom=arrivalZoom and startZoom=arrivalZoom/1.65. This resolves the specific settled zoom-10/zoom-7 installation concern: pre-input sampling is 1, and a normal outward event decreases progress by the ordinary logarithmic increment rather than starting near the middle or at zero. Higher arrival zoom retains the fixed interval and still begins on its clamped full endpoint. No further concrete pre-input argument-ordering defect was found in the inspected call sites.

The helper still assumes the incoming view is a settled endpoint; it does not accept an explicit already-displayed active progress. The current eligibility constraints can prevent installation for some active states, but an active-session restoration contract is not established by the new settled-endpoint tests. That remains a narrower unverified case, not evidence that the settled cold-view fix fails. Fresh video should verify scene stitching and cold reverse continuity after the source freeze.

## Fresh centered L1/L2 roundtrip

Independent direction-split analysis of `/tmp/okie-goal-l1-centered-roundtrip.json` confirms 44 inputs (22 inward followed by 22 outward), 396 frames, no drops/truncation, and zero contrary zoom changes in each phase separately: 150 inward-phase frames and 246 outward-phase frames. Endpoint is settled context base at zoom 0.8037000000000003. This is an explicit per-direction calculation, not reliance on a mixed-direction analyzer result. The original L1 capture's brief inward zoom reversal does not recur.

The movie was inspected across its duration and more closely at four decoded samples per second through 8–11 seconds inward and 19–22 seconds outward. The system card expands to the container layout and contracts back, with no repeated large shaking excursion identified in those samples. Containers and their lines fade as the L1 system card returns. No specific lingering wrong-level relationship edge is identified; sparse sampling cannot certify every edge lifetime. The minimap remains above controls and changes between context and container layouts with a visible viewport indicator. The Overview inspector stays populated.

A minor visible transition detail remains: during the crossfade the system's `SOFTWARE SYSTEM` text and `Okie` title appear briefly superimposed near its upper-left corner in some sampled frames. This is a text/label overlap observation, not camera shake or a proven stale relationship edge. Exact duration is unmeasured. The capture supports the targeted L1/L2 motion improvement but does not establish continuous physical input, subframe anchoring, or a full matrix pass. Source identity is supplied by the parent in `source-state-alignment.json`; this review does not independently rerun the build gates.

## Cold retained reverse and low-zoom validation

`/tmp/okie-goal-cold-l4-retained-outward.json` independently confirms 35 outward inputs, 443 frames, zero contrary zoom increases, and resident counts of 62 components plus 26 code entries in every frame. It ends at settled web L3. Unlike the prior cold capture, no source population is discarded at adoption. Decoded inspection across the movie and through video time 11–17 seconds at three samples per second shows source cards fading while the parent component and neighboring cards return; no comparable discrete residency replacement or large border excursion is identified. The endpoint has visible neighbors and a dense minimap above controls. This supports the targeted cold reverse fix, not a full smoothness/edge-lifetime certification.

The lower-zoom capture `/tmp/okie-goal-cold-l4-zoom10-outward.json` has 196 frames. Its first recorded frame is zoom 9.640790354679229 and progress **0.926949269232282**, confirming that the first outward input remains close to the restored endpoint instead of jumping to the previously predicted 0.475. It ends at settled web L3, zoom 4.8111930001588465, with 62 components and 26 code entries. The companion movie's two-second samples show the initial compact source grid and restored neighboring L3 cards, without the earlier blank endpoint. This validates the specific low-zoom installation concern at zoom 10; sparse inspection does not measure every first-input pixel.

### Exact L1 label-overlap evidence

Twelve consecutive frames from `/tmp/okie-goal-l1-centered-roundtrip.mov` show the white `Okie` title overwriting the purple `SOFTWARE SYSTEM` label at the system card's upper-left corner. Their exact presentation timestamps are 20.771667, 20.788333, 20.805000, 20.821667, 20.846667, 20.863333, 20.880000, 20.896667, 20.913333, 20.930000, 20.946667 and 20.963333 seconds. These are movie PTS values, not inferred trace offsets. The decoded contact sheet is `/tmp/okie-l1-label-consecutive.png`. The observation spans at least 191.666 ms across those frames; full onset/end were not measured.

## Shareable cold-reverse comparison

`/tmp/okie-cold-l4-before-after.mp4` is a labeled side-by-side comparison, 1572×760, approximately seven seconds. Left: original `/tmp/okie-goal-cold-l4-outward.mov`, source time 10–17 seconds. Right: `/tmp/okie-goal-cold-l4-retained-outward.mov`, source time 11–18 seconds. Both play at their original elapsed-time speed; footage is scaled uniformly to fit and no spatial content is removed beyond the original recording's crop. The labels occupy a separate header.

Windows were selected to show comparable source-exit phases, not identical wheel-event or progress synchronization. Gesture cadence and transition implementation differ, so a simultaneous frame is not an equal-zoom/equal-progress comparison. Output duration is 6.991667 seconds because of source frame timestamps. This clip illustrates the discrete old replacement versus the retained transition and restored context; it is not a quantitative smoothness benchmark.

## Fresh centered web L2/L3 roundtrip

`/tmp/okie-goal-web-centered-roundtrip.json` independently confirms 70 inputs and 749 frames, no drops/truncation. Splitting at the first outward input gives 331 inward-phase frames and 418 outward-phase frames; neither phase contains contrary zoom changes. All recorded inputs use pointer (315, 369), viewport 623×765. Computing the world point under that pointer for every sampled camera gives **zero drift at the serialized numeric precision** relative to the first frame. This is stronger camera-anchor evidence than monotonic zoom alone, but does not prove rendered geometry or every edge stays aligned.

The endpoint returns to system root at camera (-238.7611588142, -539.716, zoom 1.3793400000). Actual runtime residency has two recorded populations: 86 components/229 code entries and 62 components/zero code entries, with 2 context and 12 container entries in both. This is bounded runtime scene evidence; a full-snapshot compiler audit must not be substituted for it or interpreted as proof that every snapshot entity was displayed.

The movie was inspected across its duration at four-second intervals and more closely through video time 29–35 seconds at three decoded samples per second. The dense component grid contracts and fades into the web container while neighboring container context returns. No repeated large shake or blank endpoint is identified in those samples. The minimap transitions from the dense component grid to the container layout, stays above controls, and retains a visible viewport indicator. The inspector remains populated. No specific stale relationship edge is identified; this does not certify all edge lifetimes. Some source/target labels and shapes coexist during the transition, requiring the separate label-correction validation rather than an assumed overall pass.

This supports anchored camera motion and usable endpoint restoration on the centered web path. It is not continuous physical-input evidence or full-matrix acceptance. The parent's source identity checkpoint applies to this recording; later label changes require their own verification.

## Bounded minimap formula and drag audit

Read-only source comparison finds that `minimapGeometry.ts:minimapEntityRects` follows the same projected object-bound construction as `Canvas2DRenderer.activeEntities`: base bounds by active detail, per-object source/target interpolation, and affine scaling of morph children through the current boundary rectangle. Both omit overridden base entities and filter nearly transparent projected objects. The minimap is an overview of semantic scope rather than the renderer's final viewport-culling set, so offscreen objects in the minimap are expected. This source correspondence is not a saved per-frame DOM comparison.

`minimapWorldRect` fits the highest-pick-priority semantic objects at source/target endpoints and interpolates those scope envelopes. `minimap.tsx` uniformly projects that world rectangle into the inset, uses the exact inverse for pointer mapping, and freezes the world fit during a drag. Its live-camera subscriber receives a scene/projection frame and updates entity rectangles and the viewport from that state. The viewport world rectangle is camera-centered with width `viewport.width / zoom` and height `viewport.height / zoom`. For all **749 actual web trace cameras**, its two opposite world corners mapped through the main renderer formula back to screen (0,0) and (623,765) with maximum error **3.41e-13 CSS pixels**. This establishes coordinate-formula consistency for every recorded camera, not actual SVG timing or scene-bound equality.

The parent's reported L2 drag provides a numerical inverse check. At zoom 1.430733320873975, viewport width 108.44868824170374 and height 133.16732986340827 in minimap units imply the same uniform scale from both axes: **0.2490548184148943 inset units/world unit**. A 20-unit drag therefore predicts camera delta **80.3036059583 world units** on each axis, matching the reported approximately (-238.670, -540.068)→(-158.366, -459.764). Reported viewport x and y each move exactly 20 while dimensions remain fixed. SVG screen bounds 168×109 match the inset/viewBox dimensions, so client movement 20px equals inset movement 20 here. This agrees with the grab-offset inverse mapping. The negative viewport y and height larger than the inset are permissible: the camera covers space outside the fitted semantic envelope, and the SVG clips its visible outline.

Limits: entity glyph rectangles are clamped to at least one inset unit, and viewport width/height to at least two with preserved center; at extreme zoom these are visibility affordances rather than scale-exact rectangles. The trace does not contain full per-frame projection objects, world fit envelopes or DOM SVG values, so exact rendered-entity/minimap parity across all 749 frames cannot be independently reconstructed from it. The drag numbers are parent-supplied UI observations, not a second UI interaction. No minimap edge-lifetime, full-matrix or physical-input pass follows from this bounded audit.

## Current protocol roundtrip

The complete `/tmp/okie-goal-final-protocol-roundtrip.json` contains **52 inputs and 524 frames**, with no reported drops or truncation. Splitting at the first positive wheel delta gives 211 inward-phase frames and 313 outward-phase frames; neither phase contains contrary zoom changes. Zoom peaks at 5.151390394639465. Scope changes from system to `container:crates-atlas-protocol` and back to system.

The complete endpoint is camera **(-237.76003548908312, -422.2852867908727, zoom 1.9900000000000009)**, not zoom 2.14105 from an earlier partial observation. The first captured frame is already after the first input, at zoom 2.064146119549357; it is not a pre-input settled-state measurement. All recorded input positions are local (315,369) in the 623×765 viewport. Across every sampled camera, the world point `(camera.x + 3.5 / zoom, camera.y - 13.5 / zoom)` has **zero drift at serialized precision**. This supports stable pointer anchoring through both recorded directions and does not require an interrupted-flight explanation for the final zoom.

Decoded movie inspection across the duration and at three samples per second during video time 16–21 seconds shows the protocol component grid contracting, the protocol container border returning, and neighboring container context becoming visible. No repeated large upward/downward shake is identified in these samples. The endpoint is populated, the inspector remains visible, and the minimap returns from detailed geometry to container context above the controls. Contact sheets are `/tmp/okie-final-protocol-contact.png` and `/tmp/okie-final-protocol-reverse.png`.

During the reverse coexistence phase, a neighboring architecture card/border is temporarily visible across the lower-right area of the returning protocol region; scan context appears as the wider scene returns. These sampled node-outline overlaps alone do not establish a stale relationship edge or packet mismatch. Their exact onset/lifetime and every intervening frame have not been measured, so edge/border perceptual acceptance remains bounded rather than asserted. The trace's initial population is 2 context, 12 container, 86 component and 229 code entries; the final population is 2 context, 12 container and 17 component entries with no code. This is the recorded protocol scope, not a full-snapshot coverage claim.

The evidence supports a complete, anchored protocol roundtrip with restored context. Separated CUA wheel inputs and sampled video inspection do not establish uninterrupted physical-trackpad smoothness, all-edge correctness, or full-matrix acceptance. Movie time references are presentation time; no exact movie/trace synchronization is claimed.
