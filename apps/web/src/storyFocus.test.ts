import { describe, expect, it } from 'vitest';
import { storyFocusPresentation, storyStepSelectedId } from './storyFocus';

describe('story focus ownership', () => {
  it('keeps an off-target logical selection out of later story focus and masks', () => {
    const laterSteps = [
      ['orders', 'payments'],
      ['orders', 'order-db', 'events'],
      ['events', 'fulfilment'],
    ];
    for (const targetIds of laterSteps) {
      const presentation = storyFocusPresentation('gateway', targetIds, [], {
        storyOpen: true,
        selectionOverride: false,
      });
      expect(presentation.selectedId).toBeUndefined();
      expect(presentation.focusedIds).toEqual(new Set(targetIds));
      expect(presentation.requiredIds.has('gateway')).toBe(false);
      expect(presentation.relationIds.size).toBe(0);
    }
  });

  it('restores selection after close and lets an explicit selection override the story', () => {
    const closed = storyFocusPresentation('gateway', [], [], {
      storyOpen: false,
      selectionOverride: false,
    });
    expect(closed.selectedId).toBe('gateway');
    expect(closed.requiredIds).toEqual(new Set(['gateway']));

    const overridden = storyFocusPresentation('payments', ['orders'], ['api-orders'], {
      storyOpen: true,
      selectionOverride: true,
      pickedRelationId: 'orders-payments',
    });
    expect(overridden.selectedId).toBe('payments');
    expect(overridden.focusedIds.size).toBe(0);
    expect(overridden.requiredIds).toEqual(new Set(['payments']));
    expect(overridden.relationIds).toEqual(new Set(['orders-payments']));
  });
});

describe('storyStepSelectedId', () => {
  it('picks the first focus entity that is present, else the authored primary', () => {
    expect(storyStepSelectedId(['system:okie', 'external:browser'], ['external:browser', 'system:okie']))
      .toBe('system:okie');
    expect(storyStepSelectedId(['code:missing', 'system:okie'], ['system:okie'])).toBe('system:okie');
    expect(storyStepSelectedId(['system:okie'], [])).toBe('system:okie');
    expect(storyStepSelectedId([], ['system:okie'])).toBeUndefined();
  });
});
