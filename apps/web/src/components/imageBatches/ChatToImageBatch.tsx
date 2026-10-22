import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { Thread } from "~/types";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { BatchImagesIcon } from "~/lib/icons";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Textarea } from "../ui/textarea";
import { Input } from "../ui/input";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { createDraftThread } from "~/lib/draftThreadCreate";
import { batchApi, useBatchCommand } from "./useImageBatches";

/** The user explicitly picks text and attachments; the server copies owned source files. */
export function ChatToImageBatch({ thread }: { thread: Thread }) {
  const tr = useAhaTranslation(),
    navigate = useNavigate(),
    command = useBatchCommand();
  const [open, setOpen] = useState(false),
    [text, setText] = useState(""),
    [name, setName] = useState("");
  const [chosen, setChosen] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const receipt = useRef<{
    requestId: string;
    batchId?: string;
    threadId?: ReturnType<typeof createDraftThread>;
  } | null>(null);
  const messages = thread.messages.filter((message) => !message.streaming);
  const attachments = messages.flatMap((message) =>
    (message.attachments ?? [])
      .filter((attachment) => attachment.type === "image" || attachment.type === "file")
      .map((attachment) => ({
        messageId: message.id,
        attachmentId: attachment.id,
        name: attachment.name,
      })),
  );
  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    receipt.current ??= { requestId: crypto.randomUUID() };
    try {
      let batch = receipt.current.batchId
        ? await batchApi().get({ id: receipt.current.batchId })
        : await command({
            operation: "create",
            requestId: receipt.current.requestId,
            name: name || tr("Untitled batch"),
            brief: text,
            sourceThreadId: thread.id,
            projectId: thread.projectId,
          });
      receipt.current.batchId = batch.id;
      if (!batch.threadId) {
        receipt.current.threadId ??= createDraftThread({
          projectId: thread.projectId,
          prompt: text,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          envMode: "local",
        });
        batch = await command({
          operation: "bind-thread",
          batchId: batch.id,
          version: batch.version,
          threadId: receipt.current.threadId,
        });
      }
      if (chosen.length)
        await batchApi().importSources({
          batchId: batch.id,
          sourceThreadId: thread.id,
          attachments: attachments
            .filter((a) => chosen.includes(a.messageId + ":" + a.attachmentId))
            .map(({ messageId, attachmentId }) => ({ messageId, attachmentId })),
        });
      await navigate({ to: "/image-batches", search: { batchId: batch.id } });
      setOpen(false);
      receipt.current = null;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        size="icon-sm"
        variant="ghost"
        className="no-drag shrink-0"
        aria-label={tr("Organize as image batch")}
        title={tr("Organize as image batch")}
        onClick={() => {
          setText(window.getSelection()?.toString() ?? "");
          setName(thread.title);
          setChosen([]);
          setError(null);
          receipt.current = null;
          setOpen(true);
        }}
      >
        <BatchImagesIcon />
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{tr("Organize as image batch")}</DialogTitle>
            <DialogDescription>
              {tr(
                "Choose the text and attachments to copy into an independent batch conversation. Generation starts only after reviewing and confirming its task list.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[65dvh] space-y-3 overflow-auto p-4 text-ui-sm">
            <label className="block space-y-1">
              <span>{tr("Batch name")}</span>
              <Input
                disabled={!!receipt.current?.batchId}
                maxLength={200}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span>{tr("Text to bring into the batch")}</span>
              <Textarea
                disabled={!!receipt.current?.batchId}
                rows={5}
                maxLength={32000}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
            <details>
              <summary className="cursor-pointer">{tr("Choose conversation text")}</summary>
              <div className="space-y-2 py-2">
                {messages.map((message) => (
                  <label key={message.id} className="flex items-start gap-2 border-b py-2">
                    <Checkbox
                      disabled={!!receipt.current?.batchId}
                      aria-label={tr("Include message") + ": " + message.text.slice(0, 40)}
                      checked={text.includes(message.text) && !!message.text}
                      onCheckedChange={(value) =>
                        setText(
                          value
                            ? [text, message.text].filter(Boolean).join("\n\n")
                            : text.replace(message.text, "").trim(),
                        )
                      }
                    />
                    <span className="min-w-0 whitespace-pre-wrap break-words">
                      {message.text.slice(0, 1200)}
                    </span>
                  </label>
                ))}
              </div>
            </details>
            {attachments.length > 0 && (
              <div className="space-y-2">
                <p>{tr("Attachments to copy")}</p>
                {attachments.map((a) => {
                  const key = a.messageId + ":" + a.attachmentId;
                  return (
                    <label key={key} className="flex items-center gap-2">
                      <Checkbox
                        checked={chosen.includes(key)}
                        onCheckedChange={(value) =>
                          setChosen(value ? [...chosen, key] : chosen.filter((id) => id !== key))
                        }
                      />
                      {a.name}
                    </label>
                  );
                })}
              </div>
            )}
            {error && (
              <p role="alert" className="whitespace-pre-wrap text-destructive">
                {error}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2 border-t p-4">
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              {tr("Cancel")}
            </Button>
            <Button
              disabled={busy || (!text.trim() && !chosen.length)}
              onClick={() => void create()}
            >
              {tr(busy ? "Copying sources..." : "Create batch")}
            </Button>
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}
