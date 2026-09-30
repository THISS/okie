export declare const ENVIRONMENTS: readonly string[];
export declare const EXPORT_COLUMNS: readonly string[];
export declare const USAGE: string;
export declare function parseUsersArgs(argv: string[]):
  | { command: 'export'; env: string; optedIn: boolean }
  | { command: 'delete'; env: string; githubId: number }
  | { command: 'delete'; env: string; email: string }
  | { error: string };
export declare function sqlString(value: string): string;
export declare function exportSql(optedIn: boolean): string;
export declare function deleteSql(target: { githubId: number } | { email: string }): string;
export declare function wranglerRows(stdout: string): Array<Record<string, unknown>>;
export declare function deleteOutputUnreadableMessage(stdout: string): string;
export declare function csvField(value: unknown): string;
export declare function toCsv(rows: Array<Record<string, unknown>>, columns?: readonly string[]): string;
