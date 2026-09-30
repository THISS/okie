import type { WheelSample } from './wheelIntent';

/**
 * Wheel event sequences for wheelIntent tests. These are MODELLED ON DOCUMENTED
 * BROWSER EVENT SHAPES (deltaMode, delta magnitudes/integrality, ctrlKey pinch
 * synthesis, legacy wheelDeltaY = −3·deltaY on trackpads / ±120 per notch) — they
 * are not hardware recordings.
 */

type FixtureEvent = Omit<WheelSample, 'timeStamp' | 'ctrlKey' | 'metaKey'> & { ctrlKey?: boolean; metaKey?: boolean };

function sequence(startMs: number, intervalMs: number, events: FixtureEvent[]): WheelSample[] {
  return events.map((event, index) => ({
    ctrlKey: false,
    metaKey: false,
    ...event,
    timeStamp: startMs + index * intervalMs,
  }));
}

function chromeTrackpad(deltaX: number, deltaY: number): FixtureEvent {
  return { deltaX, deltaY, deltaMode: 0, wheelDeltaY: -3 * deltaY };
}

/** (1) macOS trackpad two-finger scroll, Chrome: integer px deltas, occasional deltaX, decaying momentum tail. */
export const chromeTrackpadScroll: WheelSample[] = sequence(1000, 16, [
  chromeTrackpad(0, 1),
  chromeTrackpad(0, 3),
  chromeTrackpad(1, 6),
  chromeTrackpad(0, 11),
  chromeTrackpad(-1, 17),
  chromeTrackpad(0, 24),
  chromeTrackpad(0, 31),
  // momentum tail (large first, decaying; the latch keeps these panning)
  chromeTrackpad(0, 52),
  chromeTrackpad(0, 40),
  chromeTrackpad(0, 27),
  chromeTrackpad(0, 16),
  chromeTrackpad(0, 8),
  chromeTrackpad(0, 3),
  chromeTrackpad(0, 1),
]);

/** (2) macOS trackpad two-finger scroll, Firefox: fractional px deltas, no wheelDeltaY. */
export const firefoxTrackpadScroll: WheelSample[] = sequence(2000, 16, [
  { deltaX: 0, deltaY: 0.5, deltaMode: 0 },
  { deltaX: 0.25, deltaY: 2.5, deltaMode: 0 },
  { deltaX: 0, deltaY: 6.75, deltaMode: 0 },
  { deltaX: 0, deltaY: 14.25, deltaMode: 0 },
  { deltaX: -0.5, deltaY: 21.5, deltaMode: 0 },
  { deltaX: 0, deltaY: 12.125, deltaMode: 0 },
  { deltaX: 0, deltaY: 4.5, deltaMode: 0 },
  { deltaX: 0, deltaY: 1, deltaMode: 0 },
]);

/**
 * (3) Trackpad pinch-out (zoom in), Chrome: synthesized ctrlKey wheels with small
 * fractional deltaY and no deltaX. deltaY sums to −69.3 ≈ a 2× finger spread.
 */
export const chromeTrackpadPinch: WheelSample[] = sequence(3000, 16, [
  -0.5, -1.2, -2.4, -3.6, -4.8, -6.1, -7.4, -8, -7.9, -7.2, -6.3, -5.1, -4, -2.9, -1.4, -0.5,
].map(deltaY => ({ deltaX: 0, deltaY, deltaMode: 0, ctrlKey: true })));

/** (4) Notched mouse, Chrome Windows: ±100 px per notch, wheelDeltaY ∓120. */
export const chromeMouseNotches: WheelSample[] = sequence(4000, 40, [
  { deltaX: 0, deltaY: -100, deltaMode: 0, wheelDeltaY: 120 },
  { deltaX: 0, deltaY: -100, deltaMode: 0, wheelDeltaY: 120 },
  { deltaX: 0, deltaY: -200, deltaMode: 0, wheelDeltaY: 240 },
  { deltaX: 0, deltaY: -100, deltaMode: 0, wheelDeltaY: 120 },
]);

/** (5) Notched mouse, Firefox: deltaMode LINE, ±3 lines per notch. */
export const firefoxMouseNotches: WheelSample[] = sequence(5000, 40, [
  { deltaX: 0, deltaY: 3, deltaMode: 1 },
  { deltaX: 0, deltaY: 3, deltaMode: 1 },
  { deltaX: 0, deltaY: 6, deltaMode: 1 },
]);

/**
 * (6) High-resolution / free-spin mouse on macOS Chrome: continuous small pixel
 * deltas, indistinguishable from a trackpad scroll. KNOWN LIMIT: pans.
 */
export const highResMouseScroll: WheelSample[] = sequence(6000, 8, [
  { deltaX: 0, deltaY: 4, deltaMode: 0, wheelDeltaY: -12 },
  { deltaX: 0, deltaY: 4, deltaMode: 0, wheelDeltaY: -12 },
  { deltaX: 0, deltaY: 8, deltaMode: 0, wheelDeltaY: -24 },
  { deltaX: 0, deltaY: 4, deltaMode: 0, wheelDeltaY: -12 },
]);

/** (7) Cmd/Ctrl + notched mouse (Chrome px and Firefox line mode). */
export const modifierMouseNotches: WheelSample[] = [
  ...sequence(7000, 40, [
    { deltaX: 0, deltaY: -100, deltaMode: 0, wheelDeltaY: 120, ctrlKey: true },
    { deltaX: 0, deltaY: 100, deltaMode: 0, wheelDeltaY: -120, metaKey: true },
  ]),
  ...sequence(7100, 40, [
    { deltaX: 0, deltaY: -3, deltaMode: 1, ctrlKey: true },
  ]),
];

/**
 * (4b) Notched mouse, Chrome macOS: scroll acceleration makes each notch a fractional
 * pixel delta with a ±120·k legacy wheelDeltaY. Shape modelled on the logged macOS
 * Chrome values in github.com/ukonpower/OREngine/pull/210; the numbers here are
 * adjusted (rounded deltas, illustrative ±120·k multiples), not copied verbatim.
 */
export const chromeMacMouseNotches: WheelSample[] = sequence(4500, 40, [
  { deltaX: 0, deltaY: -4.000244140625, deltaMode: 0, wheelDeltaY: 120 },
  { deltaX: 0, deltaY: -21.400390625, deltaMode: 0, wheelDeltaY: 120 },
  { deltaX: 0, deltaY: -52.03125, deltaMode: 0, wheelDeltaY: 240 },
  { deltaX: 0, deltaY: 316.59375, deltaMode: 0, wheelDeltaY: -360 },
]);

/** (8) Fast Chrome trackpad flick: large integer deltas that are multiples of 40 (wheelDeltaY a multiple of 120). */
export const chromeTrackpadFlick: WheelSample[] = sequence(8000, 16, [80, 67, 55, 40, 28, 16, 8].map(deltaY => ({
  deltaX: 0, deltaY, deltaMode: 0, wheelDeltaY: -3 * deltaY,
})));
