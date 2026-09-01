import {
  ARCHITECTURE_SCHEMA_VERSION,
  type ArchitectureEntity,
  type ArchitectureRelation,
  type ArchitectureSnapshot,
  type EntityKind,
  type RelationKind,
} from '@okie/architecture';
import type { SemanticDetail } from '../renderer/types';

export const IMPORTED_MERMAID_REVISION = 'imported-mermaid';
export const IMPORTED_MERMAID_SOURCE_PATH = 'imported.mmd';
export const MAX_IMPORTED_MERMAID_SOURCE_LENGTH = 40_000;
export const MAX_IMPORTED_MERMAID_NODES = 250;
export const MAX_IMPORTED_MERMAID_EDGES = 250;

export type ImportedMermaidDiagramType = 'flowchart' | 'sequence' | 'c4';

export type ImportedMermaidAtlas = {
  snapshot: ArchitectureSnapshot;
  rootEntityId: string;
  frameEntityIds: string[];
  frameDetail: SemanticDetail;
  title: string;
  diagramTypes: ImportedMermaidDiagramType[];
};

export type MermaidImportResult =
  | { ok: true; atlas: ImportedMermaidAtlas }
  | { ok: false; message: string };

type GraphNode = {
  mermaidId: string;
  name: string;
  kind: EntityKind;
  parentMermaidId?: string;
  responsibility?: string;
  technology?: string[];
};

type GraphEdge = {
  from: string;
  to: string;
  label?: string;
  kind: RelationKind;
};

type ParsedDiagram = {
  type: ImportedMermaidDiagramType;
  title: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

const UNSUPPORTED_DIAGRAM = /^(?:pie|gantt|classDiagram|stateDiagram(?:-v2)?|erDiagram|gitGraph|mindmap|timeline|quadrantChart|sankey(?:-beta)?|xychart(?:-beta)?|kanban|block(?:-beta)?|requirementDiagram|architecture(?:-beta)?|packet(?:-beta)?|radar(?:-beta)?|zenuml|info|journey)\b/iu;
const FLOWCHART_HEADER = /^(?:flowchart|graph)(?:\s+(?:TD|TB|BT|RL|LR))?\s*$/iu;
const SEQUENCE_HEADER = /^sequenceDiagram\b/iu;
const C4_HEADER = /^C4(?:Context|Container|Component|Dynamic|Deployment)\b/iu;

const FLOWCHART_EDGE_PATTERNS: ReadonlyArray<{ re: RegExp; label?: number }> = [
  { re: /^-->\|([^|]+)\|/, label: 1 },
  { re: /^---\|([^|]+)\|/, label: 1 },
  { re: /^-\.->\|([^|]+)\|/, label: 1 },
  { re: /^==>\|([^|]+)\|/, label: 1 },
  { re: /^--x\|([^|]+)\|/, label: 1 },
  { re: /^x--\|([^|]+)\|/, label: 1 },
  { re: /^--\s+(.+?)\s+-->/, label: 1 },
  { re: /^-\.\s+(.+?)\s+\.->/, label: 1 },
  { re: /^==\s+(.+?)\s+=>/, label: 1 },
  { re: /^--([^-]+?)-->/, label: 1 },
  { re: /^-->/ },
  { re: /^---/ },
  { re: /^-\.->/ },
  { re: /^-\.-/ },
  { re: /^==>/ },
  { re: /^===/ },
  { re: /^--x/ },
  { re: /^x-->/ },
  { re: /^x--/ },
  { re: /^o-->/ },
  { re: /^<-->/ },
  { re: /^<--/ },
  { re: /^->/ },
];

const SEQUENCE_ARROW = /^(.*?)(-{1,2}(?:>{1,2}|\)|x))([+-]?)(\s*)(\S+?)([+-]?)(?:\s*:\s*(.*))?$/u;
const SEQUENCE_BLOCK = /^(?:loop|alt|opt|par|critical|break|rect|else|and|option|box)\b/iu;
const C4_CALL = /^([A-Za-z][\w]*)\s*\((.*)\)\s*$/u;

