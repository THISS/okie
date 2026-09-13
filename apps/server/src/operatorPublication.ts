import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OperatorArtifactRevision, OperatorPublication, PublishDraftOptions, PublishResult } from "./operatorContracts.js";
import { canonicalOperatorRepositoryId, type CreateDraftInput, OperatorStore } from "./operatorStore.js";

interface Pointer { versionId: string; artifactRevisionId: string; updatedAt: number; }
export interface PublishedArtifactRef { kind: "publication" | "legacy"; versionId?: string; artifactRevisionId?: string; legacyDirectory?: string; }
export interface OperatorPublicationOptions { rename?: typeof renameSync; }

/** The store lock covers pointer CAS and the durable freeze record as one retryable transaction. */
export class OperatorPublicationService {
  private readonly pointerRoot: string;
  private readonly rename: typeof renameSync;
  constructor(private readonly store: OperatorStore, private readonly legacyScanRoot?: string, options: OperatorPublicationOptions = {}) { this.pointerRoot = join(store.root, "current"); mkdirSync(this.pointerRoot, { recursive: true }); this.rename = options.rename ?? renameSync; }
  /** Fixed-width names keep valid GitHub owner/repository names below NAME_MAX. */
  private path(repositoryId: string): string { return join(this.pointerRoot, `${createHash("sha256").update(canonicalOperatorRepositoryId(repositoryId)).digest("hex")}.json`); }
  private legacyPath(repositoryId: string): string | undefined {
    const name = `${Buffer.from(repositoryId).toString("hex")}.json`;
    return Buffer.byteLength(name) <= 255 ? join(this.pointerRoot, name) : undefined;
  }
  private pointerAt(path: string | undefined): Pointer | undefined { return path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Pointer : undefined; }
  /**
   * Read fixed-width pointers first, then old hex pointers. Existing records may
   * have been written under a differently cased GitHub name, so choose the most
   * recent still-pointed publication until the next publish installs the new key.
   */
  private pointer(repositoryId: string): Pointer | undefined {
    const canonical = canonicalOperatorRepositoryId(repositoryId);
    // A digest pointer is the post-migration authority. Legacy hex filenames,
    // including the canonical spelling, must be compared by publication age.
    const direct = this.pointerAt(this.path(canonical));
    if (direct) return direct;
    const state = this.store.snapshot();
    const candidates = state.publications
      .filter(value => canonicalOperatorRepositoryId(value.repositoryId) === canonical)
      // State is append-only; reverse first so equal-clock publications prefer
      // the later durable row after the stable newest-first sort.
      .reverse()
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const publication of candidates) {
      const pointer = this.pointerAt(this.legacyPath(publication.repositoryId));
      if (pointer?.versionId === publication.versionId && pointer.artifactRevisionId === publication.artifactRevisionId) return pointer;
    }
    return undefined;
  }
  /** Draft bases come from the actual current pointer, never historical publication rows. */
  createDraftRevision(input: Omit<CreateDraftInput, "basePublicationVersionId">) {
    return this.store.withExclusiveLock(() => {
      const run = this.store.snapshot().runs.find(value => value.runId === input.runId);
      if (!run) throw new Error("unknown draft run");
      const current = this.pointer(run.source.repositoryId);
      return this.store.createDraftRevision({ ...input, ...(current ? { basePublicationVersionId: current.versionId } : {}) });
    });
  }
  publishDraft(options: PublishDraftOptions): PublishResult { return this.store.withExclusiveLock(() => { const repositoryId = canonicalOperatorRepositoryId(options.repositoryId); const current = this.pointer(repositoryId); const result = this.store.freezeForPublication({ ...options, repositoryId }, current?.versionId); if (!result.ok) return result; const target = this.path(repositoryId); const temp = `${target}.${process.pid}.${result.publication.versionId}.tmp`; writeFileSync(temp, `${JSON.stringify({ versionId: result.publication.versionId, artifactRevisionId: result.publication.artifactRevisionId, updatedAt: result.publication.createdAt })}\n`, { mode: 0o600 }); this.rename(temp, target); return result; }); }
  currentPublication(repositoryId: string): OperatorPublication | undefined { const canonical = canonicalOperatorRepositoryId(repositoryId); const pointer = this.pointer(canonical); return pointer ? this.store.snapshot().publications.find(value => canonicalOperatorRepositoryId(value.repositoryId) === canonical && value.versionId === pointer.versionId && value.artifactRevisionId === pointer.artifactRevisionId) : undefined; }
  resolveCurrent(repositoryId: string, legacySlug?: string): PublishedArtifactRef | undefined { const current = this.currentPublication(repositoryId); if (current) return { kind: "publication", versionId: current.versionId, artifactRevisionId: current.artifactRevisionId }; if (this.legacyScanRoot && legacySlug && /^[A-Za-z0-9][A-Za-z0-9_-]{0,180}$/.test(legacySlug) && existsSync(join(this.legacyScanRoot, legacySlug))) return { kind: "legacy", legacyDirectory: join(this.legacyScanRoot, legacySlug) }; return undefined; }
  artifactForVersion(repositoryId: string, versionId: string): OperatorArtifactRevision | undefined { const canonical = canonicalOperatorRepositoryId(repositoryId); const state = this.store.snapshot(); const publication = state.publications.find(value => canonicalOperatorRepositoryId(value.repositoryId) === canonical && value.versionId === versionId); return publication ? state.artifacts.find(value => value.artifactRevisionId === publication.artifactRevisionId) : undefined; }
  /** Resolve a public scan slug without depending on insertion order of durable runs. */
  repositoryIdForSlug(slug: string): string | undefined {
    const candidates = this.store.snapshot().runs
      .filter(run => run.source.slug === slug)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    for (const run of candidates) {
      const repositoryId = canonicalOperatorRepositoryId(run.source.repositoryId);
      if (this.currentPublication(repositoryId)) return repositoryId;
    }
    return undefined;
  }
}
