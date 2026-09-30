import { describe, expect, it } from 'vitest';
import {
  chromeMouseNotches,
  chromeTrackpadPinch,
  chromeTrackpadScroll,
  firefoxMouseNotches,
  firefoxTrackpadScroll,
  highResMouseScroll,
  modifierMouseNotches,
} from './wheelFixtures';
import {
  classifyWheelDevice,
  createWheelIntentClassifier,
  PINCH_DELTA_CLAMP,
  PINCH_ZOOM_GAIN,
  WHEEL_LINE_HEIGHT_PX,
  WHEEL_STREAM_GAP_MS,
  wheelZoomFactor,
  type WheelIntent,
  type WheelSample,
} from './wheelIntent';

function classifyAll(samples: WheelSample[]): WheelIntent[] {
  const classifier = createWheelIntentClassifier();
  return samples.map(sample => classifier.classify(sample));
}

function sample(overrides: Partial<WheelSample>): WheelSample {
  return { deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, timeStamp: 0, ...overrides };
}

describe('classifyWheelDevice (stateless rules)', () => {
  it('reads documented trackpad scroll shapes as trackpad on every event', () => {
    for (const event of [...chromeTrackpadScroll, ...firefoxTrackpadScroll]) {
      expect(classifyWheelDevice(event)).toBe('trackpad');
    }
  });

  it('reads notched mice as mouse on every event', () => {
    for (const event of [...chromeMouseNotches, ...firefoxMouseNotches]) {
      expect(classifyWheelDevice(event)).toBe('mouse');
    }
  });

  it('KNOWN LIMIT: a high-resolution mouse emitting small pixel deltas reads as trackpad', () => {
    for (const event of highResMouseScroll) expect(classifyWheelDevice(event)).toBe('trackpad');
  });

  it('applies the rules in order', () => {
    expect(classifyWheelDevice(sample({ deltaY: 1, deltaMode: 1 }))).toBe('mouse'); // (b)
    expect(classifyWheelDevice(sample({ deltaY: 2, deltaMode: 2 }))).toBe('mouse'); // (b) page
    expect(classifyWheelDevice(sample({ deltaY: 4, wheelDeltaY: -120 }))).toBe('mouse'); // (c) notch beats small magnitude
    expect(classifyWheelDevice(sample({ deltaY: 60, wheelDeltaY: -180 }))).toBe('trackpad'); // (c) −3·deltaY beats magnitude
    expect(classifyWheelDevice(sample({ deltaY: 40, wheelDeltaY: -120 }))).toBe('trackpad'); // (c) inconclusive → (g)
    expect(classifyWheelDevice(sample({ deltaY: 120, wheelDeltaY: -360 }))).toBe('mouse'); // (c) inconclusive → (f)
    expect(classifyWheelDevice(sample({ deltaX: 100, deltaY: 0 }))).toBe('trackpad'); // (d)
    expect(classifyWheelDevice(sample({ deltaY: 51.5 }))).toBe('trackpad'); // (e)
    expect(classifyWheelDevice(sample({ deltaY: -100 }))).toBe('mouse'); // (f)
    expect(classifyWheelDevice(sample({ deltaY: 12 }))).toBe('trackpad'); // (g)
    expect(classifyWheelDevice(sample({}))).toBe('unknown');
  });
});