function hashText(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
}

function stripMermaidNoise(source: string): string {
  return source
    .replace(/^\uFEFF/, '')
    .replace(/^---[\s\S]*?---\s*/u, '')
    .replace(/%%\{[\s\S]*?\}%%/gu, '')
    .replace(/^[ \t]*%%[^\n]*/gmu, '')
    .replace(/\r\n/g, '\n');
}

function unescapeLabel(value: string): string {
  return value
    .trim()
    .replace(/^["']|["']$/gu, '')
    .replace(/<br\s*\/?>/giu, ' ')
    .replace(/\\n/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function extractMermaidSources(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) return [];
  const fences = [...trimmed.matchAll(/```(?:mermaid)?[ \t]*\n([\s\S]*?)```/giu)]
    .map(match => match[1]?.trim() ?? '')
    .filter(Boolean);
  return fences.length ? fences : [trimmed];
}

function semanticLines(source: string): string[] {
  return stripMermaidNoise(source)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function detectDiagramType(header: string): ImportedMermaidDiagramType | 'unsupported' | undefined {
  if (FLOWCHART_HEADER.test(header)) return 'flowchart';
  if (SEQUENCE_HEADER.test(header)) return 'sequence';
  if (C4_HEADER.test(header)) return 'c4';
  if (UNSUPPORTED_DIAGRAM.test(header)) return 'unsupported';
  return undefined;
}

type Scan = { src: string; i: number };

function skipWs(scan: Scan): void {
  while (scan.i < scan.src.length && /\s/u.test(scan.src[scan.i]!)) scan.i += 1;
}

function parseQuoted(scan: Scan): string | undefined {
  const quote = scan.src[scan.i];
  if (quote !== '"' && quote !== "'") return undefined;
  scan.i += 1;
  let out = '';
  while (scan.i < scan.src.length) {
    const ch = scan.src[scan.i]!;
    if (ch === quote) {
      scan.i += 1;
      return out;
    }
    if (ch === '\\' && scan.i + 1 < scan.src.length) {
      out += scan.src[scan.i + 1]!;
      scan.i += 2;
      continue;
    }
    out += ch;
    scan.i += 1;
  }
  return undefined;
}

function parseFlowId(scan: Scan): string | undefined {
  skipWs(scan);
  const quoted = parseQuoted(scan);
  if (quoted !== undefined) return quoted.trim() || undefined;
  const match = scan.src.slice(scan.i).match(/^[A-Za-z0-9][\w.-]*/u);
  if (!match) return undefined;
  scan.i += match[0].length;
  return match[0];
}

function parseBalanced(scan: Scan, open: string, close: string): string | undefined {
  if (!scan.src.startsWith(open, scan.i)) return undefined;
  const start = scan.i + open.length;
  let depth = 1;
  let i = start;
  let quote: string | undefined;
  while (i < scan.src.length && depth > 0) {
    const ch = scan.src[i]!;
    if (quote) {
      if (ch === '\\') i += 2;
      else {
        if (ch === quote) quote = undefined;
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (scan.src.startsWith(open, i)) {
      depth += 1;
      i += open.length;
      continue;
    }
    if (scan.src.startsWith(close, i)) {
      depth -= 1;
      if (depth === 0) {
        const inner = scan.src.slice(start, i);
        scan.i = i + close.length;
        return inner;
      }
      i += close.length;
      continue;
    }
    i += 1;
  }
  return undefined;
}

function parseFlowShape(scan: Scan): string | undefined {
  skipWs(scan);
  const pairs: Array<[string, string]> = [
    ['([', '])'],
    ['[[', ']]'],
    ['[\\', '\\]'],
    ['[/', '/]'],
    ['[(', ')]'],
    ['((', '))'],
    ['{{', '}}'],
    ['[', ']'],
    ['(', ')'],
    ['{', '}'],
  ];
  for (const [open, close] of pairs) {
    const inner = parseBalanced(scan, open, close);
    if (inner !== undefined) return unescapeLabel(inner) || undefined;
  }
  if (scan.src[scan.i] === '>') {
    const inner = parseBalanced(scan, '>', ']');
    if (inner !== undefined) return unescapeLabel(inner) || undefined;
  }
  return undefined;
}

function parseFlowEdge(scan: Scan): { label?: string } | undefined {
  skipWs(scan);
  const rest = scan.src.slice(scan.i);
  for (const pattern of FLOWCHART_EDGE_PATTERNS) {
    const match = rest.match(pattern.re);
    if (!match) continue;
    scan.i += match[0].length;
    const label = pattern.label !== undefined ? unescapeLabel(match[pattern.label] ?? '') : undefined;
    return { ...(label ? { label } : {}) };
  }
  return undefined;
}

function parseFlowNodeGroup(scan: Scan): Array<{ id: string; name?: string }> | undefined {
  const nodes: Array<{ id: string; name?: string }> = [];
  const readNode = (): { id: string; name?: string } | undefined => {
    const id = parseFlowId(scan);
    if (!id) return undefined;
    const name = parseFlowShape(scan);
    return { id, ...(name ? { name } : {}) };
  };
  const first = readNode();
  if (!first) return undefined;
  nodes.push(first);
  skipWs(scan);
  while (scan.src[scan.i] === '&') {
    scan.i += 1;
    const next = readNode();
    if (!next) return undefined;
    nodes.push(next);
    skipWs(scan);
  }
  return nodes;
}

function parseFlowStatement(line: string): { nodes: Array<{ id: string; name?: string }>; edges: Array<{ from: string; to: string; label?: string }> } | undefined {
  const scan: Scan = { src: line.trim(), i: 0 };
  const nodes: Array<{ id: string; name?: string }> = [];
  const edges: Array<{ from: string; to: string; label?: string }> = [];
  let current = parseFlowNodeGroup(scan);
  if (!current) return undefined;
  nodes.push(...current);
  skipWs(scan);
  while (scan.i < scan.src.length) {
    const edge = parseFlowEdge(scan);
    if (!edge) break;
    const targets = parseFlowNodeGroup(scan);
    if (!targets) return undefined;
    nodes.push(...targets);
    for (const source of current) {
      for (const dest of targets) {
        if (source.id === dest.id) continue;
        edges.push({ from: source.id, to: dest.id, ...(edge.label ? { label: edge.label } : {}) });
      }
    }
    current = targets;
    skipWs(scan);
  }
  skipWs(scan);
  if (scan.i < scan.src.length && scan.src[scan.i] !== ';') return undefined;
  return { nodes, edges };
}

function parseSubgraphHeader(line: string): { id: string; title: string } | undefined {
  const rest = line.replace(/^subgraph\s+/iu, '').trim();
  if (!rest) return undefined;
  const titled = rest.match(/^(\S+)\s*[\["](.+?)[\]"]\s*$/u);
  if (titled) return { id: titled[1]!, title: unescapeLabel(titled[2]!) };
  if (/^["'].+["']$/.test(rest)) {
    const title = unescapeLabel(rest);
    return { id: title, title };
  }
  return { id: rest, title: rest };
}

function parseFlowchart(source: string): ParsedDiagram | string {
  const lines = semanticLines(source);
  const header = lines[0];
  if (!header || !FLOWCHART_HEADER.test(header)) return 'Not a flowchart.';
  const titleMatch = lines.find(line => /^accTitle\s*:/iu.test(line) || /^title\s+/iu.test(line));
  const title = titleMatch
    ? unescapeLabel(titleMatch.replace(/^(?:accTitle\s*:|title)\s*/iu, ''))
    : 'Imported flowchart';
  const body = lines.slice(1).filter(line => !/^(?:accTitle|accDescr|title)\b/iu.test(line));
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const stack: Array<{ id: string; title: string }> = [];

  const ensureNode = (id: string, name?: string, parentId?: string): GraphNode => {
    const existing = nodes.get(id);
    if (existing) {
      if (name && existing.name === existing.mermaidId) existing.name = name;
      if (parentId && !existing.parentMermaidId) existing.parentMermaidId = parentId;
      return existing;
    }
    const parent = parentId ?? stack.at(-1)?.id;
    const node: GraphNode = {
      mermaidId: id,
      name: name || id,
      kind: parent ? 'component' : 'container',
      ...(parent ? { parentMermaidId: parent } : {}),
    };
    nodes.set(id, node);
    return node;
  };

  for (const raw of body) {
    const line = raw.replace(/;$/u, '').trim();
    if (!line || /^(?:classDef|class|style|linkStyle|click|direction)\b/iu.test(line)) continue;
    if (/^subgraph\b/iu.test(line)) {
      const headerInfo = parseSubgraphHeader(line);
      if (!headerInfo) return 'This flowchart subgraph could not be parsed.';
      ensureNode(headerInfo.id, headerInfo.title, stack.at(-1)?.id).kind = 'container';
      stack.push(headerInfo);
      continue;
    }
    if (/^end\b/iu.test(line)) {
      if (!stack.length) return 'This flowchart has an unmatched end.';
      stack.pop();
      continue;
    }
    const parsed = parseFlowStatement(line);
    if (!parsed) return 'This flowchart statement could not be parsed.';
    const parent = stack.at(-1)?.id;
    for (const node of parsed.nodes) ensureNode(node.id, node.name, parent);
    for (const edge of parsed.edges) {
      ensureNode(edge.from, undefined, parent);
      ensureNode(edge.to, undefined, parent);
      edges.push({ from: edge.from, to: edge.to, kind: 'uses', ...(edge.label ? { label: edge.label } : {}) });
    }
  }
  if (stack.length) return 'This flowchart has an unclosed subgraph.';
  if (!nodes.size) return 'This flowchart has no nodes to import.';
  return { type: 'flowchart', title: title || 'Imported flowchart', nodes: [...nodes.values()], edges };
}

function parseSequence(source: string): ParsedDiagram | string {
  const lines = semanticLines(source);
  if (!lines[0] || !SEQUENCE_HEADER.test(lines[0])) return 'Not a sequence diagram.';
  const titleLine = lines.find(line => /^title\s+/iu.test(line) || /^accTitle\s*:/iu.test(line));
  const title = titleLine
    ? unescapeLabel(titleLine.replace(/^(?:title|accTitle\s*:)\s*/iu, ''))
    : 'Imported sequence';
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  let blockDepth = 0;

  const ensureActor = (id: string, name?: string) => {
    const existing = nodes.get(id);
    if (existing) {
      if (name && existing.name === existing.mermaidId) existing.name = name;
      return existing;
    }
    const node: GraphNode = { mermaidId: id, name: name || id, kind: 'container' };
    nodes.set(id, node);
    return node;
  };

  for (const raw of lines.slice(1)) {
    if (/^(?:accTitle|accDescr|title)\b/iu.test(raw)) continue;
    const participant = raw.match(/^(?:participant|actor)\s+(\S+)(?:\s+as\s+(.+))?$/iu);
    if (participant) {
      ensureActor(participant[1]!, participant[2] ? unescapeLabel(participant[2]) : participant[1]);
      continue;
    }
    if (SEQUENCE_BLOCK.test(raw)) {
      blockDepth += 1;
      continue;
    }
    if (/^end\b/iu.test(raw)) {
      if (blockDepth > 0) blockDepth -= 1;
      continue;
    }
    if (/^(?:Note|note)\b/iu.test(raw) || /^(?:activate|deactivate|autonumber|create|destroy)\b/iu.test(raw)) {
      continue;
    }
    const message = raw.match(SEQUENCE_ARROW);
    if (!message) return 'This sequence statement could not be parsed.';
    const from = message[1]!.trim();
    const to = message[5]!.trim();
    const label = unescapeLabel(message[7] ?? '');
    if (!from || !to) return 'This sequence statement could not be parsed.';
    ensureActor(from);
    ensureActor(to);
    edges.push({ from, to, kind: 'calls', ...(label ? { label } : {}) });
  }
  if (!nodes.size) return 'This sequence diagram has no participants to import.';
  return { type: 'sequence', title: title || 'Imported sequence', nodes: [...nodes.values()], edges };
}

function splitCallArgs(inner: string): string[] | undefined {
  const args: string[] = [];
  let current = '';
  let quote: string | undefined;
  let depth = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (quote) {
      if (ch === '\\') {
        current += ch + (inner[i + 1] ?? '');
        i += 1;
        continue;
      }
      current += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ')') {
      if (depth === 0) return undefined;
      depth -= 1;
      current += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      args.push(unescapeLabel(current));
      current = '';
      continue;
    }
    current += ch;
  }
  if (quote || depth !== 0) return undefined;
  if (current.trim()) args.push(unescapeLabel(current));
  return args;
}

function c4Kind(name: string): EntityKind | 'boundary' | undefined {
  const key = name.toLowerCase();
  if (key === 'person' || key === 'person_ext') return 'person';
  if (key === 'system_ext') return 'externalSystem';
  if (key === 'systemdb' || key === 'containerdb' || key === 'componentdb') return 'dataStore';
  if (key === 'systemqueue' || key === 'containerqueue' || key === 'componentqueue') return 'queue';
  if (key === 'system') return 'softwareSystem';
  if (key.startsWith('container')) return 'container';
  if (key.startsWith('component')) return 'component';
  if (key.includes('boundary')) return 'boundary';
  return undefined;
}

function parseC4(source: string): ParsedDiagram | string {
  const lines = semanticLines(source);
  if (!lines[0] || !C4_HEADER.test(lines[0])) return 'Not a C4 diagram.';
  const titleLine = lines.find(line => /^title\s+/iu.test(line));
  const title = titleLine ? unescapeLabel(titleLine.replace(/^title\s+/iu, '')) : 'Imported C4 diagram';
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const boundaryStack: string[] = [];

  const ensure = (id: string, kind: EntityKind, name: string, responsibility?: string, technology?: string[]) => {
    const existing = nodes.get(id);
    const parent = boundaryStack.at(-1);
    if (existing) {
      if (name) existing.name = name;
      return existing;
    }
    const node: GraphNode = {
      mermaidId: id,
      name: name || id,
      kind,
      ...(parent && kind !== 'person' && kind !== 'externalSystem' ? { parentMermaidId: parent } : {}),
      ...(responsibility ? { responsibility } : {}),
      ...(technology?.length ? { technology } : {}),
    };
    nodes.set(id, node);
    return node;
  };

  for (const raw of lines.slice(1)) {
    if (/^title\s+/iu.test(raw) || /^(?:accTitle|accDescr)\b/iu.test(raw) || /^Update(Rel|Element)Style\b/u.test(raw)) {
      continue;
    }
    if (raw === '}') {
      boundaryStack.pop();
      continue;
    }
    const call = raw.replace(/\s*\{\s*$/u, '').match(C4_CALL);
    if (!call) return 'This C4 statement could not be parsed.';
    const name = call[1]!;
    const args = splitCallArgs(call[2] ?? '');
    if (!args) return 'This C4 statement could not be parsed.';
    if (/^Rel(?:_[UDLR])?$|^BiRel$/u.test(name)) {
      const from = args[0];
      const to = args[1];
      if (!from || !to) return 'This C4 relationship is missing endpoints.';
      if (!nodes.has(from)) ensure(from, 'container', from);
      if (!nodes.has(to)) ensure(to, 'container', to);
      edges.push({
        from,
        to,
        kind: 'uses',
        ...(args[2] ? { label: args[2] } : {}),
      });
      continue;
    }
    const kind = c4Kind(name);
    if (!kind) return 'This C4 statement could not be parsed.';
    const alias = args[0];
    if (!alias) return 'This C4 element is missing an alias.';
    if (kind === 'boundary') {
      ensure(alias, 'container', args[1] || alias, args[2]);
      if (raw.endsWith('{')) boundaryStack.push(alias);
      continue;
    }
    ensure(alias, kind, args[1] || alias, args[2], args[3] ? [args[3]] : undefined);
    if (raw.endsWith('{')) boundaryStack.push(alias);
  }
  if (!nodes.size) return 'This C4 diagram has no elements to import.';
  return { type: 'c4', title: title || 'Imported C4 diagram', nodes: [...nodes.values()], edges };
}

function parseOneDiagram(source: string): ParsedDiagram | string {
  const header = semanticLines(source)[0] ?? '';
  const type = detectDiagramType(header);
  if (type === 'flowchart') return parseFlowchart(source);
  if (type === 'sequence') return parseSequence(source);
  if (type === 'c4') return parseC4(source);
  if (type === 'unsupported') {
    return 'This Mermaid diagram type cannot be imported. Use a flowchart, sequence diagram, or C4 diagram.';
  }
  return 'This is not valid Mermaid. Paste a flowchart, sequence diagram, or C4 diagram.';
}

function slug(value: string, fallback: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return cleaned || fallback;
}

function uniqueId(used: Set<string>, prefix: string, raw: string): string {
  const base = `${prefix}:${slug(raw, 'node')}`;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let index = 2;
  while (used.has(`${base}-${index}`)) index += 1;
  const next = `${base}-${index}`;
  used.add(next);
  return next;
}

function importedSourceRef() {
  return { path: IMPORTED_MERMAID_SOURCE_PATH, commitSha: IMPORTED_MERMAID_REVISION };
}

function projectDiagrams(diagrams: ParsedDiagram[], source: string): ImportedMermaidAtlas | string {
  const nodeCount = diagrams.reduce((sum, diagram) => sum + diagram.nodes.length, 0);
  const edgeCount = diagrams.reduce((sum, diagram) => sum + diagram.edges.length, 0);
  if (nodeCount > MAX_IMPORTED_MERMAID_NODES) return 'This Mermaid diagram has too many nodes to import.';
  if (edgeCount > MAX_IMPORTED_MERMAID_EDGES) return 'This Mermaid diagram has too many edges to import.';

  const usedIds = new Set<string>();
  const digest = hashText(source);
  const rootId = uniqueId(usedIds, 'system', diagrams.length > 1 ? 'imported-mermaid' : diagrams[0]?.title ?? 'imported-mermaid');
  const rootName = diagrams.length === 1 ? diagrams[0]!.title : 'Imported Mermaid diagrams';
  const entities: ArchitectureEntity[] = [];
  const relations: ArchitectureRelation[] = [];
  const frameEntityIds: string[] = [];
  let frameDetail: SemanticDetail = 'container';

  const root: ArchitectureEntity = {
    id: rootId,
    lineageId: `lineage:${rootId}`,
    fingerprint: `imported:${rootId}:${digest}`,
    kind: 'softwareSystem',
    name: rootName,
    responsibility: diagrams.length === 1
      ? `Imported ${diagrams[0]!.type} diagram.`
      : `Imported ${diagrams.length} Mermaid diagrams.`,
    sourceRefs: [importedSourceRef()],
  };
  entities.push(root);

  diagrams.forEach((diagram, diagramIndex) => {
    const mermaidToEntity = new Map<string, string>();
    const diagramRootId = diagrams.length === 1
      ? rootId
      : uniqueId(usedIds, 'system', diagram.title || `diagram-${diagramIndex + 1}`);
    if (diagrams.length > 1) {
      entities.push({
        id: diagramRootId,
        lineageId: `lineage:${diagramRootId}`,
        fingerprint: `imported:${diagramRootId}:${digest}`,
        kind: 'softwareSystem',
        parentId: rootId,
        name: diagram.title,
        responsibility: `Imported ${diagram.type} diagram.`,
        sourceRefs: [importedSourceRef()],
      });
    }

    const parentMermaidToEntity = (parentMermaidId: string | undefined): string => {
      if (!parentMermaidId) return diagramRootId;
      return mermaidToEntity.get(parentMermaidId) ?? diagramRootId;
    };

    const ordered = [...diagram.nodes].sort((left, right) => {
      const leftDepth = left.parentMermaidId ? 1 : 0;
      const rightDepth = right.parentMermaidId ? 1 : 0;
      return leftDepth - rightDepth || left.mermaidId.localeCompare(right.mermaidId);
    });
    for (const node of ordered) {
      const kindPrefix = node.kind === 'person'
        ? 'actor'
        : node.kind === 'softwareSystem'
          ? 'system'
          : node.kind === 'externalSystem'
            ? 'external'
            : node.kind === 'dataStore'
              ? 'store'
              : node.kind === 'queue'
                ? 'queue'
                : node.kind === 'component'
                  ? 'component'
                  : 'container';
      const id = uniqueId(usedIds, kindPrefix, node.mermaidId);
      mermaidToEntity.set(node.mermaidId, id);
      const parentId = node.kind === 'person' || node.kind === 'externalSystem'
        ? undefined
        : parentMermaidToEntity(node.parentMermaidId);
      entities.push({
        id,
        lineageId: `lineage:${id}`,
        fingerprint: `imported:${id}:${digest}`,
        kind: node.kind,
        ...(parentId ? { parentId } : {}),
        name: node.name,
        responsibility: node.responsibility ?? `Imported from Mermaid ${diagram.type}.`,
        ...(node.technology?.length ? { technology: node.technology } : {}),
        sourceRefs: [importedSourceRef()],
      });
      frameEntityIds.push(id);
    }

    diagram.edges.forEach((edge, edgeIndex) => {
      const from = mermaidToEntity.get(edge.from);
      const to = mermaidToEntity.get(edge.to);
      if (!from || !to || from === to) return;
      const id = uniqueId(usedIds, 'relation', `${edge.from}-${edge.to}-${edgeIndex}`);
      relations.push({
        id,
        lineageId: `lineage:${id}`,
        fingerprint: `imported:${id}:${digest}`,
        from,
        to,
        kind: edge.kind,
        ...(edge.label ? { label: edge.label } : {}),
        evidence: [{ source: importedSourceRef() }],
      });
    });
  });

  const graphKinds = new Set(entities.filter(entity => entity.id !== rootId).map(entity => entity.kind));
  if (graphKinds.has('component') && ![...graphKinds].some(kind => kind === 'container' || kind === 'dataStore' || kind === 'queue' || kind === 'softwareSystem')) {
    frameDetail = 'component';
  } else if (graphKinds.has('container') || graphKinds.has('dataStore') || graphKinds.has('queue')) {
    frameDetail = 'container';
  } else {
    frameDetail = 'context';
  }

  const snapshot: ArchitectureSnapshot = {
    schemaVersion: ARCHITECTURE_SCHEMA_VERSION,
    id: `snapshot:imported-mermaid:${digest}`,
    repositoryId: 'repo:imported-mermaid',
    commitSha: IMPORTED_MERMAID_REVISION,
    generatedAt: '1970-01-01T00:00:00.000Z',
    entities,
    relations,
  };
  return {
    snapshot,
    rootEntityId: rootId,
    frameEntityIds: frameEntityIds.length ? frameEntityIds : [rootId],
    frameDetail,
    title: rootName,
    diagramTypes: diagrams.map(diagram => diagram.type),
  };
}

export function importMermaidToAtlas(input: string): MermaidImportResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, message: 'Paste or open a Mermaid diagram first. The atlas is unchanged.' };
  }
  if (trimmed.length > MAX_IMPORTED_MERMAID_SOURCE_LENGTH) {
    return { ok: false, message: 'This Mermaid source is too large to import. The atlas is unchanged.' };
  }
  const sources = extractMermaidSources(trimmed);
  if (!sources.length) {
    return { ok: false, message: 'No Mermaid diagram was found. The atlas is unchanged.' };
  }
  const diagrams: ParsedDiagram[] = [];
  for (const source of sources) {
    const parsed = parseOneDiagram(source);
    if (typeof parsed === 'string') {
      return { ok: false, message: `${parsed} The atlas is unchanged.` };
    }
    diagrams.push(parsed);
  }
  const projected = projectDiagrams(diagrams, trimmed);
  if (typeof projected === 'string') {
    return { ok: false, message: `${projected} The atlas is unchanged.` };
  }
  return { ok: true, atlas: projected };
}
