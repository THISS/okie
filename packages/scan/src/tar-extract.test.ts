import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { acquireGithubTree, GithubAcquisitionError, TarballRejectedError, type GithubClient } from "./github.js";
import { ScanSizeLimitError } from "./source-tree.js";
import { extractTarball, safeFileMode, TarExtractError, type TarExtractLimits, type TarRejectionReason } from "./tar-extract.js";

// ---------------------------------------------------------------------------
// A tiny tar writer so every archive shape is crafted byte-for-byte in-test.
// ---------------------------------------------------------------------------

interface RawEntry {
  name: string;
  /** Raw name bytes (overrides `name`), for non-UTF-8 names. */
  rawName?: Buffer;
  type?: string;
  body?: Buffer | string;
  mode?: number;
  linkname?: string;
  prefix?: string;
  /** Declared size when it must differ from the body (e.g. a bomb header). */
  size?: number;
  gnuMagic?: boolean;
  badChecksum?: boolean;
}

function octal(header: Buffer, offset: number, length: number, value: number): void {
  header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "latin1");
}

function tarHeader(entry: RawEntry, size: number): Buffer {
  const header = Buffer.alloc(512);
  (entry.rawName ?? Buffer.from(entry.name, "utf8")).copy(header, 0, 0, 100);
  octal(header, 100, 8, entry.mode ?? 0o644);
  octal(header, 108, 8, 0);
  octal(header, 116, 8, 0);
  octal(header, 124, 12, size);
  octal(header, 136, 12, 0);
  header.write(entry.type ?? "0", 156, 1, "latin1");
  if (entry.linkname) Buffer.from(entry.linkname, "utf8").copy(header, 157, 0, 100);
  if (entry.gnuMagic) header.write("ustar  \0", 257, 8, "latin1");
  else header.write("ustar\u000000", 257, 8, "latin1");
  if (entry.prefix) Buffer.from(entry.prefix, "utf8").copy(header, 345, 0, 155);
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  if (entry.badChecksum) sum += 1;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return header;
}

function tarBytes(entries: RawEntry[], trailer = true): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const body = typeof entry.body === "string" ? Buffer.from(entry.body, "utf8") : entry.body ?? Buffer.alloc(0);
    blocks.push(tarHeader(entry, entry.size ?? body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  if (trailer) blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function paxBody(records: Record<string, string | Buffer>): Buffer {
  const parts: Buffer[] = [];
  for (const [key, raw] of Object.entries(records)) {
    const value = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
    const rest = 1 + Buffer.byteLength(key) + 1 + value.length + 1; // " key=value\n"
    let length = rest + 1;
    while (String(length).length + rest !== length) length = String(length).length + rest;
    parts.push(Buffer.from(`${length} ${key}=`, "utf8"), value, Buffer.from("\n"));
  }
  return Buffer.concat(parts);
}

const dir = (name: string): RawEntry => ({ name: `${name}/`, type: "5", mode: 0o755 });
const file = (name: string, body: string | Buffer = "x", mode = 0o644): RawEntry => ({ name, body, mode });
const link = (name: string, target: string): RawEntry => ({ name, type: "2", linkname: target, mode: 0o777 });
const pax = (records: Record<string, string | Buffer>): RawEntry => ({ name: "PaxHeader", type: "x", body: paxBody(records) });
const globalPax = (records: Record<string, string>): RawEntry => ({ name: "pax_global_header", type: "g", body: paxBody(records) });
const gnuLong = (type: "L" | "K", value: string): RawEntry => ({ name: "././@LongLink", type, body: `${value}\0`, gnuMagic: true });

function withScratch<T>(fn: (scratch: string) => Promise<T>): Promise<T> {
  const scratch = mkdtempSync(join(tmpdir(), "okie-tar-extract-"));
  return fn(scratch).finally(() => rmSync(scratch, { recursive: true, force: true }));
}

async function extractBytes(scratch: string, tar: Buffer, limits: Partial<TarExtractLimits> = {}, gzip = true) {
  mkdirSync(scratch, { recursive: true });
  const tgz = join(scratch, "archive.tar.gz");
  writeFileSync(tgz, gzip ? gzipSync(tar) : tar);
  const dest = join(scratch, "out");
  mkdirSync(dest);
  return { dest, result: await extractTarball(tgz, dest, limits) };
}

/** Every file / symlink under `root` (dirs only when empty), `/`-separated and sorted. */
function listTree(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      const inner = listTree(root, path);
      out.push(...(inner.length === 0 ? [path] : inner));
    }
    else out.push(path);
  }
  return out.sort();
}

