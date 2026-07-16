import { describe, expect, it } from 'vitest';
import {
  canonicalNavigationState,
  canonicalNavigationUrl,
  navigationStateFromUrl,
  type NavigationDefaults,
} from './navigation/navigationState';
import {
  STORY_ARRIVAL_SETTLE_MS,
  STORY_HOLD_DURATION_MS,
  createStoryArrivalClock,
  createStoryFlight,
  decodeStoryCinematicPosition,
  pauseStoryFlight,
  resolveStoryHoldDuration,
  resumeStoryFlight,
  sampleStoryArrivalClock,
  sampleStoryFlight,
  storyCinematicPosition,
  storyFlightDuration,
} from './storyPlayback';

const viewport = { width: 1_200, height: 800 };
const navigationDefaults: NavigationDefaults = {
  repositoryId: 'repo:commerce',
  snapshotId: 'snapshot:42',
  viewId: 'view:systems',
  rootEntityId: 'gateway',
  selectedId: 'gateway',
  camera: { x: 245, y: 85, zoom: 0.68 },
  detail: 'container',
  minZoom: 0.18,
  maxZoom: 1.55,
};

function expectCameraClose(
  actual: { x: number; y: number; zoom: number },
  expected: { x: number; y: number; zoom: number },
) {
  expect(actual.x).toBeCloseTo(expected.x, 12);
  expect(actual.y).toBeCloseTo(expected.y, 12);
  expect(actual.zoom).toBeCloseTo(expected.zoom, 12);
}

