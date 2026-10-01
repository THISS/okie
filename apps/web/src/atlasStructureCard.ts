/**
 * CLA-319: the share card that shows an atlas's real top-level structure, rendered once at publish time
 * (`pnpm publish:atlas`, bundled for Node by scripts/publish-atlas.mjs) and stored beside the immutable
 * version as `versions/<v>/card-<STRUCTURE_CARD_RENDERER_VERSION>.png`; `/og/<owner>/<repo>` serves it
 * and falls back to the generated owner/repo card (atlasCard.ts) when it is missing.
 *
 * Node-only like atlasCard.ts (PNG via `node:zlib`), no DOM, no WASM, no Vite globs. It compiles exactly
 * what a published atlas shows on first load: the default neighborhood packet (focus "", as
 * apps/server/src/scanNeighborhood.ts `neighborhoodPacketFor` serves it) through the app's scan compile
 * ({@link compileScanScene}, the same call the live fixture's `createScene` makes), then reads the L1
 * system shell, its L2 containers and the context peers from the compiled projection. Repositories with
 * one or two containers show the L3 preview pills the app places inside them.
 *
 * Two placements, both deterministic: `geometry` draws the compiled world rects and relation routes
 * scaled into the board when every box stays legible; otherwise `compact` keeps the compiled reading
 * order (rows, then columns), membership, peers and relations, but packs the kept boxes into an even
 * grid so labels stay readable (dense monorepos compile dozens of small boxes and wide L1 peers).
 * At most {@link STRUCTURE_CARD_MAX_BOXES} boxes; the rest are counted in a "+N more" line.
 *
 * Pixels are a pure function of (snapshot, view, label) and the code that renders them: no Date, Math.random or env
 * reads. Caveat: the scene compile runs in the host JS runtime, so a different workspace build of the packages, or a
 * runtime whose string handling differs (ICU/locale-sensitive comparisons in dependencies), could change the layout.
 * {@link structureCardSelfCheck} renders a reference card and compares it with {@link STRUCTURE_CARD_REFERENCE_SHA256}
 * before the publish script stores anything.
 */
import {
  ASPECT_PRESET_TARGET,
  neighborhoodSliceOptionsForFocus,
  sliceArchitectureNeighborhood,
  type ArchitectureNeighborhoodPacket,
  type ArchitectureSnapshot,
  type ArchitectureView,
} from '@okie/architecture';
import {
  atlasCardLayout,
  CARD_BOARD,
  CARD_COLORS,
  cardTextWidth,
  drawCardTextColumn,
  drawLine,
  drawText,
  encodePng,
  fillRect,
  fillRoundRect,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  type Rgba,
} from './atlasCard';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { goldenSnapshot, goldenView } from '@okie/scene-compiler';
import { STRUCTURE_CARD_REFERENCE_SHA256, STRUCTURE_CARD_RENDERER_VERSION } from './atlasStructureCardVersion';
import { compileScanScene } from './renderer/scanScene';
import type { AtlasScene, EntityKind, SceneEntity, SemanticDetail } from './renderer/types';

export { STRUCTURE_CARD_REFERENCE_SHA256, STRUCTURE_CARD_RENDERER_VERSION } from './atlasStructureCardVersion';

export type StructureCardInput = {
  snapshot: ArchitectureSnapshot;
  view: ArchitectureView;
  /** Names printed in the title column (GitHub's casing when known). */
  label: { owner: string; repo: string };
};

export type CardRect = { x: number; y: number; width: number; height: number };
export type CardPoint = { x: number; y: number };
export type StructureCardLabelLine = { text: string; x: number; y: number };
/** A label: one or two lines at one scale (`text` is what it reads as, lines joined by a space). */
export type StructureCardLabel = { text: string; scale: number; lines: StructureCardLabelLine[] };

export type StructureCardBox = {
  id: string;
  /** The compiled entity's real name (the label is this, a short form of it, or it cut with `...`). */
  name: string;
  kind: EntityKind;
  /** `shell`: the L1 system; `group`: a container drawn as a panel holding L3 pills; `box`: a filled node. */
  role: 'shell' | 'group' | 'box';
  /** An L1 peer outside the system (person, external system). */
  peer?: boolean;
  rect: CardRect;
  label?: StructureCardLabel;
};

export type StructureCardEdge = { from: string; to: string; points: CardPoint[] };

