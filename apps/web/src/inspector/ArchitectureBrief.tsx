// Explicit .tsx consumers retain the old entry point. Extensionless imports use
// ArchitectureBriefView to avoid colliding with architectureBrief.ts on macOS.
export { ArchitectureBriefView } from './ArchitectureBriefView';
export type { ArchitectureBriefViewProps } from './ArchitectureBriefView';
