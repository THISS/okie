import type { PortableAtlas } from '@okie/architecture';

let activePortableAtlas: PortableAtlas | undefined;

/** The imported bundle behind the scan fixture, available to local source readers. */
export function getActivePortableAtlas(): PortableAtlas | undefined {
  return activePortableAtlas;
}

export function setActivePortableAtlas(bundle: PortableAtlas | undefined): void {
  activePortableAtlas = bundle;
}

export function isPortableMode(search: string, portableMarker: boolean): boolean {
  return portableMarker || new URLSearchParams(search).get('portable') === '1';
}

/**
 * A portable URL may have no navigation identity yet, in which case App should
 * use the newly loaded bundle's defaults. Only reject a URL when it explicitly
 * names a different repository or snapshot.
 */
export function portableNavigationDiffers(
  search: string,
  atlas: { snapshot: Pick<PortableAtlas['snapshot'], 'repositoryId' | 'id'> },
): boolean {
  const params = new URLSearchParams(search);
  const repositoryId = params.getAll('repo').at(-1) ?? null;
  const snapshotId = params.getAll('snap').at(-1) ?? null;
  return (repositoryId !== null && repositoryId !== atlas.snapshot.repositoryId)
    || (snapshotId !== null && snapshotId !== atlas.snapshot.id);
}

/** A replacement atlas must not inherit navigation for entities in the previous one. */
export function portableReloadPath(location: Pick<Location, 'pathname' | 'hash'>, openPicker = false): string {
  return `${location.pathname}?portable=1${openPicker ? '&open=1' : ''}${location.hash}`;
}