const BENIGN_PREFIX: RawEntry[] = [globalPax({ comment: "0123456789abcdef0123456789abcdef01234567" }), dir("top"), file("top/ok.txt", "fine")];

// ---------------------------------------------------------------------------

test("benign archive: pax global + extended headers, long paths, GNU long names, in-repo symlink, safe modes", async () => {
  await withScratch(async scratch => {
    const deepDir = `top/${"d".repeat(60)}/${"e".repeat(60)}`;
    const paxPath = `${deepDir}/pax-named-${"p".repeat(40)}.ts`;
    const prefixName = `${"f".repeat(90)}.ts`;
    const gnuPath = `${deepDir}/gnu-named-${"g".repeat(40)}.ts`;
    const longTarget = `${"e".repeat(60)}/pax-named-${"p".repeat(40)}.ts`;
    assert.ok(paxPath.length > 100 && gnuPath.length > 100 && `${deepDir}/${prefixName}`.length > 100);
    const tar = tarBytes([
      globalPax({ comment: "0123456789abcdef0123456789abcdef01234567" }),
      dir("top"),
      dir("top/src"),
      file("top/src/index.ts", "export const x = 1;\n"),
      file("top/run.sh", "#!/bin/sh\n", 0o775),
      file("top/setuid", "s", 0o6755),
      file("top/sticky", "s", 0o1644),
      pax({ path: paxPath, mtime: "1700000000.5", "SCHILY.xattr.com.apple.provenance": Buffer.from([0xff, 0x00, 0x01]) }),
      file("placeholder-name", "pax body"),
      { ...file(prefixName, "prefix body"), prefix: deepDir },
      gnuLong("L", gnuPath),
      file("././@LongLink-shadow", "gnu body"),
      link("top/src/alias.ts", "index.ts"),
      pax({ linkpath: longTarget }),
      link(`top/${"d".repeat(60)}/long-link.ts`, "ignored"),
      gnuLong("K", "../src/index.ts"),
      link("top/src/gnu-link", "ignored"),
      dir("top/empty"),
    ]);
    const { dest, result } = await extractBytes(scratch, tar);
    assert.equal(result.root, join(dest, "top"));
    assert.equal(result.topLevel, "top");
    assert.deepEqual({ files: result.files, directories: result.directories, symlinks: result.symlinks }, { files: 7, directories: 3, symlinks: 3 });
    assert.equal(readFileSync(join(dest, paxPath), "utf8"), "pax body");
    assert.equal(readFileSync(join(dest, deepDir, prefixName), "utf8"), "prefix body");
    assert.equal(readFileSync(join(dest, gnuPath), "utf8"), "gnu body");
    assert.equal(readlinkSync(join(dest, "top/src/alias.ts")), "index.ts");
    assert.equal(readlinkSync(join(dest, `top/${"d".repeat(60)}/long-link.ts`)), longTarget);
    assert.equal(readFileSync(join(dest, `top/${"d".repeat(60)}/long-link.ts`), "utf8"), "pax body", "in-repo long link resolves");
    assert.equal(readlinkSync(join(dest, "top/src/gnu-link")), "../src/index.ts");
    assert.equal(statSync(join(dest, "top/run.sh")).mode & 0o7777, 0o755, "exec bit -> 0755");
    assert.equal(statSync(join(dest, "top/src/index.ts")).mode & 0o7777, 0o644);
    assert.equal(statSync(join(dest, "top/setuid")).mode & 0o7777, 0o755, "setuid/setgid stripped");
    assert.equal(statSync(join(dest, "top/sticky")).mode & 0o7777, 0o644, "sticky stripped");
    assert.ok(statSync(join(dest, "top/empty")).isDirectory());
    assert.deepEqual(listTree(dest).filter(path => !path.includes("d".repeat(60))), ["top/empty", "top/run.sh", "top/setuid", "top/src/alias.ts", "top/src/gnu-link", "top/src/index.ts", "top/sticky"]);
  });
});

test("safeFileMode keeps only 0644 / 0755", () => {
  assert.equal(safeFileMode(0o644), 0o644);
  assert.equal(safeFileMode(0o600), 0o644);
  assert.equal(safeFileMode(0o100), 0o755);
  assert.equal(safeFileMode(0o7777), 0o755);
  assert.equal(safeFileMode(0o4000), 0o644);
});