export type StructureCardLayout = {
  mode: 'geometry' | 'compact';
  /** The compiled band the boxes come from. */
  detail: SemanticDetail;
  shell: StructureCardBox;
  /** Groups and boxes in draw order. */
  boxes: StructureCardBox[];
  edges: StructureCardEdge[];
  /** Candidates not drawn (over the box cap, or L3 children beyond the compiled preview). */
  hidden: number;
  more?: StructureCardLabel;
  width: number;
  height: number;
};

/** Boxes drawn at most (groups, containers, pills and peers together; the system shell is extra). */
export const STRUCTURE_CARD_MAX_BOXES = 12;
/** Up to this many containers, the card opens them and shows the L3 preview pills compiled inside. */
const THIN_CONTAINER_LIMIT = 2;

const { BG, PANEL, MUTED, ACCENT, CYAN, BLUE, PURPLE } = CARD_COLORS;
const SHELL_FILL: Rgba = [23, 21, 27, 255];
const GROUP_FILL: Rgba = [17, 27, 28, 255];
const EDGE: Rgba = [78, 98, 94, 255];
const STORE: Rgba = [242, 203, 120, 255];
const QUEUE: Rgba = [255, 174, 112, 255];
const PERSON: Rgba = [181, 194, 189, 255];

const BOARD_INSET = 22;
const MORE_LINE = 24;
const LABEL_PAD_X = 8;
/** Geometry placement only when every drawn box is at least this big on the card. */
const MIN_BOX_W = 84;
const MIN_BOX_H = 28;
const BOX_MAX_H = 60;
const GRID_MIN_BOX_H = 30;
const GRID_GAP = 12;
const SHELL_HEADER = 30;
const GROUP_HEADER = 26;
const PEER_ROW_H = 44;

/**
 * The default neighborhood packet (focus "") exactly as the public route serves it, round-tripped
 * through JSON like the browser receives it, then the app's first scene compile for the view root.
 */
