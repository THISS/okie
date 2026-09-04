import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  explorerBrowseEntities,
  explorerEntitiesForView,
  explorerScopeParentId,
} from './entityExplorer';
import { createGoldenC4Scene } from './renderer/goldenC4Scene';
import type { SceneEntity, SemanticDetail } from './renderer/types';
import { DEFAULT_SEARCH_RESULT_LIMIT, searchArchitectureEntities } from './searchSuggestions';
import { semanticLevelSession } from './semantic/semanticLensEngine';

function entity(
  id: string,
  detail: SemanticDetail,
  parentId?: string,
  name = id,
): SceneEntity {
  return {
    id,
    ...(parentId !== undefined ? { parentId } : {}),
    name,
    kind: detail === 'context' ? 'system' : detail === 'container' ? 'container' : 'component',
    detail,
    responsibility: name,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
  };
}

const system = entity('system:okie', 'context');
const otherSystem = entity('system:other', 'context');
const web = entity('container:web', 'container', 'system:okie');
const model = entity('container:model', 'container', 'system:okie');
const otherContainer = entity('container:other', 'container', 'system:other');
const shell = entity('component:shell', 'component', 'container:web');
const schema = entity('component:schema', 'component', 'container:model');
const otherComponent = entity('component:other', 'component', 'container:other');
const nestedCode = entity('code:shell:app', 'code', 'component:shell', 'App');
const siblingCode = entity('code:shell:viewport', 'code', 'component:shell', 'CanvasViewport');
const otherCode = entity('code:schema:snapshot', 'code', 'component:schema', 'snapshot');
const melted = Array.from({ length: 1_800 }, (_, index) => (
  entity(`code:other:${index}`, 'code', 'component:other', `melted-${index}`)
));

const entities = [
  system, otherSystem, web, model, otherContainer, shell, schema, otherComponent,
  nestedCode, siblingCode, otherCode, ...melted,
];
const scene = {
  entities,
  projection: {
    entityIdsByDetail: {
      context: [system.id, otherSystem.id],
      container: [system.id, otherSystem.id, web.id, model.id, otherContainer.id],
      component: [web.id, model.id, otherContainer.id, shell.id, schema.id, otherComponent.id],
      code: [shell.id, schema.id, otherComponent.id, nestedCode.id, siblingCode.id, otherCode.id, ...melted.map(item => item.id)],
    },
  },
};

describe('explorerScopeParentId', () => {
  it('has no owner at context', () => {
    expect(explorerScopeParentId({
      detail: 'context',
      selected: nestedCode,
      entities,
      settledTargetIds: ['system:okie', 'container:web', 'component:shell'],
    })).toBeUndefined();
  });

  it('prefers the nested lens target at the previous band', () => {
    expect(explorerScopeParentId({
      detail: 'code',
      selected: system,
      entities,
      settledTargetIds: ['system:okie', 'container:web', 'component:shell'],
    })).toBe('component:shell');
    expect(explorerScopeParentId({
      detail: 'component',
      selected: system,
      entities,
      settledTargetIds: ['system:okie', 'container:web'],
    })).toBe('container:web');
  });

  it('walks the selection to the previous band when the lens is idle', () => {
    expect(explorerScopeParentId({
      detail: 'code',
      selected: nestedCode,
      entities,
    })).toBe('component:shell');
  });

  it('does not fall back to the system root at code detail', () => {
    expect(explorerScopeParentId({
      detail: 'code',
      selected: system,
      entities,
    })).toBeUndefined();
  });

  it('CLA-78: Code rail on an opened container scopes L4 to that container, not empty', () => {
    expect(explorerScopeParentId({
      detail: 'code',
      selected: web,
      entities,
    })).toBe('container:web');
    expect(explorerScopeParentId({
      detail: 'code',
      selected: system,
      entities,
      settledTargetIds: ['system:okie', 'container:web'],
    })).toBe('container:web');
  });
});

