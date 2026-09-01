import Anthropic from "@anthropic-ai/sdk";
import type { EmittedPackets, EnrichmentPacket, SystemPacket } from "@okie/scan";
import {
  DEFAULT_MAX_ENRICHMENT_DOLLARS,
  DEFAULT_MAX_ENRICHMENT_SCOPES,
  DEFAULT_MAX_ENRICHMENT_TOKENS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  isUsableModelId,
  requireUsableModelId,
  shouldSkipRemainingScopes,
  withDeadline,
  type EnrichmentBudget,
  type GatewayUsage,
} from "./llmGateway.js";

/**
 * Live-LLM enrichment adapter (scan-runner M3): turns the scanner's bounded,
 * redacted packets into gate-shaped enrichment documents. The adapter is
 * deliberately dumb about correctness — every document it returns still goes
 * through `mergeEnrichment`'s atomic per-scope gate, so a hallucinated id or a
 * broken coverage rule rejects THAT scope and the deterministic base publishes
 * untouched. Resilience contract (see GithubScanOptions.enrichWithPackets): a
 * per-scope failure omits that scope's doc; a total failure returns an empty map.
 */

/** Scopes larger than this are left deterministic — restating every code entity
 *  in the reply would not fit a sane output budget, and huge containers are
 *  exactly where file-grained components still read fine. Surfaced, never silent. */
export const MAX_ENRICHABLE_CODE_ENTITIES = 400;

const MAX_OUTPUT_TOKENS = 64_000;

export type PacketKind = "container" | "system";

/** One scope's proposal: the document the gate consumes, plus optional gateway usage. */
export interface EnrichmentProposal {
  document: unknown;
  usage?: GatewayUsage;
}

/** The one seam that touches the network: packet in, parsed JSON document out. */
export type EnrichmentGenerator = (
  packet: EnrichmentPacket | SystemPacket,
  kind: PacketKind,
  /** The base system id every document must restate (the merge gate's anchor). */
  systemId: string,
) => Promise<EnrichmentProposal>;

export interface EnricherOptions {
  /** Injectable generator (tests). Default: the Anthropic streaming generator. */
  generate?: EnrichmentGenerator;
  /**
   * Operator-configured model id (CLA-21). Opaque string the gateway understands.
   * Empty fails the pass. Packet HTTP still uses the Anthropic SDK until CLA-23,
   * but the request uses this id rather than a hardcoded model table.
   */
  modelId?: string;
  /**
   * OpenAI-compatible gateway client (CLA-20). Constructed when a gateway key is
   * present. Packet HTTP still uses the Anthropic SDK until CLA-23.
   */
  gateway?: { baseUrl: string; modelId: string };
  /** Per-request timeout + scan-level caps (CLA-22). Defaults are the documented constants. */
  budget?: Partial<EnrichmentBudget>;
  /** Concurrent in-flight scopes (default 2 — bounded, order-independent by design). */
  maxConcurrent?: number;
  onProgress?: (note: string) => void;
}

function resolveBudget(partial?: Partial<EnrichmentBudget>): EnrichmentBudget {
  return {
    requestTimeoutMs: partial?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    maxScopes: partial?.maxScopes ?? DEFAULT_MAX_ENRICHMENT_SCOPES,
    maxTokens: partial?.maxTokens ?? DEFAULT_MAX_ENRICHMENT_TOKENS,
    maxDollars: partial?.maxDollars ?? DEFAULT_MAX_ENRICHMENT_DOLLARS,
  };
}

function addDollars(left: number, right: number): number {
  return Math.round((left + right) * 1e6) / 1e6;
}