export function structureCardScene(snapshot: ArchitectureSnapshot, view: ArchitectureView): AtlasScene {
  const sliced = sliceArchitectureNeighborhood(snapshot, view, { ...neighborhoodSliceOptionsForFocus(snapshot, undefined) });
  const packet = JSON.parse(JSON.stringify(sliced)) as ArchitectureNeighborhoodPacket;
  return compileScanScene({
    snapshot: packet.snapshot,
    view: packet.view,
    focusEntityId: packet.view.rootEntityId,
    boot: 'neighborhood',
    modeOptions: { targetAspect: ASPECT_PRESET_TARGET.landscape },
    childCounts: { ...packet.childCounts },
    unpublishedChildren: [...(packet.unpublishedChildren ?? [])],
  });
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const round = (value: number): number => Math.round(value);
const center = (rect: CardRect): CardPoint => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
const isContainerKind = (kind: EntityKind | undefined): boolean => kind === 'container' || kind === 'store' || kind === 'queue';

/** A shorter form of a name that still identifies it: `@scope/name` → `name`, `a/b/File.ts` → `File.ts`. */
function shortName(name: string): string | undefined {
  const scoped = /^@[^/\s]+\/(\S+)$/.exec(name);
  if (scoped) return scoped[1];
  // Only a path (no spaces): "Rust / WASM renderer" is a name, not a path.
  if (/\s/.test(name)) return undefined;
  const slash = name.lastIndexOf('/');
  return slash > 0 && slash < name.length - 1 ? name.slice(slash + 1) : undefined;
}

/** A trailing `-<40 hex>` commit suffix (git-dependency checkouts) is noise on a card; the rest is the name. */
function displayName(name: string): string {
  return name.replace(/-[0-9a-f]{40}$/, '');
}

type LabelOptions = { scales?: readonly number[]; allowShort?: boolean; preferShort?: boolean; wrap?: boolean };
export type FittedLabel = { lines: string[]; scale: number; whole: boolean };

/** Label texts for a name: the name and, when allowed, its short form (first when `preferShort`). */
function labelCandidates(name: string, options: LabelOptions): string[] {
  const full = displayName(name);
  const short = options.allowShort ?? true ? shortName(full) : undefined;
  if (!short || short === full) return [full];
  return options.preferShort ? [short, full] : [full, short];
}

const LINE_GAP = 4;
const lineHeight = (scale: number, lines: number): number => lines * 7 * scale + (lines - 1) * LINE_GAP;

/** `text` cut to `maxChars` with `...`: a path keeps its end (the file), anything else its start. */
function cut(text: string, maxChars: number): string {
  const chars = [...text];
  if (chars.length <= maxChars) return text;
  return text.includes('/') && !text.startsWith('@') && !/\s/.test(text)
    ? `...${chars.slice(chars.length - (maxChars - 3)).join('')}`
    : `${chars.slice(0, maxChars - 3).join('').trimEnd()}...`;
}

/**
 * `text` on two lines, broken after a space, `-`, `/` or `_` (never inside a file extension) so both halves fit `avail` at `scale`, the most even
 * break first; with `allowCut`, the longest first line that fits and the rest cut with `...`.
 */
function twoLines(text: string, avail: number, scale: number, allowCut: boolean): string[] | undefined {
  const chars = [...text];
  const maxChars = Math.floor((avail / scale + 1) / 6);
  const breaks: Array<[string, string]> = [];
  for (let i = 1; i < chars.length - 1; i += 1) {
    const ch = chars[i]!;
    if (ch === ' ') breaks.push([chars.slice(0, i).join(''), chars.slice(i + 1).join('')]);
    else if ('-/_'.includes(ch)) breaks.push([chars.slice(0, i + 1).join(''), chars.slice(i + 1).join('')]);
  }
  const fits = (line: string) => line.length > 0 && cardTextWidth(line, scale) <= avail;
  const whole = breaks
    .filter(([a, b]) => fits(a) && fits(b))
    .sort((x, y) => Math.max([...x[0]].length, [...x[1]].length) - Math.max([...y[0]].length, [...y[1]].length))[0];
  if (whole) return whole;
  if (!allowCut || maxChars < 6) return undefined;
  const first = breaks.filter(([a]) => fits(a)).sort((x, y) => [...y[0]].length - [...x[0]].length)[0];
  return first ? [first[0], cut(first[1], maxChars)] : undefined;
}

/**
 * The label for a box: at the first scale in `scales` where the name (or, when `allowShort`, its short form) fits whole
 * on one line, else (with `wrap`, when the box is tall enough) on two; otherwise, at the last scale, cut with `...`
 * (at least three characters kept). None when the box is too small for that.
 */
export function fitStructureLabel(
  name: string,
  width: number,
  height: number,
  align: 'center' | 'top-left',
  options: LabelOptions = {},
): FittedLabel | undefined {
  const scales = options.scales ?? [3, 2];
  const avail = width - 2 * LABEL_PAD_X;
  const candidates = labelCandidates(name, options);
  const pad = align === 'center' ? 8 : 6;
  const wrap = (options.wrap ?? align === 'center');
  for (const scale of scales) {
    if (height < lineHeight(scale, 1) + pad) continue;
    const one = candidates.find(text => cardTextWidth(text, scale) <= avail);
    if (one) return { lines: [one], scale, whole: true };
    if (wrap && height >= lineHeight(scale, 2) + pad) {
      for (const text of candidates) {
        const two = twoLines(text, avail, scale, false);
        if (two) return { lines: two, scale, whole: true };
      }
    }
  }
  const scale = scales[scales.length - 1]!;
  if (height < lineHeight(scale, 1) + pad) return undefined;
  const maxChars = Math.floor((avail / scale + 1) / 6);
  if (maxChars < 6) return undefined;
  const shortest = [...candidates].sort((a, b) => [...a].length - [...b].length)[0]!;
  if (wrap && height >= lineHeight(scale, 2) + pad) {
    const two = twoLines(shortest, avail, scale, true);
    if (two) return { lines: two, scale, whole: false };
  }
  return { lines: [cut(shortest, maxChars)], scale, whole: false };
}

function placeLabel(box: StructureCardBox, options: LabelOptions = {}): StructureCardBox {
  const align = box.role === 'box' ? 'center' : 'top-left';
  const fit = fitStructureLabel(box.name, box.rect.width, box.role === 'box' ? box.rect.height : (box.role === 'shell' ? SHELL_HEADER : GROUP_HEADER), align, options);
  if (!fit) return box;
  const top = align === 'center' ? round(box.rect.y + (box.rect.height - lineHeight(fit.scale, fit.lines.length)) / 2) : box.rect.y + 9;
  const lines = fit.lines.map((text, i) => ({
    text,
    x: align === 'center' ? round(box.rect.x + (box.rect.width - cardTextWidth(text, fit.scale)) / 2) : box.rect.x + 10,
    y: top + i * (7 * fit.scale + LINE_GAP),
  }));
  return { ...box, label: { text: fit.lines.join(' '), scale: fit.scale, lines } };
}

/**
 * Labels for the filled boxes at ONE scale for the whole card (3 when every box's label fits whole at 3, else 2),
 * so the diagram reads evenly. A short form (`@scope/x` → `x`, `a/b.ts` → `b.ts`) is used only when no
 * other drawn box shares it; once one `@scope/` name needs it, every name in that scope uses it.
 */
function labelBoxes(boxes: readonly StructureCardBox[]): StructureCardBox[] {
  const shortCounts = new Map<string, number>();
  for (const box of boxes) {
    const short = shortName(displayName(box.name));
    if (short) shortCounts.set(short, (shortCounts.get(short) ?? 0) + 1);
  }
  const allowShort = (box: StructureCardBox) => (shortCounts.get(shortName(displayName(box.name)) ?? '') ?? 0) <= 1;
  const scopeOf = (box: StructureCardBox) => /^(@[^/\s]+\/)\S+$/.exec(box.name)?.[1];
  const labelsAt = (scale: number): StructureCardBox[] => {
    const shortScopes = new Set(boxes
      .filter(box => scopeOf(box) && allowShort(box) && cardTextWidth(displayName(box.name), scale) > box.rect.width - 2 * LABEL_PAD_X)
      .map(box => scopeOf(box)!));
    return boxes.map(box => placeLabel(box, { scales: [scale], allowShort: allowShort(box), preferShort: shortScopes.has(scopeOf(box) ?? '') }));
  };
  const whole = (box: StructureCardBox, scale: number) =>
    fitStructureLabel(box.name, box.rect.width, box.rect.height, 'center', { scales: [scale], allowShort: allowShort(box) })?.whole === true;
  return labelsAt(boxes.every(box => whole(box, 3)) ? 3 : 2);
}

/** Rows by vertical position (a new row once a box's centre drops below the row's first box), then left to right. */
function readingOrder<T extends { rect: CardRect; id: string }>(items: readonly T[]): T[] {
  const sorted = [...items].sort((a, b) => center(a.rect).y - center(b.rect).y || center(a.rect).x - center(b.rect).x || byText(a.id, b.id));
  const rows: T[][] = [];
  for (const item of sorted) {
    const row = rows[rows.length - 1];
    const first = row?.[0];
    if (row && first && center(item.rect).y <= first.rect.y + first.rect.height) row.push(item);
    else rows.push([item]);
  }
  return rows.flatMap(row => row.sort((a, b) => center(a.rect).x - center(b.rect).x || byText(a.id, b.id)));
}

/**
 * An even grid of `labels.length` cells inside `area`. Among column counts whose boxes stay at least
 * {@link GRID_MIN_BOX_H} tall, the one where the most labels fit whole at scale 2 (on up to two lines), then the widest cells
 * near a 3:1 box.
 */
function gridCells(area: CardRect, labels: readonly string[], maxBoxH = BOX_MAX_H): CardRect[] {
  const count = labels.length;
  if (count === 0) return [];
  let best = { columns: 1, fitted: -1, tall: false, score: -Infinity };
  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns);
    const cellW = (area.width - (columns - 1) * GRID_GAP) / columns;
    const cellH = (area.height - (rows - 1) * GRID_GAP) / rows;
    const tall = Math.min(cellH, maxBoxH) >= GRID_MIN_BOX_H;
    const fitted = labels.filter(label => fitStructureLabel(label, cellW, Math.min(cellH, maxBoxH), 'center', { scales: [2] })?.whole).length;
    const score = Math.min(cellW / 3, Math.min(cellH, maxBoxH));
    const better = tall !== best.tall ? tall : fitted !== best.fitted ? fitted > best.fitted : score > best.score + 1e-9;
    if (better) best = { columns, fitted, tall, score };
  }
  const columns = best.columns;
  const rows = Math.ceil(count / columns);
  const cellW = (area.width - (columns - 1) * GRID_GAP) / columns;
  const cellH = (area.height - (rows - 1) * GRID_GAP) / rows;
  const boxH = Math.min(cellH, maxBoxH);
  const usedH = rows * boxH + (rows - 1) * GRID_GAP;
  const top = area.y + (area.height - usedH) / 2;
  const cells: CardRect[] = [];
  for (let i = 0; i < count; i += 1) {
    const column = i % columns;
    const row = Math.floor(i / columns);
    // The last row is centred when it is short.
    const inRow = row === rows - 1 ? count - row * columns : columns;
    const rowLeft = area.x + (area.width - (inRow * cellW + (inRow - 1) * GRID_GAP)) / 2;
    cells.push({
      x: round(rowLeft + column * (cellW + GRID_GAP)),
      y: round(top + row * (boxH + GRID_GAP)),
      width: round(cellW),
      height: round(boxH),
    });
  }
  return cells;
}

