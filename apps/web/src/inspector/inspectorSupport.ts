export {
  clampInspectorWidth,
  defaultInspectorWidth,
  inspectorAcceptedSummary,
  inspectorCanShowSource,
  inspectorCyclomatic,
  inspectorCoverage,
  inspectorDuplicates,
  inspectorUntestedBehaviours,
  formatCoverageRange,
  inspectorNotationScope,
  inspectorPathOwners,
  inspectorTabForEntity,
  inspectorTabSequence,
  inspectorWidthRange,
  inspectorWidthStorageKey,
  presentInspectorNotationDiagnostics,
  INSPECTOR_NOTATION_ADVISORY_SAMPLE,
  type InspectorTab,
} from './inspectorPanel';
export { buildScanOnePager } from './scanOnePager';
export {
  canvasRelationRowsInIsolate,
  canvasRelationsForEntity,
  paintedOmittedRelationRows,
  selectedRelationPresentation,
  type CanvasRelationRow,
  type CanvasRelationsPresentation,
  type OmittedRelationRow,
} from '../relations/projectionRelations';
export { selectedEntityReframePlan } from '../relations/selectedEntityFraming';