describe('explorerBrowseEntities — code detail is scoped, not a flat L4 dump', () => {
  it('lists only the current component’s code entities when 1.8k L4 rows exist', () => {
    const rows = explorerBrowseEntities(scene, {
      detail: 'code',
      parentId: 'component:shell',
      visibleIds: scene.projection.entityIdsByDetail.code,
    });
    expect(rows.map(item => item.id).sort()).toEqual(['code:shell:app', 'code:shell:viewport', 'component:shell']);
    expect(rows).toHaveLength(3);
    expect(rows.some(item => item.id.startsWith('code:other:'))).toBe(false);
    expect(scene.entities.filter(item => item.detail === 'code')).toHaveLength(1_803);
  });

  it('does not dump the whole code band when no C4 parent is known', () => {
    const rows = explorerBrowseEntities(scene, {
      detail: 'code',
      visibleIds: scene.projection.entityIdsByDetail.code,
    });
    expect(rows).toEqual([]);
  });

  it('keeps container browse under the current system', () => {
    expect(explorerBrowseEntities(scene, {
      detail: 'container',
      parentId: 'system:okie',
    }).map(item => item.id)).toEqual(['system:okie', 'container:web', 'container:model']);
  });

  it('lists the whole context band when there is no parent', () => {
    expect(explorerBrowseEntities(scene, {
      detail: 'context',
    }).map(item => item.id)).toEqual(['system:okie', 'system:other']);
  });

  it('intersects the visible projection so omitted branch members stay out', () => {
    const rows = explorerBrowseEntities(scene, {
      detail: 'code',
      parentId: 'component:shell',
      visibleIds: [nestedCode.id],
    });
    expect(rows.map(item => item.id)).toEqual(['code:shell:app']);
  });
});

describe('explorerEntitiesForView', () => {
  it('scopes code detail through the nested lens rather than every L4 entity', () => {
    const rows = explorerEntitiesForView(scene, {
      detail: 'code',
      selected: system,
      settledTargetIds: ['system:okie', 'container:web', 'component:shell'],
      visibleIds: scene.projection.entityIdsByDetail.code,
    });
    expect(rows.map(item => item.id)).toEqual(['component:shell', 'code:shell:app', 'code:shell:viewport']);
  });

  it('scopes an idle code selection to its component parent', () => {
    const rows = explorerEntitiesForView(scene, {
      detail: 'code',
      selected: nestedCode,
      visibleIds: scene.projection.entityIdsByDetail.code,
    });
    expect(rows.map(item => item.id)).toEqual(['component:shell', 'code:shell:app', 'code:shell:viewport']);
  });

  it('CLA-78: Code rail on an opened container lists that neighborhood’s L4, not every declaration', () => {
    const rows = explorerEntitiesForView(scene, {
      detail: 'code',
      selected: web,
      visibleIds: scene.projection.entityIdsByDetail.code,
    });
    expect(rows.map(item => item.id)).toEqual(['component:shell', 'code:shell:app', 'code:shell:viewport']);
    expect(rows.some(item => item.id.startsWith('code:other:'))).toBe(false);
    expect(rows.some(item => item.id === 'code:schema:snapshot')).toBe(false);
  });
});

describe('search still finds a nested code entity outside the browse set', () => {
  it('matches a melted L4 name that the scoped explorer does not list', () => {
    const browse = explorerEntitiesForView(scene, {
      detail: 'code',
      selected: nestedCode,
      visibleIds: scene.projection.entityIdsByDetail.code,
    });
    expect(browse.some(item => item.id === 'code:other:17')).toBe(false);
    const hits = searchArchitectureEntities(scene, 'melted-17');
    expect(hits.some(item => item.id === 'code:other:17')).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(DEFAULT_SEARCH_RESULT_LIMIT);
  });
});

describe('golden C4 scene — rail code detail stays on one component branch', () => {
  it('does not list every code-band entity when the rail opens L4', () => {
    const golden = createGoldenC4Scene();
    const session = semanticLevelSession(golden, 'code', ['system:okie']);
    const ownerId = session.settled.at(-1)?.targetId;
    expect(ownerId).toBe('component:model-normalized');
    const rows = explorerEntitiesForView(golden, {
      detail: 'code',
      selected: golden.entities.find(item => item.id === 'system:okie')!,
      settledTargetIds: session.settled.map(entry => entry.targetId),
      visibleIds: golden.projection?.entityIdsByDetail.code,
    });
    const codeBand = new Set(golden.projection!.entityIdsByDetail.code);
    expect(codeBand.size).toBeGreaterThan(rows.length);
    expect(rows.every(item => codeBand.has(item.id))).toBe(true);
    expect(rows.some(item => item.parentId === ownerId || item.id === ownerId)).toBe(true);
    expect(rows.some(item => item.parentId === 'component:model-schema')).toBe(false);
  });
});

describe('App wires scoped browse and unscoped search', () => {
  const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

  it('uses the hierarchical explorer helper instead of the 200-row dump', () => {
    expect(app).toContain('explorerEntitiesForView(');
    expect(app).not.toContain('scene.entities.length > 200');
    expect(app).toContain('searchArchitectureEntities(');
  });
});