/** Where a straight connector from `from` meets the border of `rect` (its centre when `from` is inside). */
function clampToRect(from: CardPoint, rect: CardRect): CardPoint {
  return { x: Math.min(rect.x + rect.width, Math.max(rect.x, from.x)), y: Math.min(rect.y + rect.height, Math.max(rect.y, from.y)) };
}

type Candidate = { id: string; entity: SceneEntity; world: CardRect; degree: number; peer: boolean };

/** Pure layout in card pixels (exported for tests). Throws when the compiled scene has no root shell. */
export function atlasStructureCardLayout(input: StructureCardInput, scene: AtlasScene = structureCardScene(input.snapshot, input.view)): StructureCardLayout {
  const projection = scene.projection;
  if (!projection) throw new Error('the compiled scene has no projection');
  const rootId = scene.rootEntityId ?? input.view.rootEntityId;
  const entities = new Map(scene.entities.map(entity => [entity.id, entity]));
  const boundsAt = (id: string, detail: SemanticDetail): CardRect | undefined => projection.boundsByEntityIdAndDetail[id]?.[detail];
  const idsAt = (detail: SemanticDetail): string[] => projection.entityIdsByDetail[detail] ?? [];
  const containersAt = (detail: SemanticDetail): string[] => idsAt(detail)
    .filter(id => id !== rootId && entities.get(id)?.parentId === rootId && isContainerKind(entities.get(id)?.kind) && boundsAt(id, detail));
  const band: SemanticDetail = containersAt('container').length ? 'container' : 'context';
  const containerIds = containersAt(band);
  const containerSet = new Set(containerIds);
  const pillIds = band === 'container' && containerIds.length <= THIN_CONTAINER_LIMIT
    ? idsAt('component').filter(id => containerSet.has(entities.get(id)?.parentId ?? '') && boundsAt(id, 'component'))
    : [];
  const thin = pillIds.length > 0;
  const detail: SemanticDetail = thin ? 'component' : band;
  const worldOf = (id: string): CardRect | undefined => boundsAt(id, detail) ?? boundsAt(id, band) ?? boundsAt(id, 'context');
  const shellWorld = worldOf(rootId);
  const shellEntity = entities.get(rootId);
  if (!shellWorld || !shellEntity) throw new Error(`the compiled scene has no bounds for the root ${rootId}`);
  const peerIds = idsAt(band).filter(id => id !== rootId && !entities.get(id)?.parentId && worldOf(id));

  const relations = [...(projection.projectedRelationsByDetail[detail] ?? []), ...(thin ? projection.projectedRelationsByDetail[band] ?? [] : [])];
  const degree = new Map<string, number>();
  for (const relation of relations) {
    degree.set(relation.from, (degree.get(relation.from) ?? 0) + 1);
    degree.set(relation.to, (degree.get(relation.to) ?? 0) + 1);
  }
  const candidate = (id: string, peer: boolean): Candidate => ({ id, entity: entities.get(id)!, world: worldOf(id)!, degree: degree.get(id) ?? 0, peer });
  const groups = thin ? containerIds.map(id => candidate(id, false)) : [];
  const pool = [...(thin ? pillIds : containerIds).map(id => candidate(id, false)), ...peerIds.map(id => candidate(id, true))];
  const ranked = [...pool].sort((a, b) =>
    b.degree - a.degree
    || b.world.width * b.world.height - a.world.width * a.world.height
    || byText(a.entity.name, b.entity.name)
    || byText(a.id, b.id));
  const budget = Math.max(0, STRUCTURE_CARD_MAX_BOXES - groups.length);
  const kept = ranked.slice(0, budget);
  const keptIds = new Set(kept.map(item => item.id));
  // L3 children the compile kept out of the preview (the app's own "+N more") count as not shown too.
  const unshownPills = thin
    ? containerIds.reduce((sum, id) => sum + Math.max(0, (scene.entities.filter(entity => entity.parentId === id).length) - pillIds.filter(pill => entities.get(pill)?.parentId === id).length), 0)
    : 0;
  const hidden = pool.length - kept.length + unshownPills;

  const board = {
    x: CARD_BOARD.x + BOARD_INSET,
    y: CARD_BOARD.y + 4 + BOARD_INSET,
    width: CARD_BOARD.width - 2 * BOARD_INSET,
    height: CARD_BOARD.height - 4 - 2 * BOARD_INSET - (hidden > 0 ? MORE_LINE : 0),
  };
  const drawnIds = new Set([rootId, ...groups.map(group => group.id), ...keptIds]);
  const edgePairs = new Map<string, { from: string; to: string; route?: CardPoint[] }>();
  for (const relation of relations) {
    if (relation.from === relation.to || !drawnIds.has(relation.from) || !drawnIds.has(relation.to)) continue;
    const key = relation.from < relation.to ? `${relation.from}\u0000${relation.to}` : `${relation.to}\u0000${relation.from}`;
    if (!edgePairs.has(key)) edgePairs.set(key, { from: relation.from, to: relation.to, ...(relation.routePoints?.length ? { route: relation.routePoints } : {}) });
  }
  const edgeList = [...edgePairs.entries()].sort(([a], [b]) => byText(a, b)).map(([, edge]) => edge);

  // Opened containers (L3 pills) always pack: file names need the width a scaled world rect never gives them.
  const geometry = thin ? undefined : geometryLayout(shellWorld, kept, board);
  const placed = geometry ?? compactLayout(groups, kept, board);
  const shell = placeLabel({ id: rootId, name: shellEntity.name, kind: shellEntity.kind, role: 'shell', rect: placed.shell });
  const boxes: StructureCardBox[] = [
    ...groups.map(group => placeLabel({ id: group.id, name: group.entity.name, kind: group.entity.kind, role: 'group' as const, rect: placed.rects.get(group.id)! }, { scales: [2] })),
    ...labelBoxes(kept.map(item => ({ id: item.id, name: item.entity.name, kind: item.entity.kind, role: 'box' as const, ...(item.peer ? { peer: true } : {}), rect: placed.rects.get(item.id)! }))),
  ];
  const rectOf = (id: string): CardRect => (id === rootId ? placed.shell : placed.rects.get(id)!);
  // Compact placement is not the compiled geometry, so container-to-container connectors would only cross
  // the grid; it keeps the ones that reach an L1 peer (they cross the gap under the shell).
  const peerSet = new Set(kept.filter(item => item.peer).map(item => item.id));
  const edges: StructureCardEdge[] = edgeList.filter(edge => geometry || peerSet.has(edge.from) || peerSet.has(edge.to)).map(edge => {
    if (geometry && edge.route) return { from: edge.from, to: edge.to, points: edge.route.map(point => geometry.map(point)) };
    const from = rectOf(edge.from);
    const to = rectOf(edge.to);
    // A connector to the shell (or to the group holding the other end) meets its border, not its centre.
    const a = edge.from === rootId ? clampToRect(center(to), from) : center(from);
    const b = edge.to === rootId ? clampToRect(center(from), to) : center(to);
    return { from: edge.from, to: edge.to, points: [a, b] };
  });
  const moreText = hidden > 0 ? `+${hidden} more` : undefined;
  return {
    mode: geometry ? 'geometry' : 'compact',
    detail,
    shell,
    boxes,
    edges,
    hidden,
    ...(moreText ? { more: { text: moreText, scale: 2, lines: [{ text: moreText, x: board.x + board.width - cardTextWidth(moreText, 2), y: board.y + board.height + 8 }] } } : {}),
    width: OG_IMAGE_WIDTH,
    height: OG_IMAGE_HEIGHT,
  };
}

