import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RepositoryPin } from "./pin.js";
import {
  packetFileName,
  type EmittedPackets,
  type EnrichmentPacket,
  type SystemPacket,
} from "./packet.js";
import { scrubGithubTokens } from "./redact.js";

/**
 * Frozen `okie-enrichment/v2` contract. Loaded as file bytes and concatenated;
 * never templated, parameterized, or rewritten.
 */
export function frozenEnrichmentPromptPath(): string {
  return fileURLToPath(new URL("../enrichment-prompt.md", import.meta.url));
}

/** Exact bytes of `packages/scan/enrichment-prompt.md` (utf8). */
export function readFrozenEnrichmentPrompt(): string {
  return readFileSync(frozenEnrichmentPromptPath(), "utf8");
}

/** Prompt sidecar next to a packet file: `container__<id>.prompt.md`. */
export function promptFileName(id: string): string {
  return packetFileName(id).replace(/\.json$/, ".prompt.md");
}

/** Same bytes as `stableJson` in scan.ts / CLI packet files. */
function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export interface FileTreeNode {
  name: string;
  path?: string;
  children?: FileTreeNode[];
}

export interface OwnershipNode {
  id: string;
  name: string;
  kind: string;
  children: OwnershipNode[];
}

/**
 * Data concatenated after the frozen prefix and packet JSON. Not instructions.
 * `packetFile` is the enrich-from filename (same as the packet), never a host path.
 */
export interface EnrichmentPromptAppendix {
  commitSha: string;
  treeHash: string;
  packetFile: string;
  fileTree: FileTreeNode[];
  ownershipTree: OwnershipNode;
}

export function isSystemPacket(packet: EnrichmentPacket | SystemPacket): packet is SystemPacket {
  return "scope" in packet && packet.scope === "system";
}

/** Nested directory tree from repo-relative paths. Sorted at every level. */
export function buildFileTree(paths: readonly string[]): FileTreeNode[] {
  const root: FileTreeNode = { name: "", children: [] };
  for (const path of [...paths].sort()) {
    const parts = path.split("/").filter(part => part.length > 0);
    let cursor = root;
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index]!;
      const isFile = index === parts.length - 1;
      cursor.children ??= [];
      let child = cursor.children.find(node => node.name === name);
      if (!child) {
        child = isFile ? { name, path } : { name, children: [] };
        cursor.children.push(child);
      }
      cursor = child;
    }
  }
  const sortTree = (nodes: FileTreeNode[]): FileTreeNode[] => {
    nodes.sort((left, right) => left.name.localeCompare(right.name));
    for (const node of nodes) {
      if (node.children) sortTree(node.children);
    }
    return nodes;
  };
  return sortTree(root.children ?? []);
}

/** C4 ownership derived from the packet only — no extra I/O, no out-of-scope ids. */
export function ownershipTreeFromPacket(packet: EnrichmentPacket | SystemPacket): OwnershipNode {
  if (isSystemPacket(packet)) {
    const children: OwnershipNode[] = [
      ...packet.containers.map(container => ({
        id: container.id, name: container.name, kind: "container", children: [] as OwnershipNode[],
      })),
      ...packet.externalSystems.map(external => ({
        id: external.id, name: external.name, kind: "externalSystem", children: [] as OwnershipNode[],
      })),
    ].sort((left, right) => left.id.localeCompare(right.id));
    return { id: packet.systemId, name: packet.systemName, kind: "softwareSystem", children };
  }

  const codeByComponent = new Map<string, OwnershipNode[]>();
  for (const code of packet.code) {
    const bucket = codeByComponent.get(code.componentId) ?? [];
    bucket.push({ id: code.id, name: code.name, kind: "code", children: [] });
    codeByComponent.set(code.componentId, bucket);
  }
  for (const bucket of codeByComponent.values()) {
    bucket.sort((left, right) => left.id.localeCompare(right.id));
  }
  const children = packet.components
    .map(component => ({
      id: component.id,
      name: component.name,
      kind: "component",
      children: codeByComponent.get(component.id) ?? [],
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return { id: packet.containerId, name: packet.containerName, kind: "container", children };
}

/**
 * Concatenate-only prompt: frozen prefix bytes, then packet JSON (same bytes as the
 * packet file), then the appendix JSON. No Jinja, no parameterization of the prefix.
 */
export function concatenateEnrichmentPrompt(params: {
  prefix: string;
  packet: EnrichmentPacket | SystemPacket;
  appendix: EnrichmentPromptAppendix;
}): string {
  const head = params.prefix.endsWith("\n") ? params.prefix : `${params.prefix}\n`;
  const packetJson = stableJson(params.packet);
  const appendixJson = scrubGithubTokens(stableJson(params.appendix));
  return `${head}${packetJson}${appendixJson}`;
}

export function appendixForPacket(
  packet: EnrichmentPacket | SystemPacket,
  pin: Pick<RepositoryPin, "commitSha" | "treeHash">,
  id: string,
): EnrichmentPromptAppendix {
  return {
    commitSha: pin.commitSha,
    treeHash: pin.treeHash,
    packetFile: packetFileName(id),
    fileTree: buildFileTree(packet.scopePaths),
    ownershipTree: ownershipTreeFromPacket(packet),
  };
}

/** Writes the existing `--emit-packets` layout (unchanged filenames and JSON). */
export function writeEnrichmentPackets(dir: string, emitted: EmittedPackets): void {
  mkdirSync(dir, { recursive: true });
  for (const packet of emitted.packets) {
    writeFileSync(`${dir}/${packetFileName(packet.containerId)}`, stableJson(packet));
  }
  if (emitted.systemPacket) {
    writeFileSync(`${dir}/${packetFileName(emitted.systemPacket.systemId)}`, stableJson(emitted.systemPacket));
  }
  writeFileSync(`${dir}/manifest.json`, stableJson(emitted.manifest));
}

/** Writes one concatenated `.prompt.md` per packet (prefix + packet JSON + appendix). */
export function writeEnrichmentPrompts(
  dir: string,
  emitted: EmittedPackets,
  pin: Pick<RepositoryPin, "commitSha" | "treeHash">,
  prefix: string,
): void {
  mkdirSync(dir, { recursive: true });
  const writeOne = (id: string, packet: EnrichmentPacket | SystemPacket): void => {
    writeFileSync(`${dir}/${promptFileName(id)}`, concatenateEnrichmentPrompt({
      prefix,
      packet,
      appendix: appendixForPacket(packet, pin, id),
    }));
  };
  for (const packet of emitted.packets) writeOne(packet.containerId, packet);
  if (emitted.systemPacket) writeOne(emitted.systemPacket.systemId, emitted.systemPacket);
}

/**
 * `--emit-prompt` output: same packet files as `--emit-packets`, plus concatenated prompts.
 * Does not invent a merge path — merge remains `--enrich-from`.
 */
export function writePromptEmission(
  dir: string,
  emitted: EmittedPackets,
  pin: Pick<RepositoryPin, "commitSha" | "treeHash">,
  prefix: string,
): void {
  writeEnrichmentPackets(dir, emitted);
  writeEnrichmentPrompts(dir, emitted, pin, prefix);
}
