import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OperatorArtifactRevision, OperatorPublication, PublishDraftOptions, PublishResult } from "./operatorContracts.js";
import { OperatorStore } from "./operatorStore.js";

interface PublicationPointer { versionId: string; artifactRevisionId: string; updatedAt: number; }
export interface PublishedArtifactRef { kind: "publication" | "legacy"; versionId?: string; artifactRevisionId?: string; legacyDirectory?: string; }

/** Atomic current pointers with a legacy layout seam for existing /scan slots. */
export class OperatorPublicationService {
  private readonly pointerRoot: string;
  constructor(private readonly store: OperatorStore, private readonly legacyScanRoot?: string) {
    this.pointerRoot = join(store.root, "current");
    mkdirSync(this.pointerRoot, { recursive: true });
  }
  private pointerPath(repositoryId: string): string { return join(this.pointerRoot, `${Buffer.from(repositoryId, "utf8").toString("hex")}.json`); }
  private pointer(repositoryId: string): PublicationPointer | undefined { const path = this.pointerPath(repositoryId); return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as PublicationPointer : undefined; }
  private withPublishLock<T>(work: () => T): T {
    const lock = join(this.pointerRoot, ".publish.lock");
    let fd: number | undefined;
    try { fd = openSync(lock, "wx", 0o600); return work(); }
    finally { if (fd !== undefined) { closeSync(fd); rmSync(lock, { force: true }); } }
  }
  publishDraft(options: PublishDraftOptions): PublishResult {
    return this.withPublishLock(() => { const current = this.pointer(options.repositoryId); const result = this.store.freezeForPublication(options, current?.versionId); if (!result.ok) return result;
      const target = this.pointerPath(options.repositoryId); const temporary = `${target}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ versionId: result.publication.versionId, artifactRevisionId: result.publication.artifactRevisionId, updatedAt: result.publication.createdAt })}\n`, { mode: 0o600 }); renameSync(temporary, target); return result; });
  }
  currentPublication(repositoryId: string): OperatorPublication | undefined {
    const pointer = this.pointer(repositoryId); if (!pointer) return undefined;
    return this.store.snapshot().publications.find(value => value.versionId === pointer.versionId && value.artifactRevisionId === pointer.artifactRevisionId);
  }
  resolveCurrent(repositoryId: string, legacySlug?: string): PublishedArtifactRef | undefined {
    const current = this.currentPublication(repositoryId);
    if (current) return { kind: "publication", versionId: current.versionId, artifactRevisionId: current.artifactRevisionId };
    if (this.legacyScanRoot && legacySlug && /^[A-Za-z0-9][A-Za-z0-9_-]{0,180}$/.test(legacySlug) && existsSync(join(this.legacyScanRoot, legacySlug))) return { kind: "legacy", legacyDirectory: join(this.legacyScanRoot, legacySlug) };
    return undefined;
  }
  artifactForVersion(repositoryId: string, versionId: string): OperatorArtifactRevision | undefined {
    const state = this.store.snapshot(); const publication = state.publications.find(value => value.repositoryId === repositoryId && value.versionId === versionId);
    return publication ? state.artifacts.find(value => value.artifactRevisionId === publication.artifactRevisionId) : undefined;
  }
}
