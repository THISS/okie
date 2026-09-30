/**
 * Wheel-intent classification for the atlas canvas (CLA-326).
 *
 * Browsers deliver trackpad two-finger scrolls, trackpad pinches and mouse
 * wheels through the same `wheel` event. The canvas wants Miro-style controls:
 *
 * - trackpad two-finger scroll → pan
 * - trackpad pinch (Chrome/Firefox: `ctrlKey` wheel) → zoom, ~1:1 with the fingers
 * - mouse wheel notch → zoom (unchanged cadence, pinned by bandPolicy.qa.test.ts)
 * - Ctrl/Cmd + any wheel → zoom
 *
 * Rules (first match wins; see `classifyWheelDevice` / `createWheelIntentClassifier`):
 *   (a) ctrlKey || metaKey → zoom. Source `pinch`, unless the event looks like a
 *       wheel notch (deltaMode ≠ pixel; or integer |deltaY| ≥ 50 with deltaX = 0)
 *       → `modifier-wheel`. The legacy wheelDeltaY is deliberately ignored here:
 *       synthetic/accelerated wheels can report ±120 with tiny deltas, and a pinch
 *       must never fall back to the slow notch gain on that signal. Trade-off:
 *       accelerated macOS Cmd/Ctrl+mouse notches (fractional deltas) zoom at the
 *       pinch gain, clamped to ×1.65 per event — noticeably faster than a plain
 *       wheel notch, and a fast spin can cross several zoom bands. Modifier events
 *       always zoom, whatever the stream latch says, and end the current latch.
 *   (b) deltaMode LINE/PAGE → mouse. Line deltas are converted to CSS px at
 *       33 px/line so a Firefox 3-line notch (±3) ≈ Chrome's ±100 px notch; a
 *       page delta counts as one ±100 px notch.
 *   (c) legacy `wheelDeltaY` (Chrome/Safari only) when nonzero: a multiple of 120
 *       that is not −3·deltaY, with deltaX = 0 → mouse; exactly −3·deltaY with an
 *       integer deltaY → trackpad (this includes fast flicks of ±40/±80 px).
 *   (d) deltaX ≠ 0 → trackpad.
 *   (e) non-integer deltaY → trackpad.
 *   (f) integer |deltaY| ≥ 50 with deltaX = 0 → mouse.
 *   (g) otherwise small integer deltas → trackpad. All-zero deltas → unknown.
 *
 * Stream latch: events less than `WHEEL_STREAM_GAP_MS` apart form one stream. The
 * first decisive event latches the stream as trackpad-pan or mouse-zoom and the
 * latch holds until a gap, so momentum tails and ambiguous events never flip a
 * gesture midway. Upgrade policy: a mouse-latched stream is upgraded to trackpad
 * by a *strong* trackpad signal only — a fractional pixel delta or a diagonal
 * (deltaX and deltaY both nonzero) delta, neither of which a notched wheel emits.
 * A trackpad latch is never downgraded (fast flicks and momentum tails can emit
 * large integer deltas). An `unknown` event outside a latch does not latch, and
 * neither does a Shift+wheel event (Shift turns a mouse notch into a horizontal
 * deltaX that would otherwise latch the stream as trackpad): it pans horizontally
 * on its own and leaves the latch untouched.
 *
 * Read order: build samples with `wheelSampleFromEvent`, which reads `deltaMode`
 * before the deltas. Firefox (88+) reports a mouse notch in pixels (≈ ±17 px on
 * macOS) instead of lines when a page reads deltaX/deltaY first, which would make
 * every Firefox mouse notch pan.
 *
 * KNOWN LIMITS (heuristic, no browser exposes the device):
 * - High-resolution / free-spin mice (e.g. Logitech MX in free-spin, Apple Magic
 *   Mouse) on macOS Chrome/Firefox emit continuous small or fractional pixel
 *   deltas and are classified as trackpads, so they pan. Cmd/Ctrl + scroll still
 *   zooms.
 * - macOS scroll acceleration shrinks notched-mouse deltas below 50 px. Chrome and
 *   Safari still read them as a mouse through the legacy wheelDeltaY (±120·k with a
 *   fractional deltaY); Firefox reads them through line deltaMode. A mouse or
 *   browser that reports small integer pixel deltas without either signal pans,
 *   and an unaccelerated notch of exactly −40 px with wheelDeltaY 120 reads as a
 *   trackpad.
 * - Ctrl + mouse notch vs. trackpad pinch is distinguished by magnitude and
 *   deltaMode only; a very large, integer pinch delta (≥ 50) reads as a notch.
 * - Firefox has no wheelDeltaY, so rule (c) never applies there.
 * - Safari reports pinch through `gesturestart/gesturechange/gestureend` (see
 *   `listenForGesturePinch`), not ctrlKey wheels.
 * - Windows precision touchpads report like macOS trackpads (pixel deltas, ctrlKey
 *   pinch) and get the same treatment; Windows mice report ±100 px (Chrome) or
 *   3 lines (Firefox) and zoom.
 */

