import type { Camera } from '../renderer/types';
import {
  connectionPortPoint,
  orthogonalSegmentHandles,
  worldToScreen,
  type AuthoringBounds,
  type AuthoringPoint,
  type ConnectionPort,
} from './relationshipInteraction';

const ports: readonly ConnectionPort[] = ['top', 'right', 'bottom', 'left'];

export type RelationshipDraftOverlay = {
  points: AuthoringPoint[];
  safe: boolean;
};

export type RelationshipAuthoringOverlayProps = {
  camera: Camera;
  /** Exact materialized bounds for the settled semantic band. */
  boundsByEntityId: Readonly<Record<string, AuthoringBounds>>;
  portEntityIds: readonly string[];
  viewport: { width: number; height: number };
  selectedRoute?: AuthoringPoint[];
  draft?: RelationshipDraftOverlay;
};

function pathData(points: readonly AuthoringPoint[], camera: Camera, viewport: { width: number; height: number }) {
  return points.map((point, index) => {
    const screen = worldToScreen(point, camera, viewport);
    return `${index ? 'L' : 'M'} ${screen.x} ${screen.y}`;
  }).join(' ');
}

export function RelationshipAuthoringOverlay({ camera, boundsByEntityId, portEntityIds, viewport, selectedRoute, draft }: RelationshipAuthoringOverlayProps) {
  return (
    <svg
      aria-hidden="true"
      className="relationship-authoring-overlay"
      data-testid="relationship-authoring-overlay"
      height={viewport.height}
      viewBox={`0 0 ${viewport.width} ${viewport.height}`}
      width={viewport.width}
    >
      {selectedRoute && <g className="authoring-committed-layer" data-overlay-layer="committed">
        <path className="authoring-selected-route" data-testid="authoring-selected-route" d={pathData(selectedRoute, camera, viewport)}/>
        {orthogonalSegmentHandles(selectedRoute).map(handle => {
          const point = worldToScreen(handle.point, camera, viewport);
          return <rect
            className={`authoring-segment-handle orientation-${handle.orientation}`}
            data-segment-index={handle.segmentIndex}
            data-testid={`route-segment-handle-${handle.segmentIndex}`}
            height={10}
            key={handle.segmentIndex}
            rx={3}
            width={10}
            x={point.x - 5}
            y={point.y - 5}
          />;
        })}
      </g>}
      <g className="authoring-port-layer" data-overlay-layer="ports">{portEntityIds.flatMap(entityId => {
        const bounds = boundsByEntityId[entityId];
        if (!bounds) return [];
        return ports.map(port => {
          const point = worldToScreen(connectionPortPoint(bounds, port), camera, viewport);
          return <circle
            className="authoring-connection-port"
            cx={point.x}
            cy={point.y}
            data-entity-id={entityId}
            data-port={port}
            data-testid={`connection-port-${entityId}-${port}`}
            key={`${entityId}:${port}`}
            r={5}
          />;
        });
      })}</g>
      {draft && <g
        className={`authoring-draft-layer ${draft.safe ? 'safe' : 'blocked'}`}
        data-draft-state={draft.safe ? 'safe' : 'blocked'}
        data-overlay-layer="draft"
      >
        <path
          className="authoring-route-preview-halo"
          d={pathData(draft.points, camera, viewport)}
        />
        <path
          className={`authoring-route-preview ${draft.safe ? 'safe' : 'blocked'}`}
          d={pathData(draft.points, camera, viewport)}
          data-safe={draft.safe ? 'true' : 'false'}
          data-testid="relationship-route-preview"
        />
      </g>}
    </svg>
  );
}
