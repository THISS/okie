import { describe, expect, it } from 'vitest';
import {
  canonicalNavigationState,
  canonicalNavigationUrl,
  navigationStateFromUrl,
  serializeNavigationState,
  type NavigationDefaults,
  type NavigationReferences,
} from './navigationState';

const defaults: NavigationDefaults = {
  repositoryId: 'repo:okie',
  snapshotId: 'snapshot:current',
  viewId: 'view:main',
  rootEntityId: 'system:okie',
  selectedId: 'system:okie',
  camera: { x: 0, y: 0, zoom: 1 },
};
const knownKinds = new Set(['calls', 'uses', 'reads']);
const references: NavigationReferences = {
  hasSnapshot: id => id === 'snapshot:current',
  hasEntity: id => id === 'system:okie',
  hasRelationKind: kind => knownKinds.has(kind),
};
const base = 'https://atlas.test/';

function decode(query: string) {
  return navigationStateFromUrl(`${base}?${query}`, defaults, { references });
}

describe('path navigation state (CLA-208)', () => {
  it('round-trips path keys canonically: sorted, deduped kinds; containment; subtree scope', () => {
    const state = canonicalNavigationState({
      ...defaults,
      path: { fromId: 'component:b', toId: 'component:a', kinds: ['uses', 'calls', 'uses'], containment: true, scope: 'subtree' },
    }, defaults);
    expect(state.path).toEqual({ fromId: 'component:b', toId: 'component:a', kinds: ['calls', 'uses'], containment: true, scope: 'subtree' });
    const url = canonicalNavigationUrl(state, base);
    expect(new URL(url).search).toContain('pfrom=component%3Ab&pto=component%3Aa&pkind=calls&pkind=uses&pcont=1&pscope=subtree');
    const decoded = navigationStateFromUrl(url, defaults, { references });
    expect(decoded.state.path).toEqual(state.path);
    expect(decoded.warnings).toEqual([]);
    expect(decoded.canonicalUrl).toBe(url);
    expect(JSON.parse(serializeNavigationState(decoded.state)).path).toEqual(state.path);
  });

  it('canonicalizes shuffled/duplicated kinds in URLs and omits defaults', () => {
    const decoded = decode('snap=snapshot%3Acurrent&pfrom=a&pto=b&pkind=uses&pkind=calls&pkind=uses');
    expect(decoded.state.path).toEqual({ fromId: 'a', toId: 'b', kinds: ['calls', 'uses'], containment: false, scope: 'exact' });
    expect(decoded.canonicalUrl).toContain('pfrom=a&pto=b&pkind=calls&pkind=uses');
    expect(decoded.canonicalUrl).not.toContain('pcont');
    expect(decoded.canonicalUrl).not.toContain('pscope');
    expect(decoded.canonicalUrl).not.toContain('psnap');
  });

  it('keeps stale endpoint IDs raw instead of falling back to defaults', () => {
    const decoded = decode('pfrom=code%3Arenamed&pto=code%3Agone&pkind=calls');
    expect(decoded.state.path?.fromId).toBe('code:renamed');
    expect(decoded.state.path?.toId).toBe('code:gone');
    expect(decoded.warnings).toEqual([]);
  });

  it('warns on unknown kinds but keeps them so the explorer can refuse honestly', () => {
    const decoded = decode('pfrom=a&pto=b&pkind=calls&pkind=teleports');
    expect(decoded.state.path?.kinds).toEqual(['calls', 'teleports']);
    expect(decoded.warnings).toContain('Unknown path relation kind teleports.');
  });

  it('records the link snapshot when it differs from the loaded snapshot', () => {
    const decoded = decode('snap=snapshot%3Aolder&pfrom=a&pto=b&pkind=calls');
    expect(decoded.state.snapshotId).toBe('snapshot:current');
    expect(decoded.state.path?.snapshotId).toBe('snapshot:older');
    expect(decoded.canonicalUrl).toContain('psnap=snapshot%3Aolder');
    // The pinned mismatch survives a reload of the canonical URL.
    expect(navigationStateFromUrl(decoded.canonicalUrl, defaults, { references }).state.path?.snapshotId).toBe('snapshot:older');
    // Matching snapshots never carry psnap.
    expect(decode('snap=snapshot%3Acurrent&pfrom=a&pto=b').state.path).not.toHaveProperty('snapshotId');
  });

  it('ignores incomplete paths and invalid option values with warnings', () => {
    const incomplete = decode('pfrom=a&pkind=calls');
    expect(incomplete.state.path).toBeUndefined();
    expect(incomplete.warnings).toContain('Incomplete path parameters; ignoring the path.');
    const invalid = decode('pfrom=a&pto=b&pcont=yes&pscope=wide');
    expect(invalid.state.path).toMatchObject({ containment: false, scope: 'exact' });
    expect(invalid.warnings.some(warning => warning.includes('containment'))).toBe(true);
    expect(invalid.warnings.some(warning => warning.includes('scope'))).toBe(true);
  });

  it('drops the path when it is cleared and preserves it across unrelated state edits', () => {
    const withPath = canonicalNavigationState({ ...defaults, path: { fromId: 'a', toId: 'b', kinds: [], containment: false, scope: 'exact' } }, defaults);
    const moved = canonicalNavigationState({ ...withPath, camera: { x: 5, y: 5, zoom: 2 } }, defaults);
    expect(moved.path).toEqual(withPath.path);
    expect(canonicalNavigationState({ ...withPath, path: undefined }, defaults).path).toBeUndefined();
  });
});