export const DOM_DELTA_PIXEL = 0;
export const DOM_DELTA_LINE = 1;
export const DOM_DELTA_PAGE = 2;

/** CSS px per line-mode delta: a Firefox 3-line notch ≈ 100 px, matching Chrome. */
export const WHEEL_LINE_HEIGHT_PX = 33;
/** CSS px per page-mode delta: treated as a single ±100 px notch. */
export const WHEEL_PAGE_HEIGHT_PX = 100;
/** Events closer than this belong to one wheel stream (momentum ticks are ~16 ms apart). */
export const WHEEL_STREAM_GAP_MS = 150;
/** Mouse-notch zoom gain; identical to `zoomCameraAt` (pinned by bandPolicy.qa.test.ts). */
export const WHEEL_ZOOM_GAIN = 0.0012;
/** Trackpad pinch gain: a Chrome pinch summing deltaY ≈ −69 doubles the zoom (~1:1 with the fingers). */
export const PINCH_ZOOM_GAIN = 0.01;
/** Per-event clamp on pinch deltaY so a single spike cannot jump the camera. */
export const PINCH_DELTA_CLAMP = 50;

const NOTCH_MIN_PX = 50;
const LEGACY_NOTCH = 120;

export type WheelSample = {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey?: boolean;
  timeStamp: number;
  /** Legacy non-standard `WheelEvent.wheelDeltaY` (Chrome/Safari only). */
  wheelDeltaY?: number;
};

export type WheelZoomSource = 'pinch' | 'wheel' | 'modifier-wheel';

/** dx/dy/deltaY are CSS px. */
export type WheelIntent =
  | { kind: 'pan'; dx: number; dy: number }
  | { kind: 'zoom'; source: WheelZoomSource; deltaY: number };

export type WheelDevice = 'trackpad' | 'mouse' | 'unknown';

export type WheelIntentClassifier = {
  classify(sample: WheelSample): WheelIntent;
  /** Forget the current stream latch. */
  reset(): void;
};

function pixelScale(deltaMode: number): number {
  if (deltaMode === DOM_DELTA_LINE) return WHEEL_LINE_HEIGHT_PX;
  if (deltaMode === DOM_DELTA_PAGE) return WHEEL_PAGE_HEIGHT_PX;
  return 1;
}

function isLegacyNotch(sample: WheelSample): boolean {
  const legacy = sample.wheelDeltaY;
  if (legacy === undefined || legacy === 0 || legacy % LEGACY_NOTCH !== 0) return false;
  return legacy !== -3 * sample.deltaY;
}

function isLegacyTrackpad(sample: WheelSample): boolean {
  const legacy = sample.wheelDeltaY;
  if (legacy === undefined || legacy === 0) return false;
  // Chrome/Safari trackpads report wheelDeltaY = −3·deltaY with integer deltas, including
  // fast flicks of ±40/±80 (a multiple of 120). Real macOS mouse notches are accelerated
  // and fractional (−4.000244, −21.40 with ±120·k), so they never match this exactly.
  return legacy === -3 * sample.deltaY && Number.isInteger(sample.deltaY);
}

function looksLikeNotch(sample: WheelSample): boolean {
  if (sample.deltaMode !== DOM_DELTA_PIXEL) return true;
  return Math.abs(sample.deltaY) >= NOTCH_MIN_PX && Number.isInteger(sample.deltaY) && sample.deltaX === 0;
}

