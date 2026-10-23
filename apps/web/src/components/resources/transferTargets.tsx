import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ThreadId } from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { ResourceSelect } from "./ResourceSelect";
import { queueResourceTransfer, useResourceTransfer } from "./resourceLibrary";
import { listSpriteProjects } from "../sprite/spriteStorage";
import { batchApi } from "../imageBatches/useImageBatches";

/** Creative modules that receive images through the shared transfer queue. */
export type TransferModule = "sprite" | "image-batch";
export const NEW_TRANSFER_TARGET = "new";
type Navigate = ReturnType<typeof useNavigate>;

export const transferTarget = (module: TransferModule, id: string) => `${module}:${id}`;

/** Opens the page that registers `target` with useResourceAttachments. */
export async function navigateToTransferTarget(navigate: Navigate, target: string) {
  const [module, id] = target.split(/:(.*)/su) as [string, string | undefined];
  if (target === "drawing") await navigate({ to: "/drawing" });
  else if (module === "sprite")
    await navigate({
      to: "/sprite-animation",
      search: id && id !== NEW_TRANSFER_TARGET ? { projectId: id } : {},
    });
  else if (module === "image-batch")
    await navigate({ to: "/image-batches", search: { batchId: id! } });
  else await navigate({ to: "/$threadId", params: { threadId: target as ThreadId } });
}

/** Reads a generated image (batch result, drawing output) as a File for the transfer queue. */
export async function fetchImageFile(url: string, name: string) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error("Could not read the image.");
  const blob = await response.blob();
  return new File([blob], name, { type: blob.type });
}

/**
 * Queues files for a module and opens it. "image-batch:new" creates the batch first;
 * "sprite:new" lets the sprite library ask for the project settings, then retargets.
 */
export async function sendFilesToTarget(
  navigate: Navigate,
  target: string,
  files: File[],
  options: {
    origin?: { resourceIds: string[]; libraryId: string };
    newBatchName?: string;
  } = {},
) {
  let destination = target;
  if (destination === transferTarget("image-batch", NEW_TRANSFER_TARGET)) {
    const batch = await batchApi().command({
      operation: "create",
      requestId: crypto.randomUUID(),
      name: options.newBatchName ?? "Untitled batch",
    });
    destination = transferTarget("image-batch", batch.id);
  }
  queueResourceTransfer(destination, files, options.origin);
  try {
    await navigateToTransferTarget(navigate, destination);
  } catch (cause) {
    useResourceTransfer.setState({ pending: null });
    throw cause;
  }
}

/** Picks an existing sprite project / batch, or a new one, for the selected images. */
export function TransferTargetDialog({
  module,
  count,
  onClose,
  onSend,
}: {
  module: TransferModule;
  count: number;
  onClose: () => void;
  onSend: (target: string) => Promise<void>;
}) {
  const tr = useAhaTranslation();
  const [options, setOptions] = useState<{ value: string; label: string }[] | null>(null);
  const [target, setTarget] = useState(transferTarget(module, NEW_TRANSFER_TARGET));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void (
      module === "sprite"
        ? listSpriteProjects().then((s) =>
            s.projects.filter((p) => !p.deleting).map((p) => ({ id: p.id, name: p.name })),
          )
        : batchApi()
            .list({ filter: "all" })
            .then((page) =>
              page.batches.filter((b) => !b.archived).map((b) => ({ id: b.id, name: b.name })),
            )
    )
      .then((items) => {
        if (alive)
          setOptions(
            items.map((item) => ({ value: transferTarget(module, item.id), label: item.name })),
          );
      })
      .catch((cause) => {
        if (alive) {
          setOptions([]);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      alive = false;
    };
  }, [module]);
  const sprite = module === "sprite";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{tr(sprite ? "Use in sprite" : "Use in batch")}</DialogTitle>
          <DialogDescription>
            {count}{" "}
            {tr(
              sprite
                ? "images will be added to the project's image materials."
                : "images will be added to the batch style reference images.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 p-4 text-ui">
          <ResourceSelect
            label={tr("Destination")}
            value={target}
            disabled={busy || options === null}
            onChange={setTarget}
            options={[
              {
                value: transferTarget(module, NEW_TRANSFER_TARGET),
                label: tr(sprite ? "New sprite project" : "New batch"),
              },
              ...(options ?? []),
            ]}
          />
          {error && (
            <p role="alert" className="text-ui-sm text-destructive">
              {tr(error)}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {tr("Cancel")}
          </Button>
          <Button
            disabled={busy || options === null}
            onClick={() => {
              setBusy(true);
              setError(null);
              void onSend(target)
                .then(onClose)
                .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
                .finally(() => setBusy(false));
            }}
          >
            {tr("Send")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
