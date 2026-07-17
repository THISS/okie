import type { AtlasScene, SceneEntity } from './types';

type Rgba = readonly [number, number, number, number];

const fills: Record<SceneEntity['kind'], Rgba> = {
  person: [0.082, 0.106, 0.11, 1],
  system: [0.09, 0.082, 0.11, 1],
  container: [0.067, 0.098, 0.102, 1],
  component: [0.067, 0.09, 0.114, 1],
  store: [0.094, 0.09, 0.067, 1],
  queue: [0.098, 0.082, 0.063, 1],
};

const text: Rgba = [0.945, 0.969, 0.957, 1];
const muted: Rgba = [0.59, 0.647, 0.627, 1];

export function toProtocolScene(scene: AtlasScene) {
  if (scene.protocolSnapshot) return scene.protocolSnapshot;
  const worldItems = [
    ...scene.entities.map(entity => ({ x: entity.x, y: entity.y, width: entity.width, height: entity.height })),
    ...scene.regions.map(region => ({ x: region.x, y: region.y, width: region.width, height: region.height })),
  ];
  const left = worldItems.length ? Math.min(...worldItems.map(item => item.x)) : 0;
  const top = worldItems.length ? Math.min(...worldItems.map(item => item.y)) : 0;
  const right = worldItems.length ? Math.max(...worldItems.map(item => item.x + item.width)) : 1;
  const bottom = worldItems.length ? Math.max(...worldItems.map(item => item.y + item.height)) : 1;

  return {
    protocolVersion: 1,
    sceneId: `scene:${scene.id}`,
    revision: 1,
    worldBounds: { x: left - 80, y: top - 80, width: right - left + 160, height: bottom - top + 160 },
    objects: scene.entities.map(entity => ({
      id: entity.id,
      zIndex: 1,
      bounds: { x: entity.x, y: entity.y, width: entity.width, height: entity.height },
      pickable: true,
      representations: [{
        id: `${entity.id}:compact`,
        lod: { minZoom: 0, maxZoom: 0.58, fadeWidth: 0.12, hysteresis: 0.04 },
        primitives: [
          {
            kind: 'roundedRect' as const,
            rect: { x: entity.x, y: entity.y, width: entity.width, height: entity.height },
            // Protocol rule: roundedRect radius must be <= min(w, h) / 2. Clamp so
            // tiny entities never emit protocol-invalid primitives (golden cells are
            // large enough that this is a no-op for them).
            radius: Math.max(0, Math.min(13, entity.width / 2, entity.height / 2)),
            fill: fills[entity.kind],
            stroke: { color: [0.31, 0.43, 0.4, 0.8] as Rgba, width: 1.3 },
          },
          {
            kind: 'text' as const,
            position: { x: entity.x + 16, y: entity.y + 40 },
            maxWidth: entity.width - 32,
            content: entity.name,
            fontFamily: 'IBM Plex Sans SemiBold',
            fontSize: 17,
            color: text,
            align: 'start' as const,
          },
        ],
      }, {
        id: `${entity.id}:detail`,
        lod: { minZoom: 0.46, maxZoom: null, fadeWidth: 0.12, hysteresis: 0.04 },
        primitives: [
          {
            kind: 'roundedRect' as const,
            rect: { x: entity.x, y: entity.y, width: entity.width, height: entity.height },
            // Protocol rule: roundedRect radius must be <= min(w, h) / 2. Clamp so
            // tiny entities never emit protocol-invalid primitives (golden cells are
            // large enough that this is a no-op for them).
            radius: Math.max(0, Math.min(13, entity.width / 2, entity.height / 2)),
            fill: fills[entity.kind],
            stroke: { color: [0.31, 0.43, 0.4, 0.8] as Rgba, width: 1.3 },
          },
          {
            kind: 'text' as const,
            position: { x: entity.x + 16, y: entity.y + 40 },
            maxWidth: entity.width - 32,
            content: entity.name,
            fontFamily: 'IBM Plex Sans SemiBold',
            fontSize: 17,
            color: text,
            align: 'start' as const,
          },
          {
            kind: 'text' as const,
            position: { x: entity.x + 16, y: entity.y + 66 },
            maxWidth: entity.width - 32,
            content: entity.responsibility,
            fontFamily: 'IBM Plex Sans',
            fontSize: 10,
            color: muted,
            align: 'start' as const,
          },
        ],
      }],
    })),
    paths: scene.relations.map(relation => {
      const from = scene.entities.find(entity => entity.id === relation.from);
      const to = scene.entities.find(entity => entity.id === relation.to);
      const fromCenter = from ? { x: from.x + from.width / 2, y: from.y + from.height / 2 } : { x: 0, y: 0 };
      const toCenter = to ? { x: to.x + to.width / 2, y: to.y + to.height / 2 } : { x: 0, y: 0 };
      return {
        id: relation.id,
        fromObjectId: relation.from,
        toObjectId: relation.to,
        points: [fromCenter, toCenter],
        stroke: [0.32, 0.42, 0.39, 0.68] as Rgba,
        width: 2,
        arrow: relation.arrow ?? 'end',
        optional: false,
        pickable: true,
        lod: { minZoom: 0, maxZoom: null, fadeWidth: 0.1, hysteresis: 0.04 },
      };
    }),
  };
}
