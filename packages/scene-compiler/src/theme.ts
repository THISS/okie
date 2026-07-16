import type { EntityKind } from "@okie/architecture";
import type { Color } from "./protocol.js";

export interface SceneTheme {
  background: Color;
  text: Color;
  mutedText: Color;
  edge: Color;
  edgeLabel: Color;
  optionalEdge: Color;
  selection: Color;
  entityFill: Record<EntityKind, Color>;
}

export const defaultTheme: SceneTheme = {
  background: [0.027, 0.039, 0.071, 1],
  text: [0.957, 0.969, 1, 1],
  mutedText: [0.573, 0.616, 0.718, 1],
  edge: [0.463, 0.525, 0.659, 0.82],
  edgeLabel: [0.61, 0.7, 0.69, 1],
  optionalEdge: [0.463, 0.525, 0.659, 0.46],
  selection: [1, 0.478, 0.271, 1],
  entityFill: {
    person: [0.294, 0.18, 0.43, 1],
    softwareSystem: [0.31, 0.118, 0.067, 1],
    container: [0.094, 0.216, 0.38, 1],
    component: [0.063, 0.267, 0.32, 1],
    code: [0.086, 0.122, 0.2, 1],
    externalSystem: [0.145, 0.169, 0.227, 1],
    dataStore: [0.063, 0.267, 0.2, 1],
    queue: [0.302, 0.227, 0.078, 1],
    boundary: [0.055, 0.075, 0.125, 0.55],
  },
};