type Placement = { shell: CardRect; rects: Map<string, CardRect> };

/** The compiled world rects scaled into the board, or undefined when some box would be too small to read. */
function geometryLayout(shellWorld: CardRect, kept: readonly Candidate[], board: CardRect): (Placement & { map: (point: CardPoint) => CardPoint }) | undefined {
  const all = [shellWorld, ...kept.map(item => item.world)];
  const minX = Math.min(...all.map(rect => rect.x));
  const minY = Math.min(...all.map(rect => rect.y));
  const maxX = Math.max(...all.map(rect => rect.x + rect.width));
  const maxY = Math.max(...all.map(rect => rect.y + rect.height));
  const scale = Math.min(board.width / Math.max(1, maxX - minX), board.height / Math.max(1, maxY - minY));
  const offsetX = board.x + (board.width - (maxX - minX) * scale) / 2;
  const offsetY = board.y + (board.height - (maxY - minY) * scale) / 2;
  const map = (point: CardPoint): CardPoint => ({ x: offsetX + (point.x - minX) * scale, y: offsetY + (point.y - minY) * scale });
  const mapRect = (rect: CardRect): CardRect => {
    const a = map(rect);
    const b = map({ x: rect.x + rect.width, y: rect.y + rect.height });
    return { x: round(a.x), y: round(a.y), width: round(b.x) - round(a.x), height: round(b.y) - round(a.y) };
  };
  const rects = new Map<string, CardRect>();
  for (const item of kept) {
    const rect = mapRect(item.world);
    if (rect.width < MIN_BOX_W || rect.height < MIN_BOX_H) return undefined;
    rects.set(item.id, rect);
  }
  return { shell: mapRect(shellWorld), rects, map };
}