const REJECTIONS: Array<{ label: string; entries: RawEntry[]; reason: TarRejectionReason; gzip?: boolean; trailer?: boolean; noPrefix?: boolean }> = [
  { label: "absolute path", entries: [file("/etc/passwd")], reason: "absolute-path" },
  { label: "absolute path via pax", entries: [pax({ path: "/tmp/evil" }), file("top/innocent")], reason: "absolute-path" },
  { label: "drive letter", entries: [file("C:/evil")], reason: "absolute-path" },
  { label: "backslash", entries: [file("top\\..\\evil")], reason: "invalid-path" },
  { label: "'..' segment", entries: [file("top/../evil")], reason: "parent-segment" },
  { label: "nested '..' via GNU longname", entries: [gnuLong("L", "top/a/../../evil"), file("x")], reason: "parent-segment" },
  { label: "'..' in ustar prefix", entries: [{ ...file("evil"), prefix: "top/.." }], reason: "parent-segment" },
  { label: "'.' segment", entries: [file("top/./x")], reason: "invalid-path" },
  { label: "empty segment", entries: [file("top//x")], reason: "invalid-path" },
  { label: "NUL in a pax path", entries: [pax({ path: "top/a\0/../../evil" }), file("top/x")], reason: "invalid-path" },
  { label: "NUL in a pax linkpath", entries: [pax({ linkpath: "a\0b" }), link("top/l", "x")], reason: "invalid-path" },
  { label: "invalid UTF-8 name", entries: [{ ...file("top/x"), rawName: Buffer.from([0x74, 0x6f, 0x70, 0x2f, 0xff]) }], reason: "invalid-path" },
  { label: "hard link", entries: [{ name: "top/hard", type: "1", linkname: "top/ok.txt" }], reason: "hardlink" },
  { label: "char device", entries: [{ name: "top/tty", type: "3" }], reason: "special-file" },
  { label: "block device", entries: [{ name: "top/disk", type: "4" }], reason: "special-file" },
  { label: "fifo", entries: [{ name: "top/pipe", type: "6" }], reason: "special-file" },
  { label: "contiguous file '7'", entries: [{ name: "top/c", type: "7", body: "c" }], reason: "unsupported-type" },
  { label: "GNU sparse 'S'", entries: [{ name: "top/s", type: "S", gnuMagic: true }], reason: "unsupported-type" },
  { label: "pax sparse", entries: [pax({ "GNU.sparse.major": "1" }), file("top/s")], reason: "unsupported-type" },
  { label: "unknown typeflag", entries: [{ name: "top/q", type: "Q" }], reason: "unsupported-type" },
  { label: "pax global sets path", entries: [globalPax({ path: "evil" })], reason: "unsupported-type" },
  { label: "second top-level dir", entries: [file("other/x")], reason: "outside-top-level" },
  { label: "top-level file", entries: [file("top"), file("top/x")], reason: "outside-top-level", noPrefix: true },
  { label: "top-level symlink", entries: [link("top", "/")], reason: "outside-top-level", noPrefix: true },
  { label: "case collision", entries: [file("top/README.md"), file("top/readme.md")], reason: "collision" },
  { label: "NFC/NFD collision", entries: [file("top/caf\u00e9.ts"), file("top/cafe\u0301.ts")], reason: "collision" },
  { label: "case collision between dir and file", entries: [file("top/Dir/x"), file("top/dir")], reason: "collision" },
  { label: "case collision between ancestor spellings", entries: [file("top/Dir/x"), file("top/dir/y")], reason: "collision" },
  { label: "file used as a directory", entries: [file("top/f"), file("top/f/g")], reason: "collision" },
  { label: "duplicate file", entries: [file("top/ok.txt", "again")], reason: "collision" },
  { label: "symlink replacing a file", entries: [link("top/ok.txt", "/etc/passwd")], reason: "collision" },
  { label: "write through in-repo symlink", entries: [dir("top/real"), link("top/alias", "real"), file("top/alias/x")], reason: "through-symlink" },
  { label: "write through escaping symlink", entries: [link("top/esc", "/tmp"), file("top/esc/evil")], reason: "through-symlink" },
  { label: "write through escaping symlink, deep", entries: [link("top/esc", "../../.."), file("top/esc/a/b/evil")], reason: "through-symlink" },
  { label: "dir entry through symlink", entries: [link("top/esc", "/tmp"), dir("top/esc/sub")], reason: "through-symlink" },
  { label: "write through case-variant of a symlink", entries: [link("top/esc", "/tmp"), file("top/ESC/evil")], reason: "through-symlink" },
  { label: "path segment over 255 bytes", entries: [pax({ path: `top/${"n".repeat(256)}` }), file("top/x")], reason: "path-too-long" },
  { label: "path over the byte limit", entries: [pax({ path: `top/${"a/".repeat(2100)}x` }), file("top/x")], reason: "path-too-long" },
  { label: "symlink with empty target", entries: [link("top/l", "")], reason: "invalid-path" },
  { label: "bad checksum", entries: [{ ...file("top/x"), badChecksum: true }], reason: "corrupt" },
  { label: "malformed pax record", entries: [{ name: "PaxHeader", type: "x", body: "99 path=top/x\n" }, file("top/y")], reason: "corrupt" },
  { label: "dangling metadata header", entries: [pax({ path: "top/x" })], reason: "truncated" },
  { label: "truncated body", entries: [{ ...file("top/big", "short"), size: 4096 }], reason: "truncated", trailer: false },
  { label: "not gzip", entries: [file("top/x")], reason: "gzip", gzip: false },
];

