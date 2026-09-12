import { describe, expect, it } from 'vitest';
import { isPortableMode, portableNavigationDiffers, portableReloadPath } from './runtime';

const atlas = {
  snapshot: { repositoryId: 'repo:current', id: 'snapshot:current' },
} as const;

describe('portable viewer routing', () => {
  it('activates only for the explicit query flag or packaged build marker', () => {
    expect(isPortableMode('?portable=1', false)).toBe(true);
    expect(isPortableMode('?fixture=scan', true)).toBe(true);
    expect(isPortableMode('?fixture=scan', false)).toBe(false);
  });

  it('restarts replacement scans with a stable portable identity and no old navigation', () => {
    expect(portableReloadPath({ pathname: '/r/acme/app', hash: '#detail' })).toBe('/r/acme/app?portable=1#detail');
    expect(portableReloadPath({ pathname: '/', hash: '' }, true)).toBe('/?portable=1&open=1');
  });

  it('resets explicit stale navigation identities but preserves matching deep links', () => {
    expect(portableNavigationDiffers('?portable=1&repo=repo%3Aold&snap=snapshot%3Aold&cx=999', atlas)).toBe(true);
    expect(portableNavigationDiffers('?portable=1&repo=repo%3Acurrent&snap=snapshot%3Acurrent&cx=999', atlas)).toBe(false);
    expect(portableNavigationDiffers('?portable=1&repo=repo%3Aold&repo=repo%3Acurrent&snap=snapshot%3Acurrent', atlas)).toBe(false);
    expect(portableNavigationDiffers('?portable=1&cx=999', atlas)).toBe(false);
  });
});