/** The kept boxes packed into an even grid in the compiled reading order; peers in a row under the shell. */
function compactLayout(groups: readonly Candidate[], kept: readonly Candidate[], board: CardRect): Placement {
  const rects = new Map<string, CardRect>();
  const peers = readingOrder(kept.filter(item => item.peer).map(item => ({ ...item, rect: item.world })));
  const inner = kept.filter(item => !item.peer);
  const shellH = peers.length ? board.height - PEER_ROW_H - 18 : board.height;
  const shell: CardRect = { x: board.x, y: board.y, width: board.width, height: round(shellH) };
  if (peers.length) {
    const peerArea = { x: board.x, y: board.y + board.height - PEER_ROW_H, width: board.width, height: PEER_ROW_H };
    const width = Math.min(220, (peerArea.width - (peers.length - 1) * GRID_GAP) / peers.length);
    const left = peerArea.x + (peerArea.width - (peers.length * width + (peers.length - 1) * GRID_GAP)) / 2;
    peers.forEach((peer, i) => rects.set(peer.id, { x: round(left + i * (width + GRID_GAP)), y: round(peerArea.y), width: round(width), height: PEER_ROW_H }));
  }
  const content: CardRect = { x: shell.x + 14, y: shell.y + SHELL_HEADER + 4, width: shell.width - 28, height: shell.height - SHELL_HEADER - 18 };
  if (groups.length === 0) {
    const ordered = readingOrder(inner.map(item => ({ ...item, rect: item.world })));
    gridCells(content, ordered.map(item => shortName(item.entity.name) ?? item.entity.name)).forEach((cell, i) => rects.set(ordered[i]!.id, cell));
    return { shell, rects };
  }
  const orderedGroups = readingOrder(groups.map(item => ({ ...item, rect: item.world })));
  const groupCells = gridCells(content, orderedGroups.map(item => item.entity.name), content.height);
  orderedGroups.forEach((group, i) => {
    const cell = groupCells[i]!;
    rects.set(group.id, cell);
    const pills = readingOrder(inner.filter(item => item.entity.parentId === group.id).map(item => ({ ...item, rect: item.world })));
    const pillArea = { x: cell.x + 12, y: cell.y + GROUP_HEADER + 4, width: cell.width - 24, height: cell.height - GROUP_HEADER - 16 };
    gridCells(pillArea, pills.map(item => shortName(item.entity.name) ?? item.entity.name), 48).forEach((pillCell, j) => rects.set(pills[j]!.id, pillCell));
  });
  return { shell, rects };
}

