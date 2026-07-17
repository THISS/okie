import type { ArchitectureExtraction } from "@okie/architecture";
import { containerScopes } from "./scope.js";

/** Prompt/packet contract version — the promptVersion of the future hash domains. */
export const ENRICHMENT_PROMPT_VERSION = "okie-enrichment/v1";

/** Header lines included per scope file. Bounded redaction budget — in-scope only. */
const MAX_HEADER_LINES = 24;

export interface PacketComponent {
  id: string;
  name: string;
  path: string;
}

export interface PacketCode {
  id: string;
  name: string;
  path: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  componentId: string;
}

export interface PacketRelation {
  id: string;
  from: string;
  to: string;
  kind: string;
}

export interface PacketExcerpt {
  path: string;
  startLine: number;
  endLine: number;
  lines: string[];
}

/**
 * The bounded, redacted context handed to one enrichment agent. Contains ONLY the
 * container's own scope — never a byte from outside it.
 */
export interface EnrichmentPacket {
  promptVersion: string;
  containerId: string;
  containerName: string;
  scopePaths: string[];
  components: PacketComponent[];
  code: PacketCode[];
  relations: PacketRelation[];
  excerpts: PacketExcerpt[];
}

export interface PacketManifestEntry {
  containerId: string;
  file: string;
  hash: string;
  components: number;
  codeEntities: number;
}

export interface PacketManifest {
  promptVersion: string;
  packets: PacketManifestEntry[];
}

export interface EmittedPackets {
  packets: EnrichmentPacket[];
  manifest: PacketManifest;
}

/** FNV-1a 32-bit content hash — deterministic, content-addressed packet identity. */
export function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stable(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Builds one packet per code-bearing container. Empty components (no top-level
 * declarations) are listed for context but are NOT enrichment targets — they stay on
 * the deterministic base. Excerpts are capped file headers, strictly within scope.
 */
export function buildEnrichmentPackets(
  extraction: ArchitectureExtraction,
  readFile: (repoRelativePath: string) => string,
): EmittedPackets {
  const scopes = containerScopes(extraction);
  const relationsFor = (memberIds: ReadonlySet<string>): PacketRelation[] =>
    extraction.relations
      .filter(relation => memberIds.has(relation.from) || memberIds.has(relation.to))
      .map(relation => ({ id: relation.id, from: relation.from, to: relation.to, kind: relation.kind }))
      .sort((left, right) => left.id.localeCompare(right.id));

  const packets: EnrichmentPacket[] = [];
  for (const [containerId, scope] of [...scopes.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (scope.codeBearing.length === 0) continue; // nothing to regroup

    const memberIds = new Set<string>([
      containerId,
      ...scope.components.map(component => component.id),
      ...scope.code.map(code => code.id),
    ]);
    const excerpts: PacketExcerpt[] = scope.scopePaths.map(path => {
      const lines = readFile(path).replace(/\r\n/g, "\n").split("\n").slice(0, MAX_HEADER_LINES);
      return { path, startLine: 1, endLine: lines.length, lines };
    });

    packets.push({
      promptVersion: ENRICHMENT_PROMPT_VERSION,
      containerId,
      containerName: scope.container.name,
      scopePaths: scope.scopePaths,
      components: scope.codeBearing.map(component => ({
        id: component.id,
        name: component.name,
        path: scope.pathByComponentId.get(component.id) ?? "",
      })),
      code: scope.code.map(code => {
        const source = code.sourceRefs[0];
        return {
          id: code.id,
          name: code.name,
          path: source?.path ?? "",
          ...(source?.symbol !== undefined ? { symbol: source.symbol } : {}),
          ...(source?.startLine !== undefined ? { startLine: source.startLine } : {}),
          ...(source?.endLine !== undefined ? { endLine: source.endLine } : {}),
          componentId: code.parentId ?? "",
        };
      }),
      relations: relationsFor(memberIds),
      excerpts,
    });
  }

  const manifest: PacketManifest = {
    promptVersion: ENRICHMENT_PROMPT_VERSION,
    packets: packets.map(packet => ({
      containerId: packet.containerId,
      file: packetFileName(packet.containerId),
      hash: contentHash(stable(packet)),
      components: packet.components.length,
      codeEntities: packet.code.length,
    })),
  };
  return { packets, manifest };
}

/**
 * Reversible packet file name for a container id: the single `:` becomes `__`
 * (slugs never contain `__`), so `containerIdFromFileName` can recover the id even
 * when the enrichment doc itself is malformed.
 */
export function packetFileName(containerId: string): string {
  return `${containerId.replace(/:/g, "__")}.json`;
}

/** Inverse of packetFileName; returns undefined for names that aren't packet files. */
export function containerIdFromFileName(fileName: string): string | undefined {
  if (!fileName.endsWith(".json")) return undefined;
  return fileName.slice(0, -".json".length).replace(/__/g, ":");
}