for (const { label, entries, reason, gzip, trailer, noPrefix } of REJECTIONS) {
  test(`rejects the whole archive and writes nothing: ${label}`, async () => {
    await withScratch(async scratch => {
      // Benign entries precede the bad one: the validation pass must refuse before any write.
      const tar = tarBytes([...(noPrefix ? [] : BENIGN_PREFIX), ...entries], trailer ?? true);
      const tgz = join(scratch, "archive.tar.gz");
      writeFileSync(tgz, gzip === false ? tar : gzipSync(tar));
      const dest = join(scratch, "out");
      mkdirSync(dest);
      await assert.rejects(extractTarball(tgz, dest), (error: unknown) => {
        assert.ok(error instanceof TarExtractError, `${label}: ${String(error)}`);
        assert.equal(error.reason, reason, `${label}: ${error.message}`);
        return true;
      });
      assert.deepEqual(readdirSync(dest), [], `${label}: nothing written`);
    });
  });
}

test("rejects an empty archive", async () => {
  await withScratch(async scratch => {
    await assert.rejects(extractBytes(scratch, tarBytes([globalPax({ comment: "c" })])), (error: unknown) => error instanceof TarExtractError && error.reason === "empty");
  });
});

test("gzip bomb: a tiny archive declaring more bytes than the budget is refused before any write", async () => {
  await withScratch(async scratch => {
    const tar = tarBytes([...BENIGN_PREFIX, file("top/bomb", Buffer.alloc(8 * 1024 * 1024))]);
    const tgz = join(scratch, "bomb.tar.gz");
    writeFileSync(tgz, gzipSync(tar, { level: 9 }));
    assert.ok(statSync(tgz).size < 64 * 1024, "compresses to a few KB");
    const dest = join(scratch, "out");
    mkdirSync(dest);
    await assert.rejects(extractTarball(tgz, dest, { maxBytes: 1024 * 1024 }), (error: unknown) =>
      error instanceof ScanSizeLimitError && error.kind === "bytes" && error.limit === 1024 * 1024 && error.actual === 8 * 1024 * 1024 + 4);
    assert.deepEqual(readdirSync(dest), []);
    // A header that merely claims a huge size (no body) is refused on the header, under the default budget.
    const liar = tarBytes([...BENIGN_PREFIX, { ...file("top/liar", ""), size: 7 * 1024 * 1024 * 1024 }], false);
    await assert.rejects(extractBytes(join(scratch, "liar"), liar), (error: unknown) => error instanceof ScanSizeLimitError && error.kind === "bytes" && error.limit === 2 * 1024 * 1024 * 1024);
  });
});

test("size limits: entry count, summed bytes and metadata are bounded and configurable", async () => {
  await withScratch(async scratch => {
    const many = tarBytes([dir("top"), ...Array.from({ length: 20 }, (_, i) => file(`top/f${i}`, "12345"))]);
    await assert.rejects(extractBytes(join(scratch, "a"), many, { maxEntries: 10 }), (error: unknown) => error instanceof ScanSizeLimitError && error.kind === "files" && error.limit === 10 && error.actual === 11);
    await assert.rejects(extractBytes(join(scratch, "b"), many, { maxBytes: 99 }), (error: unknown) => error instanceof ScanSizeLimitError && error.kind === "bytes" && error.actual === 100);
    const ok = await extractBytes(join(scratch, "c"), many, { maxEntries: 21, maxBytes: 100 });
    assert.equal(ok.result.files, 20);
    assert.equal(ok.result.bytes, 100);
    const meta = tarBytes([dir("top"), pax({ comment: "c".repeat(2000) }), file("top/x")]);
    await assert.rejects(extractBytes(join(scratch, "d"), meta, { maxMetadataBytes: 1000 }), (error: unknown) => error instanceof ScanSizeLimitError);
    await assert.rejects(extractBytes(join(scratch, "e"), tarBytes([dir("top"), file(`top/${"x".repeat(50)}`)]), { maxPathBytes: 40 }), (error: unknown) => error instanceof TarExtractError && error.reason === "path-too-long");
  });
});

