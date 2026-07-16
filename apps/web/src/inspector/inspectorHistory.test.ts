import { describe, expect, it } from 'vitest';
import { inspectorHistoryRestorePlan, popInspectorHistory, pushInspectorHistory, type InspectorHistoryNavigation, type InspectorHistorySubject } from './inspectorHistory';
import type { NavigationState } from '../navigation/navigationState';

const entityNavigation: InspectorHistoryNavigation = {
  camera: { x: 120, y: 80, zoom: 5.15 },
  detail: 'context',
  lensPath: ['system:okie', 'container:model'],
};

const relationNavigation: InspectorHistoryNavigation = {
  camera: { x: 40, y: 25, zoom: 2.05 },
  detail: 'context',
  lensPath: ['system:okie'],
};

describe('details-panel navigation history', () => {
  it('restores entity and relation presentations in local LIFO order', () => {
    const entity: InspectorHistorySubject = { kind: 'entity', entityId: 'component:scope', tab: 'source', navigation: entityNavigation };
    const relation: InspectorHistorySubject = {
      kind: 'relation',
      relationId: 'relation:scope-select',
      ownerEntityId: 'component:scope',
      tab: 'details',
      navigation: relationNavigation,
    };
    const history = pushInspectorHistory(pushInspectorHistory([], entity), relation);

    const first = popInspectorHistory(history);
    const second = popInspectorHistory(first.history);

    expect(first.subject).toEqual(relation);
    expect(second.subject).toEqual(entity);
    expect(second.history).toEqual([]);
  });

  it('does not add consecutive duplicate panel subjects', () => {
    const subject: InspectorHistorySubject = { kind: 'entity', entityId: 'component:scope', tab: 'details', navigation: entityNavigation };
    expect(pushInspectorHistory(pushInspectorHistory([], subject), subject)).toEqual([subject]);
  });

  it('returns an inert empty result instead of delegating to browser history', () => {
    expect(popInspectorHistory([])).toEqual({ history: [] });
  });

  it('bounds long panel sessions while retaining the newest subject', () => {
    const history = Array.from({ length: 40 }, (_, index) => ({
      kind: 'entity' as const,
      entityId: `entity:${index}`,
      tab: 'details' as const,
      navigation: entityNavigation,
    })).reduce<InspectorHistorySubject[]>((current, subject) => pushInspectorHistory(current, subject), []);

    expect(history).toHaveLength(32);
    expect(history[0]).toMatchObject({ entityId: 'entity:8' });
    expect(history.at(-1)).toMatchObject({ entityId: 'entity:39' });
  });

  it.each([
    { subject: { kind: 'entity', entityId: 'component:scope', tab: 'details', navigation: entityNavigation } as const, selectedId: 'component:scope' },
    { subject: { kind: 'relation', relationId: 'relation:scope-select', ownerEntityId: 'component:model', tab: 'details', navigation: relationNavigation } as const, selectedId: 'component:model' },
  ])('restores the $subject.kind camera and selection with replace semantics', ({ subject, selectedId }) => {
    const current: NavigationState = {
      version: 1,
      repositoryId: 'repo:okie',
      snapshotId: 'snapshot:1',
      viewId: 'view:main',
      rootEntityId: 'system:okie',
      selectedId: 'component:other',
      camera: { x: 999, y: 888, zoom: 14 },
      detail: 'code',
      lensPath: ['stale:path'],
      filterId: 'filter:owned',
    };

    const plan = inspectorHistoryRestorePlan(current, subject);

    expect(plan.mode).toBe('replace');
    expect(plan.state).toMatchObject({
      selectedId,
      camera: subject.navigation.camera,
      detail: subject.navigation.detail,
      lensPath: subject.navigation.lensPath,
      filterId: 'filter:owned',
    });
  });
});
