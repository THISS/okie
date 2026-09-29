import { describe, expect, it } from 'vitest';
import { bootPlan, type BootPlanInput } from './bootPlan';
import type { MobileGateInput } from './mobileGate';

const desktop: MobileGateInput = { width: 1440, height: 900, coarsePointer: false, noHover: false, framed: false, embedQuery: false, dismissed: false };
const phone: MobileGateInput = { ...desktop, width: 390, height: 844, coarsePointer: true, noHover: true };

function plan(pathname: string, overrides: Partial<BootPlanInput> = {}) {
  return bootPlan({ pathname, search: '', portableMarker: false, gate: desktop, ...overrides }).kind;
}

describe('CLA-318 boot plan', () => {
  it('routes each path on desktop', () => {
    expect(plan('/')).toBe('atlas');
    expect(plan('/index.html')).toBe('atlas');
    expect(plan('/r/acme/app')).toBe('atlas');
    expect(plan('/new')).toBe('landing');
    expect(plan('/new/')).toBe('landing');
    expect(plan('/operator')).toBe('operator');
    expect(plan('/operator/')).toBe('operator');
    expect(plan('/zzz')).toBe('notFound');
    expect(plan('/r/acme')).toBe('notFound');
    expect(plan('/operator/x')).toBe('notFound');
  });

  it('gates only atlas routes on a phone', () => {
    const route = bootPlan({ pathname: '/r/acme/app', search: '', portableMarker: false, gate: phone });
    expect(route).toEqual({ kind: 'mobileNotice', route: expect.objectContaining({ kind: 'repo', owner: 'acme', repo: 'app' }) });
    expect(plan('/', { gate: phone })).toBe('mobileNotice');
    // Never the landing, the 404, operator or the portable viewer.
    expect(plan('/new', { gate: phone })).toBe('landing');
    expect(plan('/zzz', { gate: phone })).toBe('notFound');
    expect(plan('/operator', { gate: phone })).toBe('operator');
    expect(plan('/r/acme/app', { gate: phone, search: '?portable=1' })).toBe('portable');
    expect(plan('/anything/at/all', { gate: phone, portableMarker: true })).toBe('portable');
  });

  it('never gates embeds, a dismissed notice or a desktop window', () => {
    expect(plan('/r/acme/app', { gate: { ...phone, embedQuery: true } })).toBe('atlas');
    expect(plan('/r/acme/app', { gate: { ...phone, framed: true } })).toBe('atlas');
    expect(plan('/r/acme/app', { gate: { ...phone, dismissed: true } })).toBe('atlas');
    expect(plan('/r/acme/app', { gate: { ...desktop, width: 390 } })).toBe('atlas');
  });

  it('checks portable first: a portable folder at any path is never a 404', () => {
    expect(plan('/some/folder/index.html', { portableMarker: true })).toBe('portable');
    expect(plan('/some/folder/', { search: '?portable=1' })).toBe('portable');
    expect(plan('/some/folder/')).toBe('notFound');
  });
});
