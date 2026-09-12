import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import Parser from "tree-sitter";
import Rust from "tree-sitter-rust";
import { PositionEncoding, SymbolRole, type Occurrence } from "@scip-code/scip";
import type { AnalysisDefinition, AnalysisLocation, LanguageAnalysis } from "./language-analysis.js";
import { decodeScipIndex } from "./scip.js";

type Point = { row: number; column: number };
type OccurrenceRange = { start: Point; end: Point };

let parser: Parser | undefined;

const OUTLINE_ITEMS = new Set([
  "function_item", "struct_item", "enum_item", "trait_item", "mod_item", "type_item",
  "const_item", "static_item", "union_item", "macro_definition",
]);

function rustParser(): Parser {
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(Rust as Parser.Language);
  }
  return parser;
}

function canonical<T>(items: Iterable<T>): T[] {
  return [...items].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function occurrenceRange(occurrence: Occurrence): OccurrenceRange | undefined {
  if (occurrence.typedRange.case === "singleLineRange") {
    const value = occurrence.typedRange.value;
    return { start: { row: value.line, column: value.startCharacter }, end: { row: value.line, column: value.endCharacter } };
  }
  if (occurrence.typedRange.case === "multiLineRange") {
    const value = occurrence.typedRange.value;
    return { start: { row: value.startLine, column: value.startCharacter }, end: { row: value.endLine, column: value.endCharacter } };
  }
  if (occurrence.range.length === 3) return { start: { row: occurrence.range[0]!, column: occurrence.range[1]! }, end: { row: occurrence.range[0]!, column: occurrence.range[2]! } };
  if (occurrence.range.length === 4) return { start: { row: occurrence.range[0]!, column: occurrence.range[1]! }, end: { row: occurrence.range[2]!, column: occurrence.range[3]! } };
  return undefined;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === "\n") starts.push(index + 1);
  return starts;
}

/** Convert rust-analyzer's UTF-8 byte column to a JS string offset. */
function offsetAt(text: string, starts: readonly number[], point: Point, encoding: PositionEncoding): number | undefined {
  const lineStart = starts[point.row];
  if (lineStart === undefined) return undefined;
  const lineEnd = text.indexOf("\n", lineStart);
  const limit = lineEnd < 0 ? text.length : lineEnd;
  if (encoding !== PositionEncoding.UTF8CodeUnitOffsetFromLineStart) return Math.min(lineStart + point.column, limit);
  let offset = lineStart;
  let bytes = 0;
  while (offset < limit && bytes < point.column) {
    const character = String.fromCodePoint(text.codePointAt(offset)!);
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > point.column) return undefined;
    bytes += width;
    offset += character.length;
  }
  return bytes === point.column ? offset : undefined;
}

function location(path: string, text: string, starts: readonly number[], range: OccurrenceRange, encoding: PositionEncoding): AnalysisLocation | undefined {
  const startOffset = offsetAt(text, starts, range.start, encoding);
  const endOffset = offsetAt(text, starts, range.end, encoding);
  if (startOffset === undefined || endOffset === undefined) return undefined;
  return { path, startLine: range.start.row + 1, endLine: range.end.row + 1, startOffset, endOffset };
}

function callAt(tree: Parser.Tree, point: Point): boolean {
  let node = tree.rootNode.descendantForPosition(point);
  for (; node.parent; node = node.parent) {
    const parent = node.parent;
    if (parent.type === "call_expression") {
      const callee = parent.childForFieldName("function");
      return !!callee && node.startIndex >= callee.startIndex && node.endIndex <= callee.endIndex;
    }
    if (parent.type === "method_call_expression") {
      const method = parent.childForFieldName("method");
      return !!method && node.startIndex >= method.startIndex && node.endIndex <= method.endIndex;
    }
  }
  return false;
}

function importAt(tree: Parser.Tree, point: Point): boolean {
  let node = tree.rootNode.descendantForPosition(point);
  for (; node.parent; node = node.parent) if (node.parent.type === "use_declaration") return true;
  return false;
}

