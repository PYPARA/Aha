export interface WorkspaceMigrationItem {
  projectId: string;
  kind: string;
  source: string;
  target: string | null;
  status: "pending" | "copying" | "verified" | "complete" | "blocked";
  files: Record<string, { hash: string; bytes: number; mode: number }>;
  error?: string | undefined;
  conflicts: string[];
  updatedAt: string;
}
export interface WorkspaceMigrationStatus {
  version: 1;
  running: boolean;
  directories: {
    root: string;
    resource: string;
    chats: string;
    studio: string;
    groups: string;
    legacyRoot: string;
  };
  items: WorkspaceMigrationItem[];
  backupPath: string | null;
  error: string | null;
}
export interface WorkspacePathMapping {
  projectId: string;
  source: string;
  target: string;
}
