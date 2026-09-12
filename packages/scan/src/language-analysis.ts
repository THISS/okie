/** Adapter-neutral observed symbols. Paths are repository-relative; lines are 1-based. */
export interface AnalysisLocation {
  path: string;
  startLine: number;
  endLine: number;
  /** Source offsets, when available, distinguish declarations sharing a line. */
  startOffset?: number;
  endOffset?: number;
}

export interface AnalysisDefinition extends AnalysisLocation {
  symbol: string;
  name: string;
}

export interface LanguageAnalysis {
  schemaVersion: 1;
  definitions: AnalysisDefinition[];
  references: Array<AnalysisLocation & { symbol: string; kind: "uses" | "calls" }>;
  modules: Array<AnalysisLocation & { targetPath: string }>;
  coverage: Array<{
    language: string;
    tool: string;
    version: string;
    coverage: "semantic" | "syntax" | "unavailable";
    indexedFiles: string[];
    limitations: string[];
  }>;
}