/** Match the same declaration surface that the Rust outline extractor publishes. */
function outlinedDefinitionAt(tree: Parser.Tree, range: OccurrenceRange): Parser.SyntaxNode | undefined {
  let node = tree.rootNode.descendantForPosition(range.start);
  for (; node.parent; node = node.parent) {
    const item = node.parent;
    if (!OUTLINE_ITEMS.has(item.type)) continue;
    const name = item.childForFieldName("name");
    if (!name || range.start.row < name.startPosition.row || range.end.row > name.endPosition.row) continue;
    if (item.type === "function_item") {
      const list = item.parent;
      if (list?.type === "declaration_list" && list.parent?.type === "impl_item") return name;
      if (item.parent?.type === "source_file") return name;
      continue;
    }
    if (item.parent?.type === "source_file") return name;
  }
  return undefined;
}

function moduleTarget(path: string, text: string, allowed: ReadonlySet<string>): LanguageAnalysis["modules"] {
  const tree = rustParser().parse(text);
  const modules: LanguageAnalysis["modules"] = [];
  const normalize = (candidate: string): string => candidate.split(sep).join("/");
  const rootDirectory = (): string => {
    const directory = dirname(path);
    const file = basename(path);
    return ["lib.rs", "main.rs", "mod.rs"].includes(file) ? directory : join(directory, file.slice(0, -extname(file).length));
  };
  const pathAttribute = (node: Parser.SyntaxNode): string | undefined => {
    const attribute = node.previousNamedSibling;
    if (attribute?.type !== "attribute_item") return undefined;
    return /#\s*\[\s*path\s*=\s*"([^"\\]+)"\s*\]/.exec(attribute.text)?.[1];
  };
  const visit = (node: Parser.SyntaxNode, moduleDirectory: string): void => {
    if (node.type === "mod_item") {
      const name = node.childForFieldName("name");
      // Inline modules are containment, not a file dependency.
      const body = node.childForFieldName("body");
      if (name && !body) {
        const stem = name.text;
        const explicit = pathAttribute(node);
        const candidates = explicit
          ? [normalize(join(moduleDirectory, explicit))]
          : [normalize(join(moduleDirectory, `${stem}.rs`)), normalize(join(moduleDirectory, stem, "mod.rs"))];
        const targetPath = candidates.find(candidate => allowed.has(candidate));
        if (targetPath) modules.push({ path, startLine: name.startPosition.row + 1, endLine: name.endPosition.row + 1, startOffset: name.startIndex, endOffset: name.endIndex, targetPath });
      } else if (name && body) {
        for (const child of body.namedChildren) visit(child, join(moduleDirectory, name.text));
      }
      return;
    }
    for (const child of node.namedChildren) visit(child, moduleDirectory);
  };
  visit(tree.rootNode, rootDirectory());
  return modules;
}

/**
 * Invoke rust-analyzer's SCIP exporter and retain only resolved, in-repository facts.
 * Import/file links are emitted separately; calls are established from the parsed call AST.
 */
