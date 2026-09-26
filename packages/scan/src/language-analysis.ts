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

/**
 * An analyzer-resolved reference whose declaration lives in a third-party package
 * (npm `node_modules/<pkg>` declaration file, or a SCIP `cargo <crate> <version>`
 * symbol outside the workspace). Never used for graph edges; feeds dependency facts.
 */
export interface AnalysisExternalReference extends AnalysisLocation {
  ecosystem: "npm" | "cargo";
  /** Package that declares the symbol (after `@types/*` mapping for npm). */
  package: string;
  /** Declaring package when it differs from `package` (e.g. `@types/react`). */
  via?: string;
  /** Version carried by the analyzer (Rust SCIP symbols). */
  version?: string;
  /** Display name, e.g. `React.useState` or `wgpu::Device::create_buffer`. */
  symbol: string;
  kind: "uses" | "calls";
  /** `typescript@<ver>` / `rust-analyzer@<ver>`. */
  analyzer: string;
}

export interface LanguageAnalysis {
  schemaVersion: 1;
  definitions: AnalysisDefinition[];
  references: Array<AnalysisLocation & { symbol: string; kind: "uses" | "calls" }>;
  modules: Array<AnalysisLocation & { targetPath: string }>;
  /** Optional: references into third-party packages (CLA-212). */
  externalReferences?: AnalysisExternalReference[];
  coverage: Array<{
    language: string;
    tool: string;
    version: string;
    coverage: "semantic" | "syntax" | "unavailable";
    indexedFiles: string[];
    limitations: string[];
  }>;
}