test("never writes through a pre-existing symlink in the destination (O_NOFOLLOW / lstat defence in depth)", async () => {
  await withScratch(async scratch => {
    const outside = join(scratch, "outside");
    mkdirSync(outside);
    const tgz = join(scratch, "a.tar.gz");
    writeFileSync(tgz, gzipSync(tarBytes([dir("top"), file("top/sub/x", "evil"), file("top/y", "evil")])));
    // Someone planted links in the destination: the extractor must not follow them.
    const dest = join(scratch, "out");
    mkdirSync(join(dest, "top"), { recursive: true });
    symlinkSync(outside, join(dest, "top/sub"));
    await assert.rejects(extractTarball(tgz, dest), (error: unknown) => error instanceof TarExtractError && error.reason === "through-symlink");
    const dest2 = join(scratch, "out2");
    mkdirSync(join(dest2, "top"), { recursive: true });
    symlinkSync(join(outside, "y"), join(dest2, "top/y"));
    await assert.rejects(extractTarball(tgz, dest2), (error: unknown) => (error as { code?: string }).code === "EEXIST" || (error as { code?: string }).code === "ELOOP");
    assert.deepEqual(readdirSync(outside), [], "nothing escaped");
  });
});

// ---------------------------------------------------------------------------
// Real `git archive` output.
// ---------------------------------------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