describe('cinematic story QA contract', () => {
  it('samples cubic world-center and logarithmic zoom at exact quarter timestamps', () => {
    const flight = createStoryFlight(
      { x: 0, y: 0, zoom: 1 },
      { x: 200, y: 100, zoom: 2 },
      viewport,
      1_000,
      { durationMs: 800 },
    );
    const expectations = [
      { elapsed: 0, eased: 0, x: 0, y: 0, zoom: 1 },
      { elapsed: 200, eased: 0.0625, x: 12.5, y: 6.25, zoom: 2 ** 0.0625 },
      { elapsed: 400, eased: 0.5, x: 100, y: 50, zoom: Math.SQRT2 },
      { elapsed: 600, eased: 0.9375, x: 187.5, y: 93.75, zoom: 2 ** 0.9375 },
      { elapsed: 800, eased: 1, x: 200, y: 100, zoom: 2 },
    ];

    for (const expected of expectations) {
      const sample = sampleStoryFlight(flight, 1_000 + expected.elapsed);
      expect(sample.elapsedMs).toBe(expected.elapsed);
      expect(sample.progress).toBe(expected.elapsed / 800);
      expect(sample.easedProgress).toBe(expected.eased);
      expectCameraClose(sample.camera, expected);
    }
  });

  it('returns identical camera and transition samples for direct, forward, and backward seeks', () => {
    const flight = createStoryFlight(
      { x: -120, y: 75, zoom: 0.5 },
      { x: 260, y: -45, zoom: 1 },
      viewport,
      50,
      { durationMs: 1_000 },
    );
    const timestamps = [0, 250, 500, 750, 1_000];
    const direct = new Map(timestamps.map(elapsed => [elapsed, sampleStoryFlight(flight, 50 + elapsed)]));
    const forward = new Map([...timestamps].sort((a, b) => a - b)
      .map(elapsed => [elapsed, sampleStoryFlight(flight, 50 + elapsed)]));
    const backward = new Map([...timestamps].sort((a, b) => b - a)
      .map(elapsed => [elapsed, sampleStoryFlight(flight, 50 + elapsed)]));

    expect(forward).toEqual(direct);
    expect(backward).toEqual(direct);
  });

  it('uses the normative adaptive-duration formula and widens long routes through overview', () => {
    const diagonal = Math.hypot(viewport.width, viewport.height);
    expect(storyFlightDuration(
      { x: 0, y: 0, zoom: 1 },
      { x: diagonal, y: 0, zoom: 1 },
      viewport,
    )).toBe(700);
    expect(storyFlightDuration(
      { x: 0, y: 0, zoom: 1 },
      { x: diagonal * 2, y: 0, zoom: 1 },
      viewport,
    )).toBe(880);
    expect(storyFlightDuration(
      { x: 0, y: 0, zoom: 0.25 },
      { x: diagonal * 8, y: 0, zoom: 1 },
      viewport,
    )).toBe(1_100);

    const source = { x: 0, y: 0, zoom: 2 };
    const target = { x: 4_000, y: 0, zoom: 2 };
    const flight = createStoryFlight(source, target, viewport, 0, { durationMs: 1_100 });
    const midpoint = sampleStoryFlight(flight, 550);
    expect(flight.overviewZoom).toBeDefined();
    expect(midpoint.camera.x).toBe(2_000);
    expect(midpoint.camera.zoom).toBeLessThan(Math.min(source.zoom, target.zoom));
    expect(sampleStoryFlight(flight, 1_100).camera).toEqual(target);
  });

  it('does not advance hold time until the complete arrival barrier has elapsed', () => {
    const playing = createStoryArrivalClock(2_000, {
      holdElapsedMs: 725,
      playHoldAfterArrival: true,
    });
    expect(sampleStoryArrivalClock(playing, 2_000 + STORY_ARRIVAL_SETTLE_MS - 1)).toEqual({
      phase: 'arrival',
      phaseElapsedMs: STORY_ARRIVAL_SETTLE_MS - 1,
      holdElapsedMs: 725,
      arrived: false,
      holdComplete: false,
    });
    expect(sampleStoryArrivalClock(playing, 2_000 + STORY_ARRIVAL_SETTLE_MS)).toMatchObject({
      phase: 'hold',
      holdElapsedMs: 725,
      arrived: true,
    });
    expect(sampleStoryArrivalClock(playing, 2_000 + STORY_ARRIVAL_SETTLE_MS + 1)).toMatchObject({
      phase: 'hold',
      holdElapsedMs: 726,
    });

    const manual = createStoryArrivalClock(3_000, { playHoldAfterArrival: false });
    expect(sampleStoryArrivalClock(manual, 3_000 + STORY_ARRIVAL_SETTLE_MS + 5_000)).toMatchObject({
      phase: 'hold',
      holdElapsedMs: 0,
      holdComplete: false,
    });
  });

  it('resolves authored and reading-time holds deterministically and round-trips their progress', () => {
    const eighteenWords = Array.from({ length: 18 }, () => 'word').join(' ');
    expect(resolveStoryHoldDuration('two words')).toBe(4_200);
    expect(resolveStoryHoldDuration(eighteenWords)).toBe(7_200);
    expect(resolveStoryHoldDuration('two words', 8_000)).toBe(8_000);
    expect(resolveStoryHoldDuration(Array.from({ length: 60 }, () => 'word').join(' '))).toBe(12_000);

    const holdDurationMs = resolveStoryHoldDuration(eighteenWords);
    const stepOffsetMs = 20_000;
    const elapsedMs = 5_400;
    const positionMs = storyCinematicPosition(
      3,
      'hold',
      elapsedMs,
      0,
      holdDurationMs,
      stepOffsetMs,
    );
    expect(decodeStoryCinematicPosition(3, positionMs, holdDurationMs, stepOffsetMs)).toEqual({
      phase: 'hold',
      elapsedMs,
    });

    const clock = createStoryArrivalClock(10_000, {
      holdDurationMs,
      playHoldAfterArrival: true,
    });
    expect(sampleStoryArrivalClock(clock, 10_000 + STORY_ARRIVAL_SETTLE_MS + holdDurationMs - 1))
      .toMatchObject({ phase: 'hold', holdComplete: false });
    expect(sampleStoryArrivalClock(clock, 10_000 + STORY_ARRIVAL_SETTLE_MS + holdDurationMs))
      .toMatchObject({ phase: 'hold', holdElapsedMs: holdDurationMs, holdComplete: true });
  });

  it('uses cumulative resolved step offsets without collisions and preserves authored holds above 12 seconds', () => {
    const holds = [
      resolveStoryHoldDuration('short'),
      resolveStoryHoldDuration(Array.from({ length: 18 }, () => 'word').join(' ')),
      resolveStoryHoldDuration('short', 15_000),
    ];
    expect(holds).toEqual([4_200, 7_200, 15_000]);
    const slot = (holdMs: number) => 1_100 + STORY_ARRIVAL_SETTLE_MS + holdMs;
    const offsets = [0, slot(holds[0]), slot(holds[0]) + slot(holds[1])];

    const endOfSecondHold = storyCinematicPosition(
      1,
      'hold',
      holds[1],
      0,
      holds[1],
      offsets[1],
    );
    const startOfThirdFlight = storyCinematicPosition(
      2,
      'flight',
      0,
      1_100,
      holds[2],
      offsets[2],
    );
    expect(startOfThirdFlight).toBe(endOfSecondHold);
    expect(decodeStoryCinematicPosition(2, startOfThirdFlight, holds[2], offsets[2]))
      .toMatchObject({ phase: 'flight', elapsedMs: 0, progress: 0 });

    const authoredEnd = storyCinematicPosition(
      2,
      'hold',
      15_000,
      0,
      holds[2],
      offsets[2],
    );
    expect(decodeStoryCinematicPosition(2, authoredEnd, holds[2], offsets[2]))
      .toEqual({ phase: 'hold', elapsedMs: 15_000 });
  });

  it.each([0.25, 0.5, 0.75])(
    'freezes interruption at %s progress and resumes from the actual camera for proportional remaining time',
    progress => {
      const durationMs = 800;
      const source = { x: 0, y: 0, zoom: 1 };
      const target = { x: 240, y: 120, zoom: 2 };
      const flight = createStoryFlight(source, target, viewport, 100, { durationMs });
      const interruptionAt = 100 + durationMs * progress;
      const paused = pauseStoryFlight(flight, interruptionAt);
      const frozen = sampleStoryFlight(paused.flight, interruptionAt + 10_000);

      expect(frozen.progress).toBe(progress);
      expect(frozen.camera).toEqual(paused.sample.camera);

      const userCamera = {
        x: frozen.camera.x + 13,
        y: frozen.camera.y - 7,
        zoom: frozen.camera.zoom * 0.9,
      };
      const resumedAt = 20_000;
      const resumed = resumeStoryFlight(paused.flight, userCamera, viewport, resumedAt);
      const expectedRemainingMs = durationMs * (1 - progress);
      expect(resumed.durationMs).toBe(expectedRemainingMs);
      expect(sampleStoryFlight(resumed, resumedAt).camera).toEqual(userCamera);
      expect(sampleStoryFlight(resumed, resumedAt + expectedRemainingMs).camera).toEqual(target);
    },
  );

  it('round-trips flight, arrival, and hold positions without changing their exact phase time', () => {
    for (const [phase, elapsedMs] of [
      ['flight', 731],
      ['arrival', 149],
      ['hold', 3_287],
    ] as const) {
      const positionMs = storyCinematicPosition(3, phase, elapsedMs);
      expect(decodeStoryCinematicPosition(3, positionMs)).toMatchObject({ phase, elapsedMs });
    }
  });

  it('round-trips a shared mid-flight sample and resumes a proportional canonical remainder', () => {
    const source = { x: -80, y: 40, zoom: 0.5 };
    const target = { x: 260, y: -60, zoom: 1 };
    const originalDurationMs = 640;
    const originalElapsedMs = 160;
    const original = createStoryFlight(source, target, viewport, 1_000, {
      durationMs: originalDurationMs,
    });
    const sampled = sampleStoryFlight(original, 1_000 + originalElapsedMs);
    const normalizedPosition = storyCinematicPosition(
      2,
      'flight',
      sampled.elapsedMs,
      originalDurationMs,
    );
    const navigation = canonicalNavigationState({
      ...navigationDefaults,
      camera: sampled.camera,
      story: { id: 'story:checkout-flow', step: 2, positionMs: normalizedPosition },
    }, navigationDefaults);
    const url = canonicalNavigationUrl(navigation, 'https://atlas.example/map');
    const restored = navigationStateFromUrl(url, navigationDefaults).state;
    const restoredPosition = decodeStoryCinematicPosition(2, restored.story!.positionMs);

    expect(restored.camera).toEqual(canonicalNavigationState({
      ...navigationDefaults,
      camera: sampled.camera,
    }, navigationDefaults).camera);
    expect(restoredPosition).toMatchObject({ phase: 'flight', progress: 0.25 });

    const canonicalDurationMs = 1_100;
    const canonicalElapsedMs = canonicalDurationMs * restoredPosition.progress!;
    const resumedAt = 8_000;
    const resumed = createStoryFlight(restored.camera, target, viewport, resumedAt, {
      durationMs: canonicalDurationMs - canonicalElapsedMs,
      canonicalDurationMs,
      canonicalElapsedMs,
    });
    expect(resumed.durationMs).toBe(825);
    expect(sampleStoryFlight(resumed, resumedAt).camera).toEqual(restored.camera);
    expect(sampleStoryFlight(resumed, resumedAt + 825).camera).toEqual(target);
  });

  it('round-trips an exact cinematic camera at the shared 0.18 minimum zoom', () => {
    const camera = { x: -455.889, y: -2_158.056, zoom: 0.18 };
    const navigation = canonicalNavigationState({
      ...navigationDefaults,
      camera,
      story: {
        id: 'story:checkout-flow',
        step: 0,
        positionMs: storyCinematicPosition(0, 'flight', 550, 1_100),
      },
    }, navigationDefaults);
    const url = canonicalNavigationUrl(navigation, 'https://atlas.example/map');
    const restored = navigationStateFromUrl(url, navigationDefaults).state;
    expect(restored.camera).toEqual(camera);
    expect(decodeStoryCinematicPosition(0, restored.story!.positionMs))
      .toMatchObject({ phase: 'flight', progress: 0.5 });
  });

  it('snaps a zero-duration reduced-motion flight but preserves the normal arrival barrier and hold', () => {
    const target = { x: 300, y: -50, zoom: 1.2 };
    const flight = createStoryFlight(
      { x: 0, y: 0, zoom: 0.4 },
      target,
      viewport,
      500,
      { durationMs: 0 },
    );
    expect(sampleStoryFlight(flight, 500)).toMatchObject({
      camera: target,
      progress: 1,
      arrived: true,
    });

    const arrival = createStoryArrivalClock(501, {
      playHoldAfterArrival: true,
      reducedMotion: true,
    });
    expect(sampleStoryArrivalClock(arrival, 501 + STORY_ARRIVAL_SETTLE_MS - 1)).toMatchObject({
      phase: 'arrival',
      holdElapsedMs: 0,
    });
    expect(sampleStoryArrivalClock(arrival, 501 + STORY_ARRIVAL_SETTLE_MS)).toMatchObject({
      phase: 'hold',
      holdElapsedMs: 0,
    });
    expect(sampleStoryArrivalClock(arrival, 501 + STORY_ARRIVAL_SETTLE_MS + STORY_HOLD_DURATION_MS))
      .toMatchObject({ phase: 'hold', holdComplete: true });

    const restored = decodeStoryCinematicPosition(
      1,
      storyCinematicPosition(1, 'arrival', 0, 0),
    );
    expect(restored).toEqual({ phase: 'arrival', elapsedMs: 0 });
  });
});
