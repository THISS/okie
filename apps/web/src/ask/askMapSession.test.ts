import { describe, expect, it } from 'vitest';
import { askMapShouldCaptureReturn, askMapStepIsCurrent, askMapViewShouldReset, askPanelReframeDue } from './askMapSession';

describe('Ask Show on map session decisions', () => {
  it('lets a Show step act only while no user action superseded it', () => {
    // Before the drill selects anything: generation alone decides.
    expect(askMapStepIsCurrent({ generation: 3 }, { generation: 3, selectionId: 'system:okie' })).toBe(true);
    // A user action bumped the generation (click, chip, back/forward, visibility change).
    expect(askMapStepIsCurrent({ generation: 3 }, { generation: 4 })).toBe(false);
    // The drill landed on its target.
    expect(askMapStepIsCurrent({ generation: 3, target: 'component:a' }, { generation: 3, selectionId: 'component:a' })).toBe(true);
    // The drill was dropped or the selection moved elsewhere: do not isolate, frame or close panels.
    expect(askMapStepIsCurrent({ generation: 3, target: 'component:a' }, { generation: 3, selectionId: 'component:b' })).toBe(false);
    expect(askMapStepIsCurrent({ generation: 3, target: 'component:a' }, { generation: 3 })).toBe(false);
    expect(askMapStepIsCurrent({ generation: 3, target: 'component:a' }, { generation: 5, selectionId: 'component:a' })).toBe(false);
  });

  it('drops the saved view whenever the map leaves isolate, by any path', () => {
    expect(askMapViewShouldReset('isolate', 'all')).toBe(true);
    expect(askMapViewShouldReset('isolate', 'dim')).toBe(true);
    expect(askMapViewShouldReset('isolate', 'isolate')).toBe(false);
    // Entering isolate (the Show itself) or moving between non-isolate modes keeps it.
    expect(askMapViewShouldReset('all', 'isolate')).toBe(false);
    expect(askMapViewShouldReset('all', 'dim')).toBe(false);
  });

  it('captures the Restore view once per Ask isolate, re-capturing when the map is not one', () => {
    expect(askMapShouldCaptureReturn({ hasReturn: false, askIsolateActive: false, showInFlight: false })).toBe(true);
    // Second Show from the first Show's isolate: keep the original pre-Show view.
    expect(askMapShouldCaptureReturn({ hasReturn: true, askIsolateActive: true, showInFlight: false })).toBe(false);
    // A second Show while the first is still drilling: the map is mid-flight, keep the original.
    expect(askMapShouldCaptureReturn({ hasReturn: true, askIsolateActive: false, showInFlight: true })).toBe(false);
    // A leftover view while the map is no longer an Ask isolate is stale: re-capture.
    expect(askMapShouldCaptureReturn({ hasReturn: true, askIsolateActive: false, showInFlight: false })).toBe(true);
  });

  it('reframes for the Ask panel only on an open / submit gesture', () => {
    // Open: closed → empty with a new request.
    expect(askPanelReframeDue('empty', 1, 0)).toBe(true);
    // Thread loading asynchronously (empty → thread) with no new request.
    expect(askPanelReframeDue('thread', 1, 1)).toBe(false);
    // Panel reappearing after a story ends: no request.
    expect(askPanelReframeDue('thread', 2, 2)).toBe(false);
    // Submit on an existing thread.
    expect(askPanelReframeDue('thread', 3, 2)).toBe(true);
    // Hidden panel (story playing / closed) never reframes; the request waits for it to show.
    expect(askPanelReframeDue('closed', 4, 3)).toBe(false);
  });
});