/** `git ls-tree -r` of HEAD split into regular/exec files, symlinks and gitlinks. */
function lsTree(repo: string): { files: string[]; symlinks: string[]; gitlinks: string[] } {
  const out = execFileSync("git", ["ls-tree", "-r", "-z", "HEAD"], { cwd: repo, env: GIT_ENV, maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
  const result = { files: [] as string[], symlinks: [] as string[], gitlinks: [] as string[] };
  for (const record of out.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const mode = record.slice(0, 6);
    const path = record.slice(tab + 1);
    if (mode === "120000") result.symlinks.push(path);
    else if (mode === "160000") result.gitlinks.push(path);
    else result.files.push(path);
  }
  return result;
}

async function extractGitArchive(repo: string, scratch: string) {
  mkdirSync(scratch, { recursive: true });
  const tgz = join(scratch, "head.tar.gz");
  execFileSync("git", ["archive", "--format=tar.gz", "--prefix=x/", "-o", tgz, "HEAD"], { cwd: repo, env: GIT_ENV });
  const dest = join(scratch, "out");
  mkdirSync(dest);
  return { dest, result: await extractTarball(tgz, dest) };
}

test("a real `git archive` of this repository extracts exactly `git ls-tree -r HEAD`", async () => {
  const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { env: GIT_ENV }).toString("utf8").trim();
  await withScratch(async scratch => {
    const { dest, result } = await extractGitArchive(repo, scratch);
    const tree = lsTree(repo);
    const root = join(dest, "x");
    const extracted = listTree(root);
    // Submodules become empty directories in git archive; listTree only reports them when empty.
    assert.deepEqual(extracted, [...tree.files, ...tree.symlinks, ...tree.gitlinks].sort());
    const names = execFileSync("git", ["ls-tree", "-r", "--name-only", "-z", "HEAD"], { cwd: repo, env: GIT_ENV, maxBuffer: 64 * 1024 * 1024 }).toString("utf8").split("\0").filter(Boolean);
    assert.deepEqual(extracted, [...names].sort(), "same list as git ls-tree -r --name-only (gitlinks appear as empty dirs)");
    for (const path of tree.symlinks) assert.ok(lstatSync(join(root, path)).isSymbolicLink(), `${path} is a symlink`);
    assert.equal(result.files, tree.files.length);
    assert.equal(result.symlinks, tree.symlinks.length);
    assert.equal(readFileSync(join(root, "package.json"), "utf8"), execFileSync("git", ["show", "HEAD:package.json"], { cwd: repo, env: GIT_ENV }).toString("utf8"));
  });
});

test("a real `git archive` with symlinks, exec bits, a submodule, unicode and >100-char paths round-trips", async () => {
  await withScratch(async scratch => {
    const repo = join(scratch, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: GIT_ENV });
    git("init", "-q");
    writeFileSync(join(repo, "src/index.ts"), "export const x = 1;\n");
    writeFileSync(join(repo, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    const longDir = `${"l".repeat(70)}/${"m".repeat(70)}`;
    mkdirSync(join(repo, longDir), { recursive: true });
    writeFileSync(join(repo, longDir, `${"n".repeat(80)}.ts`), "long\n");
    writeFileSync(join(repo, "caf\u00e9 file.md"), "unicode\n");
    symlinkSync("index.ts", join(repo, "src/alias.ts"));
    symlinkSync(`../${longDir}/${"n".repeat(80)}.ts`, join(repo, "src/long-link.ts"));
    symlinkSync("/etc/hosts", join(repo, "escape"));
    git("add", "-A");
    git("update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},vendor/sub`);
    git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture");
    const { dest, result } = await extractGitArchive(repo, join(scratch, "x"));
    const root = join(dest, "x");
    const tree = lsTree(repo);
    assert.deepEqual(tree.gitlinks, ["vendor/sub"]);
    assert.deepEqual(listTree(root), [...tree.files, ...tree.symlinks, ...tree.gitlinks].sort());
    assert.ok(statSync(join(root, "vendor/sub")).isDirectory(), "submodule is an empty dir");
    assert.deepEqual(readdirSync(join(root, "vendor/sub")), []);
    assert.equal(statSync(join(root, "run.sh")).mode & 0o777, 0o755);
    assert.equal(statSync(join(root, "src/index.ts")).mode & 0o777, 0o644);
    assert.equal(readlinkSync(join(root, "src/long-link.ts")), `../${longDir}/${"n".repeat(80)}.ts`);
    assert.equal(readFileSync(join(root, "src/long-link.ts"), "utf8"), "long\n");
    assert.equal(readlinkSync(join(root, "escape")), "/etc/hosts", "escaping links are left for detachSymlinks");
    assert.equal(result.symlinks, 3);

    // Through acquireGithubTree: escaping link detached, in-repo links kept (CLA-299 behaviour).
    const tgz = join(scratch, "x", "head.tar.gz");
    const client: GithubClient = {
      async getJson() { throw new Error("unused"); },
      async downloadTarball(_o, _r, _s, destFile) {
        writeFileSync(destFile, readFileSync(tgz));
        return statSync(destFile).size;
      },
    };
    const acquired = await acquireGithubTree({ owner: "acme", repo: "repo", dirSlug: "acme__repo" }, "abc", client);
    try {
      assert.deepEqual(acquired.skipped, { symlinksInternal: 0, symlinksEscaping: 1, symlinksUnresolved: 0, submodules: 0 });
      assert.ok(lstatSync(join(acquired.root, "src/alias.ts")).isSymbolicLink());
      assert.throws(() => lstatSync(join(acquired.root, "escape")), /ENOENT/);
    } finally {
      acquired.cleanup();
    }
  });
});

test("acquireGithubTree maps a refused archive to TarballRejectedError and over-limit to ScanSizeLimitError", async () => {
  const clientFor = (bytes: Buffer): GithubClient => ({
    async getJson() { throw new Error("unused"); },
    async downloadTarball(_o, _r, _s, destFile) {
      writeFileSync(destFile, bytes);
      return bytes.length;
    },
  });
  const src = { owner: "acme", repo: "evil", dirSlug: "acme__evil" };
  await assert.rejects(acquireGithubTree(src, "abc", clientFor(gzipSync(tarBytes([...BENIGN_PREFIX, file("top/../../evil")])))), (error: unknown) =>
    error instanceof TarballRejectedError && error instanceof GithubAcquisitionError && error.reason === "parent-segment" && /Refused the GitHub tarball/.test(error.message));
  await assert.rejects(acquireGithubTree(src, "abc", clientFor(gzipSync(tarBytes([...BENIGN_PREFIX, file("top/big", "0123456789")]))), undefined, { maxBytes: 5 }), (error: unknown) =>
    error instanceof ScanSizeLimitError && error.kind === "bytes");
  await assert.rejects(acquireGithubTree(src, "abc", clientFor(Buffer.from("not gzip at all"))), (error: unknown) => error instanceof TarballRejectedError && error.reason === "gzip");
});
