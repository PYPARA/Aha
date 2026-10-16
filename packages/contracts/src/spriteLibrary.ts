import type { SpriteProjectData } from "./spriteLibrarySchema";
export type { SpriteProjectData } from "./spriteLibrarySchema";

export const SPRITE_LIBRARY_CHANNEL = "aha:sprites:request";
export interface SpriteProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  actionCount: number;
  deleting: boolean;
  error?: string | undefined;
}
export interface SpriteLibrarySnapshot {
  root: string | null;
  projects: SpriteProjectSummary[];
}
export interface SpriteLibraryImage {
  file: string;
  bytes: Uint8Array;
}
export type SpriteLibraryCommand =
  | { op: "list" | "reveal" }
  | { op: "get"; id: string }
  | { op: "readImage"; id: string; file: string }
  | {
      op: "save";
      project: SpriteProjectData;
      images: SpriteLibraryImage[];
      thumbnail: Uint8Array | null;
    }
  | { op: "rename"; id: string; name: string }
  | { op: "beginDelete" | "finishDelete"; id: string };
export interface SpriteLibraryBridge {
  request<T = unknown>(command: SpriteLibraryCommand): Promise<T>;
}
