import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  WorkspaceMigrationStatus,
  WorkspacePathMapping,
} from "@synara/contracts/workspaceMigration";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";
import { setWorkspaceMigrationMappings } from "~/lib/workspaceMigrationPaths";
import { useResourceLibrary, resourceApi, resourceKey } from "../resources/resourceLibrary";
import { SettingsSection } from "./SettingsPanelPrimitives";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
export const storageMigrationKey = ["storage-migration"] as const;
async function readStatus(): Promise<
  WorkspaceMigrationStatus & { mappings: WorkspacePathMapping[] }
> {
  const response = await fetch(resolveWsHttpUrl("/api/storage/migration"), {
    credentials: "include",
  });
  if (!response.ok) throw new Error("Storage migration is initializing. Retry shortly.");
  return response.json();
}
export function useStorageMigration() {
  const query = useQuery({
    queryKey: storageMigrationKey,
    queryFn: readStatus,
    refetchInterval: (q) => (q.state.data?.running || q.state.error ? 1000 : 30000),
  });
  useEffect(() => {
    if (query.data) setWorkspaceMigrationMappings(query.data.mappings);
  }, [query.data]);
  return query;
}
/** Load aliases before historical links are used; cached globally for both settings and chats. */
export function StorageMigrationSync() {
  useStorageMigration();
  return null;
}
export function StorageSettingsPanel() {
  const tr = useAhaTranslation(),
    client = useQueryClient();
  const migration = useStorageMigration();
  const library = useResourceLibrary();
  const data = migration.data;
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await client.invalidateQueries({ queryKey: storageMigrationKey });
      await client.invalidateQueries({ queryKey: resourceKey });
    } catch (e) {
      toastManager.add({
        type: "error",
        title: tr("Storage operation failed"),
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };
  return (
    <SettingsSection title={tr("Storage locations and migration")}>
      <div className="space-y-4 p-4 text-sm">
        <p className="text-muted-foreground">
          {tr(
            "Workspaces are copied to Aha. Original Synara files are kept; app data and drawing history stay in place.",
          )}
        </p>
        {data ? (
          <div className="space-y-3">
            {(
              [
                ["Resource center", library.data?.root ?? data.directories.resource],
                ["Chats", data.directories.chats],
                ["Studio", data.directories.studio],
                ["Groups", data.directories.groups],
              ] as const
            ).map(([label, directory]) => (
              <div className="flex items-center justify-between gap-3" key={label}>
                <div className="min-w-0">
                  <p className="font-medium">{tr(label)}</p>
                  <p className="break-all text-xs text-muted-foreground">{directory}</p>
                </div>
                {window.desktopBridge ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void act(() => window.desktopBridge!.showInFolder(directory))}
                  >
                    {tr("Show in folder")}
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p role="status">{tr("Storage migration is initializing. Retry shortly.")}</p>
        )}
        {window.desktopBridge?.resourceLibrary ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void act(() => resourceApi({ op: "chooseRoot" }))}
          >
            {tr("Switch library")}
          </Button>
        ) : null}
        {library.data?.error ? (
          <p role="alert" className="text-destructive">
            {library.data.error}
          </p>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <p role="status">
            {tr(data?.running ? "Migrating workspaces…" : "Workspace migration")}
            {data
              ? ` · ${data.items.filter((i) => i.status === "complete").length}/${data.items.length}`
              : ""}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={!data || data.running}
            onClick={() =>
              void act(async () => {
                const response = await fetch(resolveWsHttpUrl("/api/storage/migration/retry"), {
                  method: "POST",
                  credentials: "include",
                });
                if (!response.ok) throw new Error(await response.text());
              })
            }
          >
            {tr("Retry migration")}
          </Button>
        </div>
        {data?.error ? (
          <p role="alert" className="text-destructive">
            {data.error}
          </p>
        ) : null}
        {data?.items.map((item) => (
          <details
            key={item.projectId}
            className="rounded-lg border border-border p-3"
            open={item.status === "blocked"}
          >
            <summary className="cursor-pointer">
              {tr(item.status)} · {item.source.split(/[\\/]/u).pop()}{" "}
              {item.status === "copying" ? ` · ${Object.keys(item.files).length}` : ""}
            </summary>
            <div className="mt-2 space-y-2 break-all text-xs">
              <p>
                {item.source} → {item.target ?? tr("Original location retained")}
              </p>
              {item.error ? <p className="text-destructive">{item.error}</p> : null}
              {item.conflicts.map((conflict) => (
                <p key={conflict}>{conflict}</p>
              ))}
            </div>
          </details>
        ))}
        {data?.backupPath ? (
          <p className="break-all text-xs text-muted-foreground">
            {tr("Database backup")}: {data.backupPath}
          </p>
        ) : null}
      </div>
    </SettingsSection>
  );
}