/** Stateless device guess for a single non-modifier wheel event (rules b–g). */
export function classifyWheelDevice(sample: WheelSample): WheelDevice {
  const { deltaX, deltaY, deltaMode } = sample;
  if (deltaMode !== DOM_DELTA_PIXEL) return 'mouse';
  if (isLegacyNotch(sample) && deltaX === 0) return 'mouse';
  if (isLegacyTrackpad(sample)) return 'trackpad';
  if (deltaX !== 0) return 'trackpad';
  if (!Number.isInteger(deltaY)) return 'trackpad';
  if (Math.abs(deltaY) >= NOTCH_MIN_PX) return 'mouse';
  if (deltaY === 0) return 'unknown';
  return 'trackpad';
}

/** A signal a notched wheel never emits; allowed to upgrade a mouse latch. */
function isStrongTrackpadSignal(sample: WheelSample): boolean {
  if (sample.deltaMode !== DOM_DELTA_PIXEL) return false;
  if (!Number.isInteger(sample.deltaY) || !Number.isInteger(sample.deltaX)) return true;
  return sample.deltaX !== 0 && sample.deltaY !== 0;
}

function zoomIntent(sample: WheelSample, source: WheelZoomSource): WheelIntent {
  return { kind: 'zoom', source, deltaY: sample.deltaY * pixelScale(sample.deltaMode) };
}

function panIntent(sample: WheelSample): WheelIntent {
  const scale = pixelScale(sample.deltaMode);
  return { kind: 'pan', dx: sample.deltaX * scale, dy: sample.deltaY * scale };
}

export function createWheelIntentClassifier(): WheelIntentClassifier {
  let latch: 'trackpad' | 'mouse' | undefined;
  let lastTimeStamp: number | undefined;

  return {
    classify(sample) {
      if (sample.ctrlKey || sample.metaKey) {
        latch = undefined;
        lastTimeStamp = undefined;
        return zoomIntent(sample, looksLikeNotch(sample) ? 'modifier-wheel' : 'pinch');
      }
      if (sample.shiftKey) return classifyWheelDevice(sample) === 'mouse' && sample.deltaX === 0 ? zoomIntent(sample, 'wheel') : panIntent(sample);
      if (lastTimeStamp === undefined || sample.timeStamp - lastTimeStamp > WHEEL_STREAM_GAP_MS || sample.timeStamp < lastTimeStamp) {
        latch = undefined;
      }
      lastTimeStamp = sample.timeStamp;
      const device = classifyWheelDevice(sample);
      if (latch === undefined) {
        if (device !== 'unknown') latch = device;
      } else if (latch === 'mouse' && device === 'trackpad' && isStrongTrackpadSignal(sample)) {
        latch = 'trackpad';
      }
      const resolved = latch ?? (Math.abs(sample.deltaY * pixelScale(sample.deltaMode)) >= NOTCH_MIN_PX ? 'mouse' : 'trackpad');
      return resolved === 'mouse' ? zoomIntent(sample, 'wheel') : panIntent(sample);
    },
    reset() {
      latch = undefined;
      lastTimeStamp = undefined;
    },
  };
}

/**
 * Reads a native wheel event into a sample. `deltaMode` is read first on purpose:
 * Firefox converts line deltas to pixels if a page reads deltaX/deltaY first.
 */
export function wheelSampleFromEvent(event: WheelEvent): WheelSample {
  const deltaMode = event.deltaMode;
  const legacy = (event as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
  return {
    deltaMode,
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    timeStamp: event.timeStamp,
    ...(legacy === undefined ? {} : { wheelDeltaY: legacy }),
  };
}

/** Multiplicative camera zoom factor for a zoom intent (> 1 zooms in). */
export function wheelZoomFactor(intent: Extract<WheelIntent, { kind: 'zoom' }>): number {
  if (intent.source === 'pinch') {
    const deltaY = Math.max(-PINCH_DELTA_CLAMP, Math.min(PINCH_DELTA_CLAMP, intent.deltaY));
    return Math.exp(-deltaY * PINCH_ZOOM_GAIN);
  }
  return Math.exp(-intent.deltaY * WHEEL_ZOOM_GAIN);
}