function boxFill(box: StructureCardBox): Rgba {
  if (box.kind === 'store') return STORE;
  if (box.kind === 'queue') return QUEUE;
  if (box.kind === 'person') return PERSON;
  if (box.peer || box.kind === 'system') return MUTED;
  if (box.kind === 'component') return BLUE;
  return CYAN;
}

function outlinedPanel(rgba: Uint8Array, rect: CardRect, radius: number, stroke: Rgba, fill: Rgba): void {
  const { width, height } = { width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT };
  fillRoundRect(rgba, width, height, rect.x, rect.y, rect.width, rect.height, radius, stroke);
  fillRoundRect(rgba, width, height, rect.x + 2, rect.y + 2, rect.width - 4, rect.height - 4, radius - 2, fill);
}

function drawLabel(rgba: Uint8Array, label: StructureCardLabel | undefined, color: Rgba): void {
  for (const line of label?.lines ?? []) drawText(rgba, OG_IMAGE_WIDTH, OG_IMAGE_HEIGHT, line.text, line.x, line.y, label!.scale, color);
}

/** PNG bytes for the structure card. Throws when the atlas cannot be compiled (the publish then skips the card). */
export function renderAtlasStructureCardPng(input: StructureCardInput): Uint8Array {
  const layout = atlasStructureCardLayout(input);
  const { width, height } = layout;
  const rgba = new Uint8Array(width * height * 4);
  fillRect(rgba, width, height, 0, 0, width, height, BG);
  drawCardTextColumn(rgba, atlasCardLayout({ owner: input.label.owner, repo: input.label.repo }));
  fillRoundRect(rgba, width, height, CARD_BOARD.x, CARD_BOARD.y, CARD_BOARD.width, CARD_BOARD.height, 24, PANEL);
  fillRect(rgba, width, height, CARD_BOARD.x, CARD_BOARD.y, CARD_BOARD.width, 4, ACCENT);

  outlinedPanel(rgba, layout.shell.rect, 14, PURPLE, SHELL_FILL);
  drawLabel(rgba, layout.shell.label, PURPLE);
  for (const box of layout.boxes) {
    if (box.role !== 'group') continue;
    outlinedPanel(rgba, box.rect, 10, CYAN, GROUP_FILL);
    drawLabel(rgba, box.label, CYAN);
  }
  for (const edge of layout.edges) {
    for (let i = 1; i < edge.points.length; i += 1) {
      const a = edge.points[i - 1]!;
      const b = edge.points[i]!;
      drawLine(rgba, width, height, round(a.x), round(a.y), round(b.x), round(b.y), EDGE, 2);
    }
  }
  for (const box of layout.boxes) {
    if (box.role !== 'box') continue;
    fillRoundRect(rgba, width, height, box.rect.x, box.rect.y, box.rect.width, box.rect.height, 8, boxFill(box));
    drawLabel(rgba, box.label, BG);
  }
  drawLabel(rgba, layout.more, MUTED);
  return encodePng(width, height, rgba);
}

