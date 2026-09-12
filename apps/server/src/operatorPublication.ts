import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OperatorArtifactRevision, OperatorPublication, PublishDraftOptions, PublishResult } from "./operatorContracts.js";
import { type CreateDraftInput, OperatorStore } from "./operatorStore.js";

interface Pointer { versionId: string; artifactRevisionId: string; updatedAt: number; }
export interface PublishedArtifactRef { kind: "publication" | "legacy"; versionId?: string; artifactRevisionId?: string; legacyDirectory?: string; }
export interface OperatorPublicationOptions { rename?: typeof renameSync; }

/** The store lock covers pointer CAS and the durable freeze record as one retryable transaction. */
export class OperatorPublicationService {
  private readonly pointerRoot: string;
  private readonly rename: typeof renameSync;
  constructor(private readonly store: OperatorStore, private readonly legacyScanRoot?: string, options: OperatorPublicationOptions = {}) { this.pointerRoot = join(store.root, "current"); mkdirSync(this.pointerRoot, { recursive: true }); this.rename = options.rename ?? renameSync; }
  private path(repositoryId: string): string { return join(this.pointerRoot, `${Buffer.from(repositoryId).toString("hex")}.json`); }
  private pointer(repositoryId: string): Pointer | undefined { const path = this.path(repositoryId); return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Pointer : undefined; }
  /** Draft bases come from the actual current pointer, never historical publication rows. */
  createDraftRevision(input: Omit<CreateDraftInput, "basePublicationVersionId">) {
    return this.store.withExclusiveLock(() => {
      const run = this.store.snapshot().runs.find(value => value.runId === input.runId);
      if (!run) throw new Error("unknown draft run");
      const current = this.pointer(run.source.repositoryId);
      return this.store.createDraftRevision({ ...input, ...(current ? { basePublicationVersionId: current.versionId } : {}) });
    });
  }
  publishDraft(options: PublishDraftOptions): PublishResult { return this.store.withExclusiveLock(() => { const current = this.pointer(options.repositoryId); const result = this.store.freezeForPublication(options, current?.versionId); if (!result.ok) return result; const target = this.path(options.repositoryId); const temp = `${target}.${process.pid}.${result.publication.versionId}.tmp`; writeFileSync(temp, `${JSON.stringify({ versionId: result.publication.versionId, artifactRevisionId: result.publication.artifactRevisionId, updatedAt: result.publication.createdAt })}\n`, { mode: 0o600 }); this.rename(temp, target); return result; }); }
  currentPublication(repositoryId: string): OperatorPublication | undefined { const pointer = this.pointer(repositoryId); return pointer ? this.store.snapshot().publications.find(value => value.versionId === pointer.versionId && value.artifactRevisionId === pointer.artifactRevisionId) : undefined; }
  resolveCurrent(repositoryId: string, legacySlug?: string): PublishedArtifactRef | undefined { const current = this.currentPublication(repositoryId); if (current) return { kind: "publication", versionId: current.versionId, artifactRevisionId: current.artifactRevisionId }; if (this.legacyScanRoot && legacySlug && /^[A-Za-z0-9][A-Za-z0-9_-]{0,180}$/.test(legacySlug) && existsSync(join(this.legacyScanRoot, legacySlug))) return { kind: "legacy", legacyDirectory: join(this.legacyScanRoot, legacySlug) }; return undefined; }
  artifactForVersion(repositoryId: string, versionId: string): OperatorArtifactRevision | undefined { const state = this.store.snapshot(); const publication = state.publications.find(value => value.repositoryId === repositoryId && value.versionId === versionId); return publication ? state.artifacts.find(value => value.artifactRevisionId === publication.artifactRevisionId) : undefined; }
}
