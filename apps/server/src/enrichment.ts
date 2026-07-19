import Anthropic from "@anthropic-ai/sdk";
import type { EmittedPackets, EnrichmentPacket, SystemPacket } from "@okie/scan";

/**
 * Live-LLM enrichment adapter (scan-runner M3): turns the scanner's bounded,
 * redacted packets into gate-shaped enrichment documents. The adapter is
 * deliberately dumb about correctness — every document it returns still goes
 * through `mergeEnrichment`'s atomic per-scope gate, so a hallucinated id or a
 * broken coverage rule rejects THAT scope and the deterministic base publishes
 * untouched. Resilience contract (see GithubScanOptions.enrichWithPackets): a
 * per-scope failure omits that scope's doc; a total failure returns an empty map.
 */

export const ENRICHMENT_MODEL = "claude-opus-4-8";

/** Scopes larger than this are left deterministic — restating every code entity
 *  in the reply would not fit a sane output budget, and huge containers are
 *  exactly where file-grained components still read fine. Surfaced, never silent. */
export const MAX_ENRICHABLE_CODE_ENTITIES = 400;

const MAX_OUTPUT_TOKENS = 64_000;

export type PacketKind = "container" | "system";

/** The one seam that touches the network: packet in, parsed JSON document out. */
export type EnrichmentGenerator = (
  packet: EnrichmentPacket | SystemPacket,
  kind: PacketKind,
  /** The base system id every document must restate (the merge gate's anchor). */
  systemId: string,
) => Promise<unknown>;

export interface EnricherOptions {
  /** Injectable generator (tests). Default: the Anthropic streaming generator. */
  generate?: EnrichmentGenerator;
  /** Concurrent in-flight scopes (default 2 — bounded, order-independent by design). */
  maxConcurrent?: number;
  onProgress?: (note: string) => void;
}

const SOURCE_REF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: { type: "string" },
    symbol: { type: "string" },
    startLine: { type: "integer" },
    endLine: { type: "integer" },
  },
} as const;

const ENTITY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "name", "sourceRefs"],
  properties: {
    id: { type: "string" },
    kind: { enum: ["softwareSystem", "container", "component", "code", "person", "externalSystem"] },
    parentId: { type: "string" },
    name: { type: "string" },
    responsibility: { type: "string" },
    technology: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    sourceRefs: { type: "array", items: SOURCE_REF_SCHEMA },
  },
} as const;

const RELATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "from", "to", "kind", "evidence"],
  properties: {
    id: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    kind: { enum: ["uses", "calls", "reads", "writes", "publishes", "subscribes", "dependsOn"] },
    label: { type: "string" },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source"],
        properties: { source: SOURCE_REF_SCHEMA, reason: { type: "string" } },
      },
    },
  },
} as const;

/** ArchitectureExtraction shape, constrained enough that replies always parse. */
const EXTRACTION_DOC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "entities", "relations"],
  properties: {
    schemaVersion: { const: 1 },
    entities: { type: "array", items: ENTITY_SCHEMA },
    relations: { type: "array", items: RELATION_SCHEMA },
  },
} as const;

const CONTAINER_SYSTEM_PROMPT = `You are an architecture curator for a C4 atlas built from a deterministic repository scan.
You receive one JSON "enrichment packet" describing a single container: its file components, its code entities (the public symbols of each file), the import relations that touch it, and the first lines of each file.

Propose LOGICAL COMPONENTS that regroup this container's files by responsibility, so a reader sees 3–9 meaningful parts instead of one card per file. Return ONE JSON document with this exact contract — documents violating any rule are rejected whole:

1. Restate exactly one softwareSystem entity: the id given as the packet's system anchor (see user message), name unchanged, no parentId.
2. Restate exactly one container entity: the packet's containerId, parented to the system id, name unchanged. You may add a one-sentence "responsibility".
3. Add your proposed components: kind "component", parentId = the containerId, id namespaced "component:<container-local-slug>-<your-slug>" where <container-local-slug> is the containerId with its "container:" prefix removed. Ids are lowercase kebab-case. Give each a clear human name and a 1–2 sentence "responsibility" describing what it does for the system (plain prose, no marketing). sourceRefs: [] (they are derived from the code you assign).
4. Restate EVERY code entity from the packet — total coverage, none omitted — changing ONLY parentId to one of your proposed component ids. id, kind, name, and sourceRefs must be copied byte-for-byte from the packet. All code entities from the same file path must land in the same component (file cohesion).
5. Give each code entity a one-sentence "responsibility": what this public symbol does and what callers use it for. The packet's relations list shows the observed usage graph — a code entity that appears in NO relation is an island, and its responsibility MUST explain why it stands alone (for example: entry-point API consumed by downstream repos, a config constant read at build time, a type-only export, a re-exported convenience). Never leave an island undescribed.
6. relations must be [] — relations are deterministic and not yours to propose.

Group by domain responsibility (what the code is FOR), not by file-name similarity. Prefer fewer, well-named components over many thin ones.`;

