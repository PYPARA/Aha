import { useState } from "react";
import type {
  ResourceBatchPlan,
  ResourceBatchResult,
  ResourceEntry,
  ResourceImportResult,
  ResourceTagMode,
} from "@synara/contracts/resourceLibrary";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ResourceDestinationSelect } from "./ResourceDestinationSelect";
import { ResourceSelect } from "./ResourceSelect";
import { resourceApi } from "./resourceLibrary";

export interface ResourceOperation {
  kind: "project" | "folder" | "rename" | "move" | "tags" | "chat" | "import" | "export";
  entries: ResourceEntry[];
  target: string | null;
  paths?: string[];
  importDirectories?: boolean;
  plan?: ResourceBatchPlan;
}
const titles = {
  project: "New project",
  folder: "New folder",
  rename: "Rename",
  move: "Move to",
  tags: "Edit tags",
  chat: "Use in chat",
  import: "Import files",
  export: "Export",
} as const;
export function ResourceOperationDialog({
  operation,
  directories,
  threads,
  onClose,
  onChanged,
  onCreated,
  onImport,
  onBatch,
  onChat,
  onCompleted,
  onNewProject,
}: {
  operation: ResourceOperation;
  directories: ResourceEntry[];
  threads: { id: string; title: string }[];
  onClose: () => void;
  onChanged: () => Promise<unknown>;
  onCreated: (entry: ResourceEntry, project: boolean) => void;
  onImport: (result: ResourceImportResult, operation: ResourceOperation) => void;
  onBatch: (result: ResourceBatchResult, plan: ResourceBatchPlan) => void;
  onChat: (target: string, entries: ResourceEntry[]) => Promise<void>;
  onCompleted: (ids: string[]) => void;
  onNewProject: () => void;
}) {
  const tr = useAhaTranslation();
  const [name, setName] = useState(
    operation.kind === "rename" && operation.entries.length === 1 ? operation.entries[0]!.name : "",
  );
  const [target, setTarget] = useState(operation.kind === "chat" ? "new" : operation.target);
  const [tagMode, setTagMode] = useState<ResourceTagMode>("add");
  const [plan, setPlan] = useState<ResourceBatchPlan | null>(operation.plan ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = operation.entries.map((entry) => entry.id);
  const needsTarget = ["move", "import", "chat"].includes(operation.kind);
  const needsName = ["project", "folder", "rename", "tags"].includes(operation.kind);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (needsTarget && target === null) throw new Error("Choose a destination folder.");
      if (operation.kind === "rename" || operation.kind === "move" || operation.kind === "export") {
        if (!plan) {
          setPlan(
            await resourceApi<ResourceBatchPlan>({
              op: "prepareBatch",
              action: operation.kind,
              ids,
              name,
              ...(target !== null ? { target } : {}),
            }),
          );
          return;
        }
        const result = await resourceApi<ResourceBatchResult>({
          op: "executeBatch",
          planId: plan.id,
        });
        await onChanged();
        onBatch(result, plan);
        onClose();
        return;
      }
      if (operation.kind === "project" || operation.kind === "folder") {
        const created = await resourceApi<ResourceEntry>({
          op: "createDirectory",
          parent: operation.kind === "project" ? "" : (operation.target ?? ""),
          name,
        });
        await onChanged();
        onCreated(created, operation.kind === "project");
      } else if (operation.kind === "tags") {
        await resourceApi({
          op: "metadata",
          ids,
          tags: name
            .split(/[,，]/u)
            .map((value) => value.trim())
            .filter(Boolean),
          tagMode,
        });
        await onChanged();
        onCompleted(ids);
      } else if (operation.kind === "chat") await onChat(target!, operation.entries);
      else if (operation.kind === "import") {
        const result = await resourceApi<ResourceImportResult>({
          op: "importPaths",
          target: target!,
          ...(operation.paths ? { paths: operation.paths } : {}),
          directories: operation.importDirectories,
        });
        await onChanged();
        onImport(result, { ...operation, target });
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{tr(titles[operation.kind])}</DialogTitle>
          <DialogDescription>
            {operation.kind === "folder"
              ? `${tr("Parent folder")}: ${operation.target || tr("Library root")}`
              : operation.kind === "project"
                ? tr("Create a new folder at the library root.")
                : operation.entries.length
                  ? `${operation.entries.length} ${tr("selected")}`
                  : tr("Choose a destination folder.")}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto p-4 text-ui">
          {needsTarget ? (
            operation.kind === "chat" ? (
              <ResourceSelect
                label={tr("Destination")}
                value={target ?? "new"}
                disabled={busy}
                onChange={setTarget}
                options={[
                  { value: "new", label: tr("New chat") },
                  ...threads.map((thread) => ({ value: thread.id, label: thread.title })),
                ]}
              />
            ) : (
              <ResourceDestinationSelect
                value={target}
                directories={directories}
                disabled={busy}
                onChange={(value) => {
                  setTarget(value);
                  setPlan(null);
                }}
              />
            )
          ) : null}
          {operation.kind === "tags" ? (
            <ResourceSelect
              label={tr("Tag operation")}
              value={tagMode}
              disabled={busy}
              onChange={(value) => setTagMode(value as ResourceTagMode)}
              options={[
                { value: "add", label: tr("Add tags; preserve existing tags") },
                { value: "remove", label: tr("Remove specified tags") },
                { value: "replace", label: tr("Replace all tags") },
              ]}
            />
          ) : null}
          {needsName ? (
            <Input
              aria-label={tr(operation.kind === "tags" ? "Tags" : "Name")}
              value={name}
              disabled={busy}
              placeholder={tr(operation.kind === "tags" ? "Separate tags with commas" : "Name")}
              onChange={(event) => {
                setName(event.target.value);
                setPlan(null);
              }}
            />
          ) : null}
          {operation.kind === "tags" && tagMode === "replace" ? (
            <p role="note" className="text-ui-sm text-destructive">
              {tr(
                "This replaces every selected resource's tags, including removing tags not listed here.",
              )}
            </p>
          ) : null}
          {operation.kind === "import" && !directories.length ? (
            <Button variant="outline" disabled={busy} onClick={onNewProject}>
              {tr("Import to the library root or create a folder.")}
            </Button>
          ) : null}
          {plan ? (
            <div
              className="max-h-72 overflow-auto rounded-lg border border-border"
              data-testid="resource-batch-preview"
            >
              <table className="w-full text-left text-ui-sm">
                <thead className="sticky top-0 bg-background">
                  <tr>
                    <th className="p-2 font-medium">{tr("Original name")}</th>
                    <th className="p-2 font-medium">{tr("Result")}</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.items.map((item) => (
                    <tr key={item.id} className="border-t border-border">
                      <td className="break-all p-2">{item.source}</td>
                      <td className={`break-all p-2 ${item.error ? "text-destructive" : ""}`}>
                        {item.error
                          ? tr(item.error)
                          : item.status === "skipped"
                            ? tr("Unchanged or included by a parent folder")
                            : (item.target ?? tr("Move to trash"))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="whitespace-pre-wrap text-ui-sm text-destructive">
              {tr(error)}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              {tr("Cancel")}
            </Button>
            <Button
              disabled={
                busy ||
                (needsTarget && target === null) ||
                (needsName && operation.kind !== "tags" && !name.trim()) ||
                (operation.kind === "tags" && tagMode !== "replace" && !name.trim()) ||
                (!!plan && !plan.items.some((item) => item.status === "ready"))
              }
              onClick={() => void submit()}
            >
              {tr(
                busy
                  ? "Working..."
                  : plan
                    ? "Confirm operation"
                    : operation.kind === "rename" || operation.kind === "move"
                      ? "Preview changes"
                      : "Confirm",
              )}
            </Button>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
