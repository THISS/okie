import { closeSync, constants as fsConstants, createReadStream, fchmodSync, lstatSync, mkdirSync, openSync, symlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { SCAN_SIZE_LIMITS, ScanSizeLimitError } from "./source-tree.js";

/**
 * Hardened, dependency-free `.tar.gz` extractor for GitHub / `git archive` tarballs.
 *
 * The host `tar` is never used: this module parses every header itself (ustar, pax,
 * GNU longname/longlink) and writes only the entries it validated, so there is no
 * parser differential between "what we checked" and "what got written".
 *
 * Two passes over the (already size-capped) archive on disk:
 *   1. validate — the whole archive is parsed and every entry checked (paths, types,
 *      collisions, write-through-symlink, limits) with NOTHING written;
 *   2. extract  — the same state machine runs again and writes each entry. The caller
 *      extracts into a private temp dir that is discarded on any error.
 *
 * What `git archive` (and so codeload.github.com) emits, per git's archive-tar.c:
 * a pax global header (`g`, the commit id comment), pax extended headers (`x`, for
 * long `path` / `linkpath`), regular files (`0`), directories (`5`, also used for
 * submodule gitlinks, which become empty dirs), and symlinks (`2`). It never emits
 * hard links, devices, FIFOs or sparse files — git's tree model has no such objects.
 * Anything outside that set is therefore rejected rather than skipped: silently
 * dropping an entry would hide tampering or a non-git archive, and a hard link in
 * particular is a classic vector for aliasing files outside the extraction root.
 * GNU `L`/`K` long names are accepted for robustness (other writers use them).
 *
 * Symlinks are written verbatim (targets are not judged here); CLA-299's
 * `detachSymlinks` later removes escaping/dangling ones and keeps in-repo links.
 * No entry is ever written THROUGH a symlink: any path whose ancestor is a declared
 * symlink is rejected, and files are opened `O_CREAT|O_EXCL|O_NOFOLLOW`.
 */

/** Bounds on one extraction. Defaults admit the largest repos a scan accepts. */
export interface TarExtractLimits {
  /** File + directory + symlink entries (pax/GNU metadata headers are bounded separately). */
  maxEntries: number;
  /** Summed size of regular-file contents written to disk. */
  maxBytes: number;
  /** UTF-8 bytes of one entry path, including the top-level directory. */
  maxPathBytes: number;
  /** Summed bytes of pax / GNU longname metadata records across the archive. */
  maxMetadataBytes: number;
}

export const TAR_EXTRACT_LIMITS: Readonly<TarExtractLimits> = {
  /** SCAN_SIZE_LIMITS.maxFiles (250k) files plus headroom for their directories. */
  maxEntries: 500_000,
  /** Same 2 GiB budget as SCAN_SIZE_LIMITS.maxBytes, so a gzip bomb cannot fill the disk. */
  maxBytes: SCAN_SIZE_LIMITS.maxBytes,
  /** Linux PATH_MAX; each segment is additionally capped at NAME_MAX (255 bytes). */
  maxPathBytes: 4096,
  /** git archive writes a few dozen bytes per long path; 64 MiB is far beyond any real repo. */
  maxMetadataBytes: 64 * 1024 * 1024,
};

const MAX_SEGMENT_BYTES = 255;
/** One pax / GNU longname record; larger is never a real path. */
const MAX_METADATA_RECORD_BYTES = 64 * 1024;
/** Metadata headers allowed before one real entry (x + L + K, with slack). */
const MAX_PENDING_METADATA_HEADERS = 8;
/** pax global headers per archive (git archive writes exactly one). */
const MAX_GLOBAL_HEADERS = 16;
const BLOCK = 512;

export type TarRejectionReason =
  | "gzip"
  | "corrupt"
  | "truncated"
  | "absolute-path"
  | "parent-segment"
  | "invalid-path"
  | "path-too-long"
  | "hardlink"
  | "special-file"
  | "unsupported-type"
  | "outside-top-level"
  | "collision"
  | "through-symlink"
  | "empty";

/** The archive was refused as a whole; nothing from it may be used. */
export class TarExtractError extends Error {
  readonly reason: TarRejectionReason;
  readonly entryPath: string | undefined;
  constructor(reason: TarRejectionReason, message: string, entryPath?: string) {
    super(entryPath === undefined ? message : `${message}: ${JSON.stringify(entryPath)}`);
    this.name = "TarExtractError";
    this.reason = reason;
    this.entryPath = entryPath;
  }
}

export interface TarExtractResult {
  /** Absolute path of the archive's single top-level directory under `destDir`. */
  root: string;
  topLevel: string;
  files: number;
  directories: number;
  symlinks: number;
  bytes: number;
}

type EntryKind = "file" | "directory" | "symlink";

interface TarEntry {
  kind: EntryKind;
  /** Validated, `/`-separated, no trailing slash. */
  path: string;
  segments: string[];
  size: number;
  mode: number;
  linkTarget: string;
}

/** Pull reader over the gunzipped byte stream. */
class ByteReader {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private ended = false;
  constructor(private readonly source: AsyncIterator<Buffer>) {}

  private async fill(n: number): Promise<void> {
    while (this.buffered < n && !this.ended) {
      const next = await this.source.next();
      if (next.done) this.ended = true;
      else if (next.value.length > 0) {
        this.chunks.push(next.value);
        this.buffered += next.value.length;
      }
    }
  }

  /** Exactly `n` bytes, or undefined at a clean end of stream (0 bytes left). Throws on a short read. */
  async read(n: number): Promise<Buffer | undefined> {
    await this.fill(n);
    if (this.buffered === 0) return undefined;
    if (this.buffered < n) throw new TarExtractError("truncated", "Tarball is truncated");
    const out = Buffer.allocUnsafe(n);
    let offset = 0;
    while (offset < n) {
      const head = this.chunks[0]!;
      const take = Math.min(head.length, n - offset);
      head.copy(out, offset, 0, take);
      offset += take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    this.buffered -= n;
    return out;
  }

  /** Streams `n` bytes to `sink` (or discards them) without concatenating. */
  async consume(n: number, sink?: (chunk: Buffer) => void): Promise<void> {
    let left = n;
    while (left > 0) {
      if (this.buffered === 0) {
        await this.fill(1);
        if (this.buffered === 0) throw new TarExtractError("truncated", "Tarball is truncated");
      }
      const head = this.chunks[0]!;
      const take = Math.min(head.length, left);
      if (sink) sink(head.subarray(0, take));
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
      this.buffered -= take;
      left -= take;
    }
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function decodeName(bytes: Buffer, what: string): string {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new TarExtractError("invalid-path", `Tarball ${what} is not valid UTF-8`);
  }
}

/** NUL-terminated header string field. */
function field(header: Buffer, offset: number, length: number, what: string): string {
  const slice = header.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return decodeName(nul === -1 ? slice : slice.subarray(0, nul), what);
}

/** Octal (or GNU base-256) numeric field. */
function numeric(header: Buffer, offset: number, length: number): number {
  const slice = header.subarray(offset, offset + length);
  if ((slice[0]! & 0x80) !== 0) {
    if ((slice[0]! & 0x40) !== 0) throw new TarExtractError("corrupt", "Tarball header has a negative numeric field");
    let value = slice[0]! & 0x3f;
    for (let i = 1; i < slice.length; i++) {
      value = value * 256 + slice[i]!;
      if (!Number.isSafeInteger(value)) throw new TarExtractError("corrupt", "Tarball header numeric field overflows");
    }
    return value;
  }
  const text = slice.toString("latin1").replace(/[\0 ]+$/, "").replace(/^[ ]+/, "");
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarExtractError("corrupt", "Tarball header has a malformed numeric field");
  const value = parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new TarExtractError("corrupt", "Tarball header numeric field overflows");
  return value;
}

function verifyChecksum(header: Buffer): void {
  const stored = numeric(header, 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const byte = i >= 148 && i < 156 ? 0x20 : header[i]!;
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  if (stored !== unsigned && stored !== signed) throw new TarExtractError("corrupt", "Tarball header checksum mismatch (not a tar archive, or corrupt)");
}

/** Keys this extractor honours; every other record (mtime, uid, xattrs, …) is ignored. */
const PAX_KEYS = new Set(["path", "linkpath", "size"]);

/**
 * Parses pax `"<len> <key>=<value>\n"` records. Only {@link PAX_KEYS} values are
 * decoded (strict UTF-8); other values may be binary (e.g. `SCHILY.xattr.*`) and are
 * kept as presence-only markers.
 */
function parsePax(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new TarExtractError("corrupt", "Malformed pax extended header");
    const lengthText = data.toString("latin1", offset, space);
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw new TarExtractError("corrupt", "Malformed pax extended header");
    const length = parseInt(lengthText, 10);
    const end = offset + length;
    if (end > data.length || data[end - 1] !== 0x0a) throw new TarExtractError("corrupt", "Malformed pax extended header");
    const record = data.subarray(space + 1, end - 1);
    const eq = record.indexOf(0x3d);
    if (eq <= 0) throw new TarExtractError("corrupt", "Malformed pax extended header");
    const key = decodeName(record.subarray(0, eq), "pax key");
    records.set(key, PAX_KEYS.has(key) ? decodeName(record.subarray(eq + 1), `pax ${key}`) : "");
    offset = end;
  }
  return records;
}

/** GNU longname / longlink payload: NUL-terminated. */
function gnuLongString(data: Buffer, what: string): string {
  const nul = data.indexOf(0);
  return decodeName(nul === -1 ? data : data.subarray(0, nul), what);
}

/** Case-fold + Unicode (NFC) key under which two paths name the same entry on APFS / NTFS. */
function foldKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

/** Validates one entry path; returns its segments. Rejects absolute, `..`, `.`, empty, NUL, backslash. */
function validatePath(raw: string, isDirectory: boolean, limits: TarExtractLimits): string[] {
  if (raw.includes("\0")) throw new TarExtractError("invalid-path", "Tarball entry name contains NUL", raw.replaceAll("\0", "\\0"));
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw new TarExtractError("absolute-path", "Tarball entry has an absolute path", raw);
  if (raw.includes("\\")) throw new TarExtractError("invalid-path", "Tarball entry name contains a backslash", raw);
  if (Buffer.byteLength(raw, "utf8") > limits.maxPathBytes) {
    throw new TarExtractError("path-too-long", `Tarball entry path exceeds ${limits.maxPathBytes} bytes`, `${raw.slice(0, 80)}…`);
  }
  const trimmed = isDirectory && raw.endsWith("/") ? raw.slice(0, -1) : raw;
  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (segment === "..") throw new TarExtractError("parent-segment", "Tarball entry path contains '..'", raw);
    if (segment === "" || segment === ".") throw new TarExtractError("invalid-path", "Tarball entry path has an empty or '.' segment", raw);
    if (Buffer.byteLength(segment, "utf8") > MAX_SEGMENT_BYTES) {
      throw new TarExtractError("path-too-long", `Tarball entry path segment exceeds ${MAX_SEGMENT_BYTES} bytes`, raw);
    }
  }
  return segments;
}

/**
 * Cross-entry checks: single top-level dir, case/Unicode collisions, duplicates and
 * write-through-symlink. Deterministic, so both passes reach identical verdicts.
 */
class TreeValidator {
  topLevel: string | undefined;
  /** fold key → exact path + kind. Directories include implicit ancestors. */
  private readonly seen = new Map<string, { path: string; kind: EntryKind }>();

  check(entry: TarEntry): void {
    const top = entry.segments[0]!;
    if (this.topLevel === undefined) this.topLevel = top;
    else if (top !== this.topLevel) {
      throw new TarExtractError("outside-top-level", `Tarball entry is not under the single top-level directory ${JSON.stringify(this.topLevel)}`, entry.path);
    }
    if (entry.segments.length === 1 && entry.kind !== "directory") {
      throw new TarExtractError("outside-top-level", "Tarball top-level entry is not a directory", entry.path);
    }
    // Ancestors must be (implicit) directories with the exact same spelling.
    for (let i = 1; i < entry.segments.length; i++) {
      const ancestor = entry.segments.slice(0, i).join("/");
      const prior = this.seen.get(foldKey(ancestor));
      if (!prior) {
        this.seen.set(foldKey(ancestor), { path: ancestor, kind: "directory" });
        continue;
      }
      if (prior.kind === "symlink") throw new TarExtractError("through-symlink", `Tarball entry would be written through the symlink ${JSON.stringify(prior.path)}`, entry.path);
      if (prior.kind === "file") throw new TarExtractError("collision", `Tarball entry uses the file ${JSON.stringify(prior.path)} as a directory`, entry.path);
      if (prior.path !== ancestor) throw new TarExtractError("collision", `Tarball entry collides (case / Unicode normalization) with ${JSON.stringify(prior.path)}`, entry.path);
    }
    const key = foldKey(entry.path);
    const prior = this.seen.get(key);
    if (prior) {
      // A directory may be restated (e.g. declared after its children); nothing else may repeat.
      if (entry.kind === "directory" && prior.kind === "directory" && prior.path === entry.path) return;
      const how = prior.path === entry.path ? "duplicates" : "collides (case / Unicode normalization) with";
      throw new TarExtractError("collision", `Tarball entry ${how} ${JSON.stringify(prior.path)}`, entry.path);
    }
    this.seen.set(key, { path: entry.path, kind: entry.kind });
  }
}

/** Receives each validated entry; for a file it may return a writer for its content. */
type EntrySink = (entry: TarEntry) => { write: (chunk: Buffer) => void; finish: () => void } | undefined;

type WalkResult = Omit<TarExtractResult, "root">;

async function walkArchive(tgzPath: string, limits: TarExtractLimits, onEntry: EntrySink): Promise<WalkResult> {
  const input = createReadStream(tgzPath);
  const gunzip = createGunzip();
  input.on("error", error => gunzip.destroy(error));
  input.pipe(gunzip);
  const iterator = gunzip[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const reader = new ByteReader(iterator);
  const validator = new TreeValidator();
  const totals = { files: 0, directories: 0, symlinks: 0, bytes: 0 };
  let entries = 0;
  let metadataBytes = 0;
  let globals = 0;
  let pendingMeta = 0;
  let pax = new Map<string, string>();
  let longName: string | undefined;
  let longLink: string | undefined;

  const readMetadata = async (size: number): Promise<Buffer> => {
    if (size > MAX_METADATA_RECORD_BYTES) throw new TarExtractError("corrupt", `Tarball metadata record is ${size} bytes (over ${MAX_METADATA_RECORD_BYTES})`);
    metadataBytes += size;
    if (metadataBytes > limits.maxMetadataBytes) throw new ScanSizeLimitError("bytes", limits.maxMetadataBytes, metadataBytes);
    if (++pendingMeta > MAX_PENDING_METADATA_HEADERS) throw new TarExtractError("corrupt", "Tarball has too many consecutive metadata headers");
    const data = size === 0 ? Buffer.alloc(0) : await reader.read(size);
    if (!data) throw new TarExtractError("truncated", "Tarball is truncated");
    await reader.consume(padding(size));
    return data;
  };

  try {
    for (;;) {
      let header: Buffer | undefined;
      try {
        header = await reader.read(BLOCK);
      } catch (error) {
        throw asGzipError(error);
      }
      if (!header) break; // stream ended without the zero-block trailer: tolerated only after a complete entry
      if (header.every(byte => byte === 0)) break; // end-of-archive; anything after is never read
      verifyChecksum(header);
      const magic = header.toString("latin1", 257, 263);
      const isUstar = magic === "ustar\0";
      const isGnu = magic === "ustar ";
      if (!isUstar && !isGnu) throw new TarExtractError("corrupt", "Tarball entry is not a ustar/pax/GNU header");
      const typeflag = String.fromCharCode(header[156]!);
      const headerSize = numeric(header, 124, 12);

      if (typeflag === "g") {
        if (++globals > MAX_GLOBAL_HEADERS) throw new TarExtractError("corrupt", "Tarball has too many pax global headers");
        const records = parsePax(await readMetadata(headerSize));
        pendingMeta--; // a global header does not attach to the next entry
        for (const key of ["path", "linkpath", "size"]) {
          if (records.has(key)) throw new TarExtractError("unsupported-type", `Tarball pax global header sets '${key}', which is unsupported`);
        }
        continue;
      }
      if (typeflag === "x") {
        for (const [key, value] of parsePax(await readMetadata(headerSize))) {
          if (key.startsWith("GNU.sparse.")) throw new TarExtractError("unsupported-type", "Tarball contains a sparse file (pax GNU.sparse)");
          if (PAX_KEYS.has(key)) pax.set(key, value);
        }
        continue;
      }
      if (typeflag === "L") {
        longName = gnuLongString(await readMetadata(headerSize), "GNU long name");
        continue;
      }
      if (typeflag === "K") {
        longLink = gnuLongString(await readMetadata(headerSize), "GNU long link");
        continue;
      }

      let name = field(header, 0, 100, "entry name");
      if (isUstar) {
        const prefix = field(header, 345, 155, "entry name prefix");
        if (prefix !== "") name = `${prefix}/${name}`;
      }
      const rawPath = pax.get("path") ?? longName ?? name;
      const linkTarget = pax.get("linkpath") ?? longLink ?? field(header, 157, 100, "link name");
      const paxSize = pax.get("size");
      if (paxSize !== undefined && !/^[0-9]+$/.test(paxSize)) throw new TarExtractError("corrupt", "Tarball pax size is malformed", rawPath);
      const size = paxSize === undefined ? headerSize : Number(paxSize);
      if (!Number.isSafeInteger(size)) throw new TarExtractError("corrupt", "Tarball entry size overflows", rawPath);
      pax = new Map();
      longName = undefined;
      longLink = undefined;
      pendingMeta = 0;

      let kind: EntryKind;
      switch (typeflag) {
        case "0":
        case "\0":
          kind = "file";
          break;
        case "5":
          kind = "directory";
          break;
        case "2":
          kind = "symlink";
          break;
        case "1":
          throw new TarExtractError("hardlink", "Tarball contains a hard link (git archive never emits one)", rawPath);
        case "3":
        case "4":
        case "6":
          throw new TarExtractError("special-file", "Tarball contains a device or FIFO entry", rawPath);
        default:
          throw new TarExtractError("unsupported-type", `Tarball entry has unsupported type '${typeflag === "\0" ? "\\0" : typeflag}'`, rawPath);
      }
      // A legacy writer marks directories as '0' + trailing slash; git archive does not.
      if (kind === "file" && rawPath.endsWith("/")) throw new TarExtractError("invalid-path", "Tarball file entry has a trailing slash", rawPath);
      const segments = validatePath(rawPath, kind === "directory", limits);
      const path = segments.join("/");
      if (kind !== "file" && size !== 0) throw new TarExtractError("corrupt", "Tarball directory/symlink entry carries data", path);
      if (kind === "symlink") {
        if (linkTarget === "") throw new TarExtractError("invalid-path", "Tarball symlink has an empty target", path);
        if (linkTarget.includes("\0")) throw new TarExtractError("invalid-path", "Tarball symlink target contains NUL", path);
      }
      if (++entries > limits.maxEntries) throw new ScanSizeLimitError("files", limits.maxEntries, entries);
      if (kind === "file" && totals.bytes + size > limits.maxBytes) throw new ScanSizeLimitError("bytes", limits.maxBytes, totals.bytes + size);
      const entry: TarEntry = { kind, path, segments, size, mode: numeric(header, 100, 8), linkTarget };
      validator.check(entry);

      if (kind === "file") {
        totals.files++;
        totals.bytes += size;
      } else if (kind === "directory") totals.directories++;
      else totals.symlinks++;
      const writer = onEntry(entry);
      try {
        await reader.consume(size, writer?.write);
      } finally {
        writer?.finish();
      }
      await reader.consume(padding(size));
    }
    if (pendingMeta > 0) throw new TarExtractError("truncated", "Tarball ends after a metadata header");
    if (validator.topLevel === undefined) throw new TarExtractError("empty", "Tarball contains no entries");
    return { topLevel: validator.topLevel, ...totals };
  } catch (error) {
    throw asGzipError(error);
  } finally {
    input.destroy();
    gunzip.destroy();
  }
}

function padding(size: number): number {
  return (BLOCK - (size % BLOCK)) % BLOCK;
}

function asGzipError(error: unknown): unknown {
  if (error instanceof TarExtractError || error instanceof ScanSizeLimitError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.startsWith("Z_")) return new TarExtractError("gzip", `Tarball is not a valid gzip archive (${code})`);
  return error;
}

const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const CREATE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW;

/** 0o755 when any exec bit is set, else 0o644. Never setuid/setgid/sticky; never chown. */
export function safeFileMode(mode: number): number {
  return (mode & 0o111) !== 0 ? 0o755 : 0o644;
}

/**
 * Validates the whole archive, then extracts it into `destDir` (which must be a fresh,
 * private, empty directory the caller discards on error). Throws {@link TarExtractError}
 * for a refused archive and {@link ScanSizeLimitError} for an over-limit one; in both
 * cases the validation pass throws before anything is written.
 */
export async function extractTarball(tgzPath: string, destDir: string, overrides: Partial<TarExtractLimits> = {}): Promise<TarExtractResult> {
  const limits: TarExtractLimits = { ...TAR_EXTRACT_LIMITS, ...overrides };
  await walkArchive(tgzPath, limits, () => undefined);

  const createdDirs = new Set<string>([""]);
  const ensureDir = (segments: string[]): void => {
    let rel = "";
    for (const segment of segments) {
      rel = rel === "" ? segment : `${rel}/${segment}`;
      if (createdDirs.has(rel)) continue;
      const full = join(destDir, rel);
      try {
        mkdirSync(full, { mode: 0o755 });
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") throw error;
      }
      // Never descend into anything but a real directory we can see (not a symlink).
      if (!lstatSync(full).isDirectory()) throw new TarExtractError("through-symlink", "Refusing to extract through a non-directory", rel);
      createdDirs.add(rel);
    }
  };

  const result = await walkArchive(tgzPath, limits, entry => {
    if (entry.kind === "directory") {
      ensureDir(entry.segments);
      return undefined;
    }
    ensureDir(entry.segments.slice(0, -1));
    const full = join(destDir, entry.path);
    if (entry.kind === "symlink") {
      symlinkSync(entry.linkTarget, full);
      return undefined;
    }
    const fd = openSync(full, CREATE_FLAGS, 0o600);
    let closed = false;
    return {
      write: chunk => {
        let offset = 0;
        while (offset < chunk.length) offset += writeSync(fd, chunk, offset, chunk.length - offset);
      },
      finish: () => {
        if (closed) return;
        closed = true;
        try {
          fchmodSync(fd, safeFileMode(entry.mode));
        } finally {
          closeSync(fd);
        }
      },
    };
  });
  return { ...result, root: join(destDir, result.topLevel) };
}
