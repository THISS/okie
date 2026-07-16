#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function readInteger(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number.parseInt(process.argv[index + 1] ?? "", 10);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function readString(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
}

function mulberry32(seed) {
  return () => {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const nodeCount = readInteger("nodes", 5_000);
const edgeCount = readInteger("edges", 15_000);
const seed = readInteger("seed", 42);
const output = resolve(readString("output", `fixtures/renderer/stress-${nodeCount}.json`));
const random = mulberry32(seed);
const columns = Math.ceil(Math.sqrt(nodeCount * (16 / 9)));
const rows = Math.ceil(nodeCount / columns);
const cellWidth = 118;
const cellHeight = 82;
const nodeWidth = 78;
const nodeHeight = 48;

const objects = Array.from({ length: nodeCount }, (_, index) => {
  const column = index % columns;
  const row = Math.floor(index / columns);
  const x = column * cellWidth + 20;
  const y = row * cellHeight + 20;
  const rect = { x, y, width: nodeWidth, height: nodeHeight };
  return {
    id: `stress:node:${index.toString().padStart(5, "0")}`,
    zIndex: 1,
    bounds: rect,
    pickable: true,
    representations: [
      {
        id: `stress:node:${index.toString().padStart(5, "0")}:overview`,
        lod: { minZoom: 0, maxZoom: 2, fadeWidth: 0.1, hysteresis: 0.04 },
        primitives: [
          { kind: "roundedRect", rect, radius: 7, fill: [0.094, 0.216, 0.38, 1] },
        ],
      },
      {
        id: `stress:node:${index.toString().padStart(5, "0")}:detail`,
        lod: { minZoom: 1.8, maxZoom: null, fadeWidth: 0.1, hysteresis: 0.04 },
        primitives: [
          { kind: "roundedRect", rect, radius: 7, fill: [0.094, 0.216, 0.38, 1] },
          {
            kind: "text",
            position: { x: x + 8, y: y + 27 },
            maxWidth: nodeWidth - 16,
            content: `Node ${index}`,
            fontFamily: "Inter",
            fontSize: 10,
            color: [0.957, 0.969, 1, 1],
            align: "start",
          },
        ],
      },
    ],
  };
});

const paths = [];
const pairs = new Set();
const maximumPairs = nodeCount * (nodeCount - 1);
if (edgeCount > maximumPairs) throw new Error(`Cannot create ${edgeCount} unique directed edges for ${nodeCount} nodes`);
while (paths.length < edgeCount) {
  const fromIndex = Math.floor(random() * nodeCount);
  const toIndex = Math.floor(random() * nodeCount);
  if (fromIndex === toIndex) continue;
  const key = `${fromIndex}:${toIndex}`;
  if (pairs.has(key)) continue;
  pairs.add(key);
  const from = objects[fromIndex];
  const to = objects[toIndex];
  if (!from || !to) throw new Error("Generator selected an invalid node index");
  paths.push({
    id: `stress:path:${paths.length.toString().padStart(5, "0")}`,
    fromObjectId: from.id,
    toObjectId: to.id,
    points: [
      { x: from.bounds.x + nodeWidth / 2, y: from.bounds.y + nodeHeight / 2 },
      { x: to.bounds.x + nodeWidth / 2, y: to.bounds.y + nodeHeight / 2 },
    ],
    stroke: [0.463, 0.525, 0.659, 0.42],
    width: 1,
    arrow: "end",
    optional: false,
    pickable: false,
    lod: { minZoom: 0, maxZoom: null, fadeWidth: 0.08, hysteresis: 0.03 },
  });
}

const scene = {
  protocolVersion: 1,
  sceneId: `scene:stress:${nodeCount}:${edgeCount}:${seed}`,
  revision: 1,
  worldBounds: {
    x: 0,
    y: 0,
    width: columns * cellWidth + 40,
    height: rows * cellHeight + 40,
  },
  objects,
  paths,
};

await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(scene)}\n`);
console.log(`Wrote ${objects.length} objects and ${paths.length} paths to ${output}`);
