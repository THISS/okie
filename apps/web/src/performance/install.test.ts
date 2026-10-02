import { expect, it, vi } from 'vitest';
import { recordSearchTiming } from './workerTimings';
import { installPerformanceDiagnostics } from './install';

class ElementStub extends EventTarget {
  textContent = '';
  style = { cssText: '', marginLeft: '' };
  dataset = {};
  children: ElementStub[] = [];
  remove = vi.fn();
  setAttribute = vi.fn();
  append(...children: ElementStub[]) { this.children.push(...children); }
}

function installation(search = '?perf=1') {
  const target = new EventTarget();
  const docTarget = new EventTarget();
  const panels: ElementStub[] = [];
  const frames = new Set<number>();
  const timers = new Set<number>();
  let sequence = 0;
  const disconnect = vi.fn();
  class ObserverStub {
    static supportedEntryTypes = ['longtask'];
    constructor(private callback: (list: Pick<PerformanceObserverEntryList, 'getEntries'>) => void) {}
    observe = vi.fn((options: PerformanceObserverInit) => {
      if (options.buffered) this.callback({ getEntries: () => [{ name: 'private source URL', startTime: 12, duration: 60 } as PerformanceEntry] });
    });
    disconnect = disconnect;
  }
  const add = vi.fn(target.addEventListener.bind(target));
  const remove = vi.fn(target.removeEventListener.bind(target));
  const win = {
    location: { search }, performance: { now: () => 42 }, PerformanceObserver: ObserverStub,
    addEventListener: add, removeEventListener: remove,
    requestAnimationFrame: vi.fn(() => { frames.add(++sequence); return sequence; }),
    cancelAnimationFrame: vi.fn((id: number) => { frames.delete(id); }),
    setInterval: vi.fn(() => { timers.add(++sequence); return sequence; }),
    clearInterval: vi.fn((id: number) => { timers.delete(id); }),
  };
  const doc = {
    visibilityState: 'visible',
    addEventListener: docTarget.addEventListener.bind(docTarget),
    removeEventListener: docTarget.removeEventListener.bind(docTarget),
    createElement: () => new ElementStub(),
    body: { append: (panel: ElementStub) => panels.push(panel) },
  };
  const diagnostics = installPerformanceDiagnostics(win as unknown as Window & typeof globalThis, doc as unknown as Document);
  const transition = (type: 'pagehide' | 'pageshow', persisted: boolean) => target.dispatchEvent(Object.assign(new Event(type), { persisted }));
  const keyboard = () => target.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { shiftKey: true, altKey: true, code: 'KeyP', repeat: false }));
  return { diagnostics, panels, frames, timers, disconnect, add, remove, transition, keyboard };
}

it('renders actual multiline diagnostics and preserves active recording across BFCache restore', () => {
  const qa = installation();
  expect(qa.panels[0]!.children[2]!.textContent).toContain('\n');
  expect(qa.panels[0]!.children[2]!.textContent).not.toContain('\\n');
  qa.diagnostics.mark('bootstrap-start');
  qa.transition('pagehide', true);
  expect(qa.frames.size).toBe(0);
  expect(qa.timers.size).toBe(0);
  expect(qa.disconnect).toHaveBeenCalledTimes(1);
  expect(qa.panels[0]!.remove).toHaveBeenCalledTimes(1);
  expect(qa.remove).not.toHaveBeenCalled();
  qa.transition('pageshow', true);
  expect(qa.frames.size).toBe(1);
  expect(qa.timers.size).toBe(1);
  expect(qa.panels).toHaveLength(2);
  expect(qa.panels[1]!.children[2]!.textContent).toContain('bootstrap-start: 42 ms');
  // The observer stub replays its earlier task on buffered observation. Resume must not duplicate it.
  expect(qa.panels[0]!.children[2]!.textContent).toContain('long-task: 60 ms duration (1 retained)');
  expect(qa.panels[1]!.children[2]!.textContent).toContain('long-task: 60 ms duration (1 retained)');
  qa.diagnostics.dispose();
  qa.diagnostics.dispose();
  expect(qa.disconnect).toHaveBeenCalledTimes(2);
  expect(qa.frames.size).toBe(0);
  expect(qa.timers.size).toBe(0);
  expect(qa.remove.mock.calls.map(call => call[0])).toEqual(['keydown', 'pagehide', 'pageshow']);
  qa.keyboard(); qa.transition('pageshow', true);
  expect(qa.panels).toHaveLength(2);
});

it('does not resume a manually stopped recorder but keeps keyboard activation after BFCache', () => {
  const qa = installation();
  qa.panels[0]!.children[4]!.dispatchEvent(new Event('click'));
  qa.transition('pagehide', true);
  qa.transition('pageshow', true);
  expect(qa.panels).toHaveLength(1);
  expect(qa.frames.size).toBe(0);
  qa.keyboard();
  expect(qa.panels).toHaveLength(2);
  expect(qa.frames.size).toBe(1);
  qa.transition('pagehide', false);
  expect(qa.frames.size).toBe(0);
  expect(qa.timers.size).toBe(0);
  expect(qa.remove.mock.calls.map(call => call[0])).toEqual(['keydown', 'pagehide', 'pageshow']);
  qa.keyboard();
  expect(qa.panels).toHaveLength(2);
});

it('keeps a default-disabled document disabled on cache restore and allows later opt-in', () => {
  const qa = installation('');
  qa.transition('pagehide', true);
  qa.transition('pageshow', true);
  expect(qa.panels).toHaveLength(0);
  expect(qa.frames.size).toBe(0);
  qa.keyboard();
  expect(qa.panels).toHaveLength(1);
  qa.diagnostics.dispose();
});

it('records worker phase durations only while diagnostics are active', () => {
  const qa = installation('');
  recordSearchTiming('searchIndex', 99);
  qa.keyboard();
  recordSearchTiming('searchIndex', 4);
  recordSearchTiming('searchQuery', 0);
  qa.transition('pagehide', true);
  recordSearchTiming('searchIndex', 88);
  qa.transition('pageshow', true);
  expect(qa.panels[1]!.children[2]!.textContent).toContain('search-index: 4 ms duration (1 retained)');
  expect(qa.panels[1]!.children[2]!.textContent).toContain('search-query: 0 ms duration (1 retained)');
  qa.keyboard();
  recordSearchTiming('searchIndex', 77);
  qa.keyboard();
  expect(qa.panels[2]!.children[2]!.textContent).not.toContain('search-index:');
  qa.diagnostics.dispose();
});