export function analyzeRust(sourceRoot: string, discoveredFiles?: readonly string[]): LanguageAnalysis {
  const root = resolve(sourceRoot);
  const allFiles = discoveredFiles ?? [];
  const allowed = new Set(allFiles.filter(path => path.endsWith(".rs")).map(path => path.split(sep).join("/")));
  const result: LanguageAnalysis = { schemaVersion: 1, definitions: [], references: [], modules: [], coverage: [] };
  if (!allowed.size) return result;
  const temporary = mkdtempSync(join(tmpdir(), "okie-rust-scip-"));
  const indexPath = join(temporary, "index.scip");
  const run = spawnSync("rust-analyzer", ["scip", root, "--output", indexPath, "--exclude-vendored-libraries"], { encoding: "utf8", timeout: 120_000 });
  const limitations = new Set<string>();
  try {
    if (run.error || run.status !== 0 || !existsSync(indexPath)) {
      limitations.add(run.error?.message ?? (run.stderr.trim() || "rust-analyzer SCIP indexing failed."));
      result.coverage.push({ language: "rust", tool: "rust-analyzer", version: "unavailable", coverage: "unavailable", indexedFiles: [], limitations: canonical(limitations) });
      return result;
    }
    const index = decodeScipIndex(readFileSync(indexPath));
    const files = new Map<string, { text: string; starts: number[]; tree: Parser.Tree }>();
    for (const path of allowed) {
      const absolute = join(root, path);
      if (!existsSync(absolute)) continue;
      const text = readFileSync(absolute, "utf8");
      files.set(path, { text, starts: lineStarts(text), tree: rustParser().parse(text) });
      for (const module of moduleTarget(path, text, allowed)) result.modules.push(module);
    }
    const names = new Map<string, string>();
    for (const document of index.documents) for (const symbol of document.symbols) if (symbol.displayName) names.set(symbol.symbol, symbol.displayName);
    const definitions = new Map<string, AnalysisDefinition>();
    const pending: Array<{ path: string; occurrence: Occurrence; range: OccurrenceRange; location: AnalysisLocation; tree: Parser.Tree }> = [];
    for (const document of index.documents) {
      const path = document.relativePath.split(sep).join("/");
      const file = files.get(path);
      if (!file) continue;
      for (const occurrence of document.occurrences) {
        if (!occurrence.symbol) continue;
        const range = occurrenceRange(occurrence);
        if (!range) continue;
        const observed = location(path, file.text, file.starts, range, document.positionEncoding);
        if (!observed) continue;
        if (occurrence.symbolRoles & SymbolRole.Definition) {
          const name = outlinedDefinitionAt(file.tree, range);
          // Do not turn local variables and parameters into graph targets: they have
          // no matching published L4 outline entity and would create false edges.
          if (!name) continue;
          definitions.set(occurrence.symbol, {
            ...observed,
            symbol: occurrence.symbol,
            name: names.get(occurrence.symbol) || file.text.slice(name.startIndex, name.endIndex),
          });
        } else pending.push({ path, occurrence, range, location: observed, tree: file.tree });
      }
    }
    result.definitions = canonical(definitions.values());
    const references = new Map<string, LanguageAnalysis["references"][number]>();
    const modules = new Map(result.modules.map(item => [`${item.path}:${item.startOffset}:${item.targetPath}`, item]));
    for (const pendingReference of pending) {
      // A reference without a definition in this committed source has no target edge.
      if (!definitions.has(pendingReference.occurrence.symbol)) continue;
      if ((pendingReference.occurrence.symbolRoles & SymbolRole.Import) || importAt(pendingReference.tree, pendingReference.range.start)) {
        const target = definitions.get(pendingReference.occurrence.symbol)!;
        modules.set(`${pendingReference.path}:${pendingReference.location.startOffset}:${target.path}`, { ...pendingReference.location, targetPath: target.path });
        continue;
      }
      const kind = callAt(pendingReference.tree, pendingReference.range.start) ? "calls" : "uses";
      const reference = { ...pendingReference.location, symbol: pendingReference.occurrence.symbol, kind } as LanguageAnalysis["references"][number];
      references.set(`${reference.path}:${reference.startOffset}:${reference.symbol}:${kind}`, reference);
    }
    result.references = canonical(references.values());
    result.modules = canonical(modules.values());
    const indexedFiles = [...new Set(index.documents.map(document => document.relativePath.split(sep).join("/")))].filter(path => files.has(path)).sort();
    const omitted = [...files.keys()].filter(path => !indexedFiles.includes(path)).sort();
    const tool = index.metadata?.toolInfo;
    if (run.stderr.includes("duplicate scip symbols")) limitations.add("rust-analyzer reported duplicate SCIP symbols; ambiguous definitions are retained only where a local definition occurrence exists.");
    if (omitted.length) limitations.add(`Not indexed by rust-analyzer SCIP: ${omitted.join(", ")}`);
    result.coverage.push({ language: "rust", tool: tool?.name || "rust-analyzer", version: tool?.version || "unknown", coverage: indexedFiles.length ? "semantic" : "unavailable", indexedFiles, limitations: canonical(limitations) });
    return result;
  } catch (error) {
    limitations.add(error instanceof Error ? error.message : String(error));
    result.coverage.push({ language: "rust", tool: "rust-analyzer", version: "unknown", coverage: "unavailable", indexedFiles: [], limitations: canonical(limitations) });
    return result;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