/** sha256 of a PNG's inflated IDAT data (its pixels, independent of the zlib build's compressed bytes). */
export function structureCardPixelsSha256(png: Uint8Array): string {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const parts: Uint8Array[] = [];
  for (let at = 8; at + 8 <= png.byteLength;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (type === 'IDAT') parts.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  return createHash('sha256').update(inflateSync(Buffer.concat(parts))).digest('hex');
}

/** The reference card's input: the hand-authored golden self-map, printed as THISS/okie. */
export const STRUCTURE_CARD_REFERENCE_INPUT: StructureCardInput = { snapshot: goldenSnapshot, view: goldenView, label: { owner: 'THISS', repo: 'okie' } };

/**
 * Renders the reference card here, in this runtime and build, and compares its pixels with
 * {@link STRUCTURE_CARD_REFERENCE_SHA256}. `ok: false` means cards rendered now would not be the `version` cards
 * (a stale package build or a runtime difference), so none may be stored under that version.
 */
export function structureCardSelfCheck(): { ok: boolean; sha256: string; expected: string; version: string } {
  const sha256 = structureCardPixelsSha256(renderAtlasStructureCardPng(STRUCTURE_CARD_REFERENCE_INPUT));
  return { ok: sha256 === STRUCTURE_CARD_REFERENCE_SHA256, sha256, expected: STRUCTURE_CARD_REFERENCE_SHA256, version: STRUCTURE_CARD_RENDERER_VERSION };
}