describe('wheel intent classifier', () => {
  it('pans a Chrome trackpad scroll, momentum tail included, 1:1 in CSS px', () => {
    const intents = classifyAll(chromeTrackpadScroll);
    intents.forEach((intent, index) => {
      expect(intent).toEqual({ kind: 'pan', dx: chromeTrackpadScroll[index]!.deltaX, dy: chromeTrackpadScroll[index]!.deltaY });
    });
  });

  it('pans a Firefox trackpad scroll', () => {
    expect(classifyAll(firefoxTrackpadScroll).every(intent => intent.kind === 'pan')).toBe(true);
  });

  it('zooms Chrome trackpad pinch as pinch, keeping raw deltaY', () => {
    const intents = classifyAll(chromeTrackpadPinch);
    intents.forEach((intent, index) => {
      expect(intent).toEqual({ kind: 'zoom', source: 'pinch', deltaY: chromeTrackpadPinch[index]!.deltaY });
    });
  });

  it('zooms Chrome mouse notches as wheel', () => {
    for (const intent of classifyAll(chromeMouseNotches)) expect(intent).toMatchObject({ kind: 'zoom', source: 'wheel' });
  });

  it('zooms Firefox line-mode notches as wheel, converting 3 lines to ~100 px', () => {
    const [first] = classifyAll(firefoxMouseNotches);
    expect(first).toEqual({ kind: 'zoom', source: 'wheel', deltaY: 3 * WHEEL_LINE_HEIGHT_PX });
    expect(Math.abs(3 * WHEEL_LINE_HEIGHT_PX - 100)).toBeLessThanOrEqual(1);
  });

  it('KNOWN LIMIT: a high-resolution mouse stream pans', () => {
    expect(classifyAll(highResMouseScroll).every(intent => intent.kind === 'pan')).toBe(true);
  });

  it('zooms Cmd/Ctrl + mouse notches as modifier-wheel', () => {
    for (const intent of classifyAll(modifierMouseNotches)) expect(intent).toMatchObject({ kind: 'zoom', source: 'modifier-wheel' });
    const [, , firefoxLine] = classifyAll(modifierMouseNotches);
    expect(firefoxLine).toEqual({ kind: 'zoom', source: 'modifier-wheel', deltaY: -3 * WHEEL_LINE_HEIGHT_PX });
  });

  it('holds a trackpad latch through ambiguous large integer momentum events', () => {
    const classifier = createWheelIntentClassifier();
    expect(classifier.classify(sample({ deltaY: 4, timeStamp: 0 })).kind).toBe('pan');
    // Firefox-style large integer tail (no wheelDeltaY): stateless rule says mouse.
    expect(classifyWheelDevice(sample({ deltaY: 80, timeStamp: 16 }))).toBe('mouse');
    expect(classifier.classify(sample({ deltaY: 80, timeStamp: 16 }))).toEqual({ kind: 'pan', dx: 0, dy: 80 });
  });

  it('holds a mouse latch through small integer events, but a strong trackpad signal upgrades it', () => {
    const classifier = createWheelIntentClassifier();
    expect(classifier.classify(sample({ deltaY: 100, timeStamp: 0 })).kind).toBe('zoom');
    expect(classifier.classify(sample({ deltaY: 12, timeStamp: 40 })).kind).toBe('zoom');
    // Pure horizontal (tilt wheel) is not a strong signal.
    expect(classifier.classify(sample({ deltaX: 100, deltaY: 0, timeStamp: 80 })).kind).toBe('zoom');
    // A fractional delta is: notched wheels never emit one.
    expect(classifier.classify(sample({ deltaY: 3.5, timeStamp: 120 })).kind).toBe('pan');
    expect(classifier.classify(sample({ deltaY: 100, timeStamp: 140 })).kind).toBe('pan');
  });

  it('re-classifies after a stream gap', () => {
    const classifier = createWheelIntentClassifier();
    expect(classifier.classify(sample({ deltaY: 4, timeStamp: 0 })).kind).toBe('pan');
    expect(classifier.classify(sample({ deltaY: 100, timeStamp: 100 })).kind).toBe('pan');
    expect(classifier.classify(sample({ deltaY: 100, timeStamp: 100 + WHEEL_STREAM_GAP_MS + 1 })).kind).toBe('zoom');
  });

  it('always zooms modifier events regardless of the latch, then starts a fresh stream', () => {
    const classifier = createWheelIntentClassifier();
    expect(classifier.classify(sample({ deltaY: 4, timeStamp: 0 })).kind).toBe('pan');
    expect(classifier.classify(sample({ deltaY: -2.5, ctrlKey: true, timeStamp: 16 }))).toMatchObject({ kind: 'zoom', source: 'pinch' });
    expect(classifier.classify(sample({ deltaY: 100, timeStamp: 32 })).kind).toBe('zoom');
  });

  it('does not latch on an all-zero event', () => {
    const classifier = createWheelIntentClassifier();
    expect(classifier.classify(sample({ timeStamp: 0 })).kind).toBe('pan');
    expect(classifier.classify(sample({ deltaY: 100, timeStamp: 16 })).kind).toBe('zoom');
  });
});

describe('wheel zoom factor', () => {
  it('maps a Chrome pinch summing deltaY ≈ −69 to ≈ 2× zoom', () => {
    const total = chromeTrackpadPinch.reduce((sum, event) => sum + event.deltaY, 0);
    expect(total).toBeCloseTo(-69.3, 1);
    const factor = classifyAll(chromeTrackpadPinch)
      .reduce((product, intent) => product * (intent.kind === 'zoom' ? wheelZoomFactor(intent) : 1), 1);
    expect(factor).toBeCloseTo(2, 1);
    expect(factor).toBeCloseTo(Math.exp(69.3 * PINCH_ZOOM_GAIN), 6);
  });

  it('clamps a single pinch spike', () => {
    const spike = wheelZoomFactor({ kind: 'zoom', source: 'pinch', deltaY: -500 });
    expect(spike).toBeCloseTo(Math.exp(PINCH_DELTA_CLAMP * PINCH_ZOOM_GAIN));
  });

  it('keeps the mouse-notch factor identical to zoomCameraAt', () => {
    for (const deltaY of [-100, 100, -200, 99]) {
      expect(wheelZoomFactor({ kind: 'zoom', source: 'wheel', deltaY })).toBe(Math.exp(-deltaY * 0.0012));
      expect(wheelZoomFactor({ kind: 'zoom', source: 'modifier-wheel', deltaY })).toBe(Math.exp(-deltaY * 0.0012));
    }
  });
});