/** Model id the pass will send. Gateway overlay wins only when `modelId` is unset. */
export function resolveEnrichmentPassModelId(options: EnricherOptions): string | undefined {
  const configured = options.modelId ?? options.gateway?.modelId;
  return isUsableModelId(configured) ? configured!.trim() : undefined;
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
4. Restate each container from the packet with its exact id, parented to the system, name unchanged, sourceRefs [] — and give each a one-sentence "responsibility" saying what it is for. This matters MOST for containers with no visible code (native/Rust crates, generated packages): the reader sees an empty box otherwise, so explain its role in the system (e.g. "Rust renderer core compiled to WASM", "wire protocol contract shared with the renderer"). Do NOT add or modify components or code, and never invent containers not in the packet.

Ground everything in what the README actually says the project is for.`;

/**
 * Fields the Anthropic SDK (and, later, the gateway) receive for one scope.
 * The model id is the configured string — not a lookup table.
 */
export function enrichmentStreamParams(
  modelId: string,
  kind: PacketKind,
  systemId: string,
  packet: EnrichmentPacket | SystemPacket,
  maxOutputTokens: number = MAX_OUTPUT_TOKENS,
) {
  const maxTokens = Math.max(1, Math.min(MAX_OUTPUT_TOKENS, Math.floor(maxOutputTokens)));
  return {
    model: requireUsableModelId(modelId),
    max_tokens: maxTokens,
    thinking: { type: "adaptive" as const },
    system: kind === "container" ? CONTAINER_SYSTEM_PROMPT : SYSTEM_SCOPE_PROMPT,
    output_config: { format: { type: "json_schema" as const, schema: EXTRACTION_DOC_SCHEMA } },
    messages: [{
      role: "user" as const,
      content: kind === "container"
        ? `The softwareSystem anchor id your document must restate: ${systemId}\n\nEnrichment packet:\n${JSON.stringify(packet, null, 2)}`
        : `System packet:\n${JSON.stringify(packet, null, 2)}`,
    }],
  };
}

function usageFromAnthropic(message: Anthropic.Message): GatewayUsage | undefined {
  const promptTokens = message.usage?.input_tokens;
  const completionTokens = message.usage?.output_tokens;
  if (promptTokens === undefined && completionTokens === undefined) return undefined;
  const prompt = promptTokens ?? 0;
  const completion = completionTokens ?? 0;
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    totalTokens: prompt + completion,
  };
}

function anthropicGenerator(
  client: Anthropic,
  modelId: string,
  options: { timeoutMs: number; remainingTokens: () => number },
): EnrichmentGenerator {
  return async (packet, kind, systemId) => {
    const signal = AbortSignal.timeout(options.timeoutMs);
    const stream = client.messages.stream(
      enrichmentStreamParams(modelId, kind, systemId, packet, options.remainingTokens()),
      { signal },
    );
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") throw new Error("model refused the enrichment request");
    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map(block => block.text)
      .join("");
    const document = JSON.parse(text) as unknown;
    const usage = usageFromAnthropic(message);
    return usage ? { document, usage } : { document };
  };
}

/**
 * Builds the `enrichWithPackets` hook for GithubScanOptions.
 * Per-scope failures omit that scope. Rate-limit / 5xx skip remaining scopes
 * and throw so the job records enrichment failed; the deterministic atlas
 * stays live. Scan-level budget skips remaining without throwing.
 */
export function createEnricher(options: EnricherOptions = {}): (packets: EmittedPackets) => Promise<ReadonlyMap<string, unknown>> {
  const progress = options.onProgress ?? (() => {});
  const passModelId = resolveEnrichmentPassModelId(options);
  const usingInjectedGenerate = options.generate !== undefined;
  const budget = resolveBudget(options.budget);
  const spent = { tokens: 0, dollars: 0 };
  const remainingTokens = (): number => Math.max(1, budget.maxTokens - spent.tokens);
  const generate = options.generate ?? (passModelId
    ? anthropicGenerator(new Anthropic(), passModelId, {
      timeoutMs: budget.requestTimeoutMs,
      remainingTokens,
    })
    : async () => {
      throw new Error("empty model id");
    });
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 2);
  const gateway = options.gateway;

  return async ({ packets, systemPacket }) => {
    if (!passModelId && !usingInjectedGenerate) {
      throw new Error("empty model id");
    }
    if (passModelId && gateway) {
      progress(`enrich: llm gateway ${gateway.baseUrl} model ${passModelId}`);
    } else if (passModelId) {
      progress(`enrich: model ${passModelId}`);
    }
    progress(`enrich: budget ${budget.maxScopes} scopes / ${budget.maxTokens} tokens / $${budget.maxDollars} / timeout ${budget.requestTimeoutMs}ms`);
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
    let scopesAttempted = 0;
    let firstFailure: string | undefined;
    let abortRemaining: string | undefined;
    const skipRest = (reason: string): void => {
      const leftover = work.length - index;
      index = work.length;
      if (leftover > 0) {
        progress(`enrich: ${reason}; skipping ${leftover} remaining scope(s); stays deterministic`);
      }
    };
    const runNext = async (): Promise<void> => {
      while (index < work.length && abortRemaining === undefined) {
        if (scopesAttempted >= budget.maxScopes) {
          skipRest(`scan budget max scopes ${budget.maxScopes} reached`);
          break;
        }
        if (spent.tokens >= budget.maxTokens) {
          skipRest(`scan budget max tokens ${budget.maxTokens} reached (${spent.tokens})`);
          break;
        }
        if (spent.dollars >= budget.maxDollars) {
          skipRest(`scan budget max dollars $${budget.maxDollars} reached ($${spent.dollars})`);
          break;
        }
        const item = work[index]!;
        index += 1;
        scopesAttempted += 1;
        try {
          progress(`enrich ${item.id}: requesting proposal`);
          const proposal = await withDeadline(generate(item.packet, item.kind, systemId), budget.requestTimeoutMs);
          docs.set(item.id, proposal.document);
          const used = proposal.usage?.totalTokens ?? 0;
          if (used > 0) spent.tokens += used;
          if (proposal.usage?.costUsd !== undefined) {
            spent.dollars = addDollars(spent.dollars, proposal.usage.costUsd);
          }
          progress(`enrich ${item.id}: proposal received`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          firstFailure ??= message;
          if (shouldSkipRemainingScopes(error)) {
            abortRemaining = message;
            const leftover = work.length - index;
            index = work.length;
            progress(`enrich ${item.id}: ${message}; skipping ${leftover} remaining scope(s); stays deterministic`);
            break;
          }
          progress(`enrich ${item.id}: failed (${message}); stays deterministic`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(maxConcurrent, work.length) }, runNext));
    // Rate-limit / 5xx: do not keep spending. The job records enrichment failed;
    // the deterministic atlas is already live.
    if (abortRemaining !== undefined) {
      throw new Error(`enrichment failed (${abortRemaining}); remaining scopes skipped`);
    }
    // Partial success republishes what the gate accepts; TOTAL failure (typically
    // bad credentials) is surfaced as a throw so the job records an honest
    // "enrichment failed" instead of "complete, 0 containers".
    if (work.length > 0 && docs.size === 0 && firstFailure !== undefined) {
      throw new Error(`all ${work.length} enrichment scope(s) failed — first error: ${firstFailure}`);
    }
    return docs;
  };
}