const SYSTEM_SCOPE_PROMPT = `You are an architecture curator for a C4 atlas built from a deterministic repository scan.
You receive one JSON "system packet": the software system, its containers, its external dependencies, and short README excerpts.

Propose the TOP-LEVEL ACTORS (people or external roles) that interact with this system, as C4 L1 persons. Return ONE JSON document with this exact contract — documents violating any rule are rejected whole:

1. Restate exactly one softwareSystem entity with the packet's systemId (name unchanged, no parentId).
2. Add 1–3 person entities: kind "person", NO parentId, id "person:<kebab-slug>", a human name (e.g. "Library user", "Maintainer"), a one-sentence "responsibility", and sourceRefs citing ONLY paths from the packet's scopePaths (usually a README).
3. Add relations connecting each person to the system, a container, or an external system: kind "uses", id "relation:<from-local>-<to-local>", a short label ("integrates the library", "maintains releases"), and evidence whose source.path is in scopePaths.
4. Do NOT add or modify containers, components, or code — restated container/external entities are only allowed as untouched anchors, and it is safer to not restate them at all unless a relation needs the endpoint.

Ground the actors in what the README actually says the project is for.`;

function anthropicGenerator(client: Anthropic): EnrichmentGenerator {
  return async (packet, kind, systemId) => {
    const stream = client.messages.stream({
      model: ENRICHMENT_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      thinking: { type: "adaptive" },
      system: kind === "container" ? CONTAINER_SYSTEM_PROMPT : SYSTEM_SCOPE_PROMPT,
      output_config: { format: { type: "json_schema", schema: EXTRACTION_DOC_SCHEMA } },
      messages: [{
        role: "user",
        content: kind === "container"
          ? `The softwareSystem anchor id your document must restate: ${systemId}\n\nEnrichment packet:\n${JSON.stringify(packet, null, 2)}`
          : `System packet:\n${JSON.stringify(packet, null, 2)}`,
      }],
    });
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") throw new Error("model refused the enrichment request");
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map(block => block.text)
      .join("");
    return JSON.parse(text) as unknown;
  };
}

/**
 * Builds the `enrichWithPackets` hook for GithubScanOptions. Never throws:
 * per-scope failures are logged through onProgress and that scope stays on the
 * deterministic base.
 */
export function createEnricher(options: EnricherOptions = {}): (packets: EmittedPackets) => Promise<ReadonlyMap<string, unknown>> {
  const progress = options.onProgress ?? (() => {});
  const generate = options.generate ?? anthropicGenerator(new Anthropic());
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 2);

  return async ({ packets, systemPacket }) => {
    const docs = new Map<string, unknown>();
    if (!systemPacket) {
      // No system root means no gate anchor for container docs — nothing to enrich.
      progress("enrich: no system packet in this scan; staying deterministic");
      return docs;
    }
    const systemId = systemPacket.systemId;
    const work: Array<{ id: string; packet: EnrichmentPacket | SystemPacket; kind: PacketKind }> = [];
    for (const packet of packets) {
      if (packet.code.length > MAX_ENRICHABLE_CODE_ENTITIES) {
        progress(`enrich ${packet.containerId}: skipped (${packet.code.length} code entities > ${MAX_ENRICHABLE_CODE_ENTITIES} cap; stays deterministic)`);
        continue;
      }
      work.push({ id: packet.containerId, packet, kind: "container" });
    }
    work.push({ id: systemId, packet: systemPacket, kind: "system" });

    let index = 0;
    let firstFailure: string | undefined;
    const runNext = async (): Promise<void> => {
      while (index < work.length) {
        const item = work[index]!;
        index += 1;
        try {
          progress(`enrich ${item.id}: requesting proposal`);
          const doc = await generate(item.packet, item.kind, systemId);
          docs.set(item.id, doc);
          progress(`enrich ${item.id}: proposal received`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          firstFailure ??= message;
          progress(`enrich ${item.id}: failed (${message}); stays deterministic`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(maxConcurrent, work.length) }, runNext));
    // Partial success republishes what the gate accepts; TOTAL failure (typically
    // bad credentials) is surfaced as a throw so the job records an honest
    // "enrichment failed" instead of "complete, 0 containers".
    if (work.length > 0 && docs.size === 0 && firstFailure !== undefined) {
      throw new Error(`all ${work.length} enrichment scope(s) failed — first error: ${firstFailure}`);
    }
    return docs;
  };
}
