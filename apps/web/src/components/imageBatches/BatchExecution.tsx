import { useRef, useState } from "react";
import type {
  ImageBatchAttempt,
  ImageBatchCommand,
  ImageBatchPreflight,
  ImageBatchState,
} from "@synara/contracts";
import {
  imageBatchMissingCount,
  imageBatchRetryLineage,
  imageBatchTaskConfiguration,
  type ImageGenerationParameters,
} from "@synara/contracts";
import { useImageProviders } from "../drawing/useDrawing";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { batchApi, useBatchCommand } from "./useImageBatches";

const activeStatus = (s: string) => ["prepared", "queued", "running", "saving"].includes(s);
type Confirmation = {
  command: Extract<ImageBatchCommand, { operation: "confirm" | "retry" }>;
  tasks: number;
  images: number;
  providers: string[];
  issues: string[];
  uncertain: boolean;
  summaries: {
    id: string;
    name: string;
    prompt: string;
    model: string;
    parameters: ImageGenerationParameters;
    references: number;
  }[];
};
export function BatchExecution({
  batch,
  onError,
}: {
  batch: ImageBatchState;
  onError: (e: unknown) => void;
}) {
  const tr = useAhaTranslation(),
    command = useBatchCommand();
  const providers = useImageProviders();
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false),
    [ack, setAck] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const submitting = useRef(false);
  const active = batch.executions.find((e) => !e.finishedAt);
  const latest = active ?? batch.executions.at(-1);
  const attempts = latest?.attempts ?? [];
  const prepare = async (mode?: "missing" | "regenerate") => {
    setBusy(true);
    setAck(false);
    try {
      if (!mode) {
        const p: ImageBatchPreflight = await batchApi().preflight({ id: batch.id });
        if (p.version !== batch.version)
          throw new Error(tr("Batch changed. Reload before applying your changes."));
        setConfirm({
          command: {
            operation: "confirm",
            batchId: batch.id,
            version: p.version,
            requestId: crypto.randomUUID(),
          },
          tasks: p.tasks,
          images: p.images,
          issues: p.issues.map(
            (i) => (batch.tasks.find((t) => t.id === i.taskId)?.name ?? "") + ": " + i.message,
          ),
          providers: [
            ...new Set(
              batch.tasks
                .filter((t) => t.enabled)
                .map((t) => t.providerId ?? batch.defaults.providerId),
            ),
          ],
          uncertain: false,
          summaries: batch.tasks
            .filter((t) => t.enabled)
            .map((t) => ({
              ...t,
              ...imageBatchTaskConfiguration(t, batch.defaults),
              references: t.references.length,
            })),
        });
      } else {
        const targets = batch.executions
          .flatMap((execution) => execution.attempts)
          .filter((a) => selected.includes(a.id));
        if (new Set(targets.map((a) => a.taskId)).size !== targets.length)
          throw new Error(tr("Select one attempt per task to retry."));
        if (!targets.length) throw new Error(tr("Select attempts to retry."));
        const amounts = targets.map((a) =>
          mode === "missing" ? imageBatchMissingCount(batch, a) : a.parameters.n,
        );
        setConfirm({
          command: {
            operation: "retry",
            batchId: batch.id,
            version: batch.version,
            requestId: crypto.randomUUID(),
            attemptIds: targets.map((a) => a.id),
            mode,
            acknowledgeUncertain: false,
          },
          tasks: amounts.filter((n) => n > 0).length,
          images: amounts.reduce((a, b) => a + b, 0),
          providers: [...new Set(targets.map((a) => a.providerId))],
          issues: [],
          uncertain: targets.some((a) =>
            (mode === "missing" ? imageBatchRetryLineage(batch, a) : [a]).some(
              (value) => value.status === "uncertain",
            ),
          ),
          summaries: targets.map((a, index) => ({
            id: a.id,
            name: a.taskName,
            prompt: a.requestPrompt ?? a.prompt,
            model: a.model,
            parameters: { ...a.parameters, n: amounts[index]! },
            references: a.references.length,
          })),
        });
      }
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };
  const start = async () => {
    if (!confirm || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      await command(
        confirm.command.operation === "retry"
          ? { ...confirm.command, acknowledgeUncertain: ack }
          : confirm.command,
      );
      setConfirm(null);
      setSelected([]);
    } catch (e) {
      onError(e);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const control = async (operation: "pause" | "resume" | "cancel") => {
    if (!active) return;
    if (
      operation === "cancel" &&
      !window.confirm(
        tr(
          "Cancel all remaining items in this execution? Sent requests may have already executed or incurred charges. Returned images are retained.",
        ),
      )
    )
      return;
    setBusy(true);
    try {
      await command({ operation, batchId: batch.id, executionId: active.id });
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 border-t p-4 text-ui-sm">
      <div className="flex flex-wrap items-center gap-2">
        {active ? (
          <>
            <span className="mr-auto" role="status">
              {tr(
                active.cancelled
                  ? "Cancelling remaining items"
                  : active.paused
                    ? "Execution paused"
                    : "Execution in progress",
              )}
            </span>
            {!active.cancelled && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void control(active.paused ? "resume" : "pause")}
                >
                  {tr(active.paused ? "Continue" : "Pause")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void control("cancel")}
                >
                  {tr("Cancel remaining")}
                </Button>
              </>
            )}
          </>
        ) : (
          <Button
            disabled={busy || batch.archived || !batch.tasks.some((t) => t.enabled)}
            onClick={() => void prepare()}
          >
            {tr("Review and generate")}
          </Button>
        )}
        {latest && (
          <span className="text-ui-xs text-muted-foreground">
            {tr("Tasks finished")}: {attempts.filter((a) => !activeStatus(a.status)).length}/
            {attempts.length} · {tr("Images saved")}: {attempts.reduce((n, a) => n + a.outputs, 0)}{" "}
            · {tr("Issues")}:{" "}
            {
              attempts.filter((a) =>
                ["failed", "partial", "uncertain", "interrupted"].includes(a.status),
              ).length
            }
          </span>
        )}
      </div>
      {(active?.blockedProviders?.length ?? 0) > 0 && (
        <p role="alert" className="text-destructive">
          {tr(
            "A channel is blocked by authentication, quota or rate limits. Resolve the channel issue and choose Continue.",
          )}{" "}
          {active?.blockedProviders?.join(", ")}
        </p>
      )}
      {latest && (
        <details>
          <summary className="cursor-pointer py-1">
            {tr("Frozen execution and attempts")} · {new Date(latest.createdAt).toLocaleString()}
          </summary>
          <div className="max-h-80 space-y-2 overflow-auto py-2">
            {attempts.map((a) => (
              <AttemptRow
                key={a.id}
                attempt={a}
                selected={selected.includes(a.id)}
                onSelected={(value) =>
                  setSelected(value ? [...selected, a.id] : selected.filter((id) => id !== a.id))
                }
              />
            ))}
          </div>
        </details>
      )}
      {batch.executions.length > 1 && (
        <details>
          <summary className="cursor-pointer">
            {tr("Previous executions")} ({batch.executions.length - 1})
          </summary>
          {batch.executions
            .slice(0, -1)
            .toReversed()
            .map((e) => (
              <details key={e.id} className="mt-2">
                <summary className="cursor-pointer">
                  {new Date(e.createdAt).toLocaleString()} · {e.attempts.length} {tr("tasks")}
                </summary>
                {e.attempts.map((a) => (
                  <AttemptRow
                    key={a.id}
                    attempt={a}
                    selected={selected.includes(a.id)}
                    onSelected={(value) =>
                      setSelected(
                        value ? [...selected, a.id] : selected.filter((id) => id !== a.id),
                      )
                    }
                  />
                ))}
              </details>
            ))}
        </details>
      )}
      {!active && selected.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void prepare("missing")}
          >
            {tr("Fill missing images")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void prepare("regenerate")}
          >
            {tr("Regenerate selected")}
          </Button>
        </div>
      )}{" "}
      <Dialog
        open={!!confirm}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{tr("Confirm image generation")}</DialogTitle>
            <DialogDescription>
              {tr(
                "Requests use the frozen task list shown below. Later draft edits apply to the next execution.",
              )}
            </DialogDescription>
          </DialogHeader>
          {confirm && (
            <>
              <div className="max-h-[65dvh] space-y-3 overflow-auto p-4 text-ui-sm">
                <p className="text-ui font-medium">
                  {confirm.tasks} {tr("tasks")} · {confirm.images} {tr("images")}
                </p>
                <p>
                  {tr("Channels")}:{" "}
                  {confirm.providers
                    .map((id) => providers.data?.find((provider) => provider.id === id)?.name ?? id)
                    .join(", ") || "—"}
                </p>
                <p>
                  {tr("Draft version")}: {confirm.command.version}
                  {latest
                    ? " · " + tr("Previous execution version") + ": " + latest.draftVersion
                    : ""}
                </p>
                <p>
                  {tr("Estimated cost")}: {tr("Unknown")}
                </p>
                {confirm.summaries?.map((task) => (
                  <details key={task.id} className="border-t pt-2">
                    <summary className="cursor-pointer">
                      {task.name} · {task.parameters.n} {tr("images")} · {task.model} ·{" "}
                      {task.references} {tr("references")}
                    </summary>
                    <p className="my-2 whitespace-pre-wrap break-words">{task.prompt}</p>
                    <pre className="overflow-auto whitespace-pre-wrap break-all text-ui-xs text-muted-foreground">
                      {JSON.stringify(task.parameters, null, 2)}
                    </pre>
                  </details>
                ))}
                {confirm.command.operation === "retry" && (
                  <p>
                    {tr(
                      confirm.command.mode === "missing"
                        ? "Only missing images will be requested. Existing candidates are retained."
                        : "New attempts will be created. Existing candidates are retained.",
                    )}
                  </p>
                )}
                {[...new Set(confirm.issues)].map((issue) => (
                  <p role="alert" key={issue} className="text-destructive">
                    {issue}
                  </p>
                ))}
                {confirm.uncertain && (
                  <label className="flex items-start gap-2">
                    <Checkbox checked={ack} onCheckedChange={(value) => setAck(value === true)} />
                    <span>
                      {tr(
                        "I checked the uncertain requests. Resubmitting may execute and charge again.",
                      )}
                    </span>
                  </label>
                )}
              </div>
              <div className="flex justify-end gap-2 border-t p-4">
                <Button variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>
                  {tr("Cancel")}
                </Button>
                <Button
                  disabled={
                    busy ||
                    !confirm.images ||
                    !!confirm.issues.length ||
                    (confirm.uncertain && !ack)
                  }
                  onClick={() => void start()}
                >
                  {tr("Confirm generation")}
                </Button>
              </div>
            </>
          )}
        </DialogPopup>
      </Dialog>
    </div>
  );
}
function AttemptRow({
  attempt: a,
  selected,
  onSelected,
}: {
  attempt: ImageBatchAttempt;
  selected?: boolean;
  onSelected?: (value: boolean) => void;
}) {
  const tr = useAhaTranslation();
  return (
    <div className="border-t py-2">
      <div className="flex items-start gap-2">
        {onSelected && (
          <Checkbox
            aria-label={tr("Select attempt") + ": " + a.taskName}
            checked={selected}
            onCheckedChange={(value) => onSelected(value === true)}
          />
        )}
        <div className="min-w-0 flex-1">
          <p>
            {a.taskName} · {tr(a.status)} · {a.outputs}/{a.parameters.n}
          </p>
          {a.error && <p className="break-words text-destructive">{a.error}</p>}
          <details className="mt-1 text-ui-xs text-muted-foreground">
            <summary className="cursor-pointer">{tr("Frozen parameters")}</summary>
            <pre className="overflow-auto whitespace-pre-wrap break-all">
              {JSON.stringify(
                {
                  attemptId: a.id,
                  jobId: a.jobId,
                  requestId: a.requestId,
                  upstreamRequestId: a.upstreamRequestId,
                  prompt: a.requestPrompt ?? a.prompt,
                  providerId: a.providerId,
                  model: a.model,
                  parameters: a.parameters,
                  references: a.references,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </div>
      </div>
    </div>
  );
}
