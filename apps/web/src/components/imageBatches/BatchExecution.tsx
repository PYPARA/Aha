import { useEffect, useEffectEvent, useRef, useState } from "react";
import type {
  ImageBatchAttempt,
  ImageBatchCommand,
  ImageBatchPreflight,
  ImageBatchState,
} from "@synara/contracts";
import {
  imageBatchMissingCount,
  imageBatchRetryLineage,
  imageBatchComposePrompt,
  imageBatchTaskConfiguration,
  imageBatchTaskReferences,
  type ImageGenerationParameters,
} from "@synara/contracts";
import { useImageProviders } from "../drawing/useDrawing";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "../ui/button";
import { confirmDialog } from "../ui/confirm-dialog";
import { Checkbox } from "../ui/checkbox";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";
import { OptionSelect } from "../ui/option-select";
import { outputGroup } from "./resultNames";
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
    output?: string | undefined;
    prompt: string;
    model: string;
    /** Whether the task follows the batch channel, so the run's channel choice applies to it. */
    inherits: boolean;
    parameters: ImageGenerationParameters;
    references: number;
  }[];
};
export function BatchExecution({
  batch,
  onError,
  reviewVersion,
  onReviewOpened,
  retryRequest,
  onRetryHandled,
}: {
  batch: ImageBatchState;
  onError: (e: unknown) => void;
  /** Opens the generation check once this draft version is loaded (after "Apply and review"). */
  reviewVersion?: number | null;
  onReviewOpened?: () => void;
  /** A retry asked for from a task row; it opens the same confirmation as the records drawer. */
  retryRequest?: { attemptIds: string[]; mode: "missing" | "regenerate" } | null;
  onRetryHandled?: () => void;
}) {
  const tr = useAhaTranslation(),
    command = useBatchCommand();
  const providers = useImageProviders();
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false),
    [ack, setAck] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [records, setRecords] = useState(false);
  const submitting = useRef(false);
  const active = batch.executions.find((e) => !e.finishedAt);
  const latest = active ?? batch.executions.at(-1);
  const attempts = latest?.attempts ?? [];
  const prepare = async (mode?: "missing" | "regenerate", attemptIds = selected) => {
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
              inherits: !t.providerId,
              prompt: imageBatchComposePrompt(batch.defaults.stylePrompt, t.prompt),
              references: imageBatchTaskReferences(t, batch.defaults.styleReferences).length,
            })),
        });
      } else {
        const targets = batch.executions
          .flatMap((execution) => execution.attempts)
          .filter((a) => attemptIds.includes(a.id));
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
            output: a.output,
            inherits: false,
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
  // Channels that offer the batch model; switching re-runs the check for this run only.
  const channels = (providers.data ?? []).filter(
    (p) =>
      p.id === batch.defaults.providerId ||
      (p.enabled && p.models.some((m) => m.id === batch.defaults.model)),
  );
  const switchChannel = async (providerId: string) => {
    if (!confirm || confirm.command.operation !== "confirm") return;
    setBusy(true);
    try {
      const p = await batchApi().preflight({ id: batch.id, providerId });
      const { providerId: _, ...base } = confirm.command;
      setConfirm({
        ...confirm,
        command: providerId === batch.defaults.providerId ? base : { ...base, providerId },
        tasks: p.tasks,
        images: p.images,
        issues: p.issues.map(
          (i) => (batch.tasks.find((t) => t.id === i.taskId)?.name ?? "") + ": " + i.message,
        ),
        providers: [
          ...new Set(batch.tasks.filter((t) => t.enabled).map((t) => t.providerId ?? providerId)),
        ],
      });
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };
  // One model for every task is shown once instead of on each row.
  const sharedModel =
    confirm && new Set(confirm.summaries.map((task) => task.model)).size === 1
      ? confirm.summaries[0]!.model
      : null;
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
      setRecords(false);
    } catch (e) {
      onError(e);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const reviewRequested = reviewVersion != null && reviewVersion === batch.version;
  // prepare reads the batch prop, which already carries the applied version here.
  const openReview = useEffectEvent(() => {
    onReviewOpened?.();
    if (!active && !batch.archived) void prepare();
  });
  useEffect(() => {
    if (reviewRequested) openReview();
  }, [reviewRequested]);
  const openRetry = useEffectEvent(() => {
    if (!retryRequest) return;
    onRetryHandled?.();
    if (!active) void prepare(retryRequest.mode, retryRequest.attemptIds);
  });
  useEffect(() => {
    if (retryRequest) openRetry();
  }, [retryRequest]);
  const control = async (operation: "pause" | "resume" | "cancel") => {
    if (!active) return;
    if (
      operation === "cancel" &&
      !(await confirmDialog({
        title: tr("Cancel remaining items?"),
        description: tr(
          "Items not yet sent are cancelled. Sent requests may have already executed or incurred charges. Returned images are retained.",
        ),
        confirmLabel: tr("Cancel remaining"),
        cancelLabel: tr("Keep running"),
        destructive: true,
      }))
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
  const finished = attempts.filter((a) => !activeStatus(a.status)).length;
  const issues = attempts.filter((a) =>
    ["failed", "partial", "uncertain", "interrupted"].includes(a.status),
  ).length;
  const enabled = batch.tasks.filter((t) => t.enabled);
  const plannedImages = enabled.reduce(
    (n, t) => n + imageBatchTaskConfiguration(t, batch.defaults).parameters.n,
    0,
  );
  const toggle = (id: string, value: boolean) =>
    setSelected(value ? [...selected, id] : selected.filter((x) => x !== id));
  return (
    <div className="space-y-2 border-t px-4 py-3 text-ui-sm">
      <div className="flex flex-wrap items-center gap-2">
        {active ? (
          <>
            <span role="status">
              {tr(
                active.cancelled
                  ? "Cancelling remaining items"
                  : active.paused
                    ? "Execution paused"
                    : "Execution in progress",
              )}
            </span>
            <div
              role="progressbar"
              aria-label={tr("Tasks finished")}
              aria-valuemin={0}
              aria-valuemax={attempts.length}
              aria-valuenow={finished}
              className="h-1.5 w-32 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${attempts.length ? (finished / attempts.length) * 100 : 0}%` }}
              />
            </div>
            <span className="text-ui-xs text-muted-foreground">
              {finished}/{attempts.length}
              {issues ? " · " + tr("Issues") + ": " + issues : ""}
            </span>
            <span className="flex-1" />
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
          <>
            <Button
              disabled={busy || batch.archived || !enabled.length}
              onClick={() => void prepare()}
            >
              {tr("Review and generate")}
            </Button>
            {enabled.length > 0 && (
              <span className="text-ui-xs">
                {enabled.length} {tr("tasks")} · {plannedImages} {tr("images")}
              </span>
            )}
            {latest && (
              <span className="text-ui-xs text-muted-foreground">
                {tr("Last run")}: {tr("Tasks finished")} {finished}/{attempts.length} ·{" "}
                {tr("Images saved")} {attempts.reduce((n, a) => n + a.outputs, 0)}
                {issues ? " · " + tr("Issues") + " " + issues : ""}
              </span>
            )}
            <span className="flex-1" />
          </>
        )}
        {latest && (
          <Button size="sm" variant="ghost" onClick={() => setRecords(true)}>
            {tr("Generation records")}
          </Button>
        )}
      </div>
      {(active?.blockedProviders?.length ?? 0) > 0 && (
        <p role="alert" className="text-destructive">
          {tr(
            "A channel is blocked by authentication, quota or rate limits. Resolve the channel issue and choose Continue.",
          )}{" "}
          {active?.blockedProviders
            ?.map((id) => providers.data?.find((provider) => provider.id === id)?.name ?? id)
            .join(", ")}
        </p>
      )}
      <Sheet open={records} onOpenChange={setRecords}>
        <SheetPopup side="right" className="w-full max-w-md">
          <SheetTitle className="border-b p-4 text-ui font-medium">
            {tr("Generation records")}
          </SheetTitle>
          <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4 text-ui-sm">
            {latest && (
              <section>
                <h3 className="text-ui-xs text-muted-foreground">
                  {new Date(latest.createdAt).toLocaleString()}
                </h3>
                {attempts.map((a) => (
                  <AttemptRow
                    key={a.id}
                    attempt={a}
                    selected={selected.includes(a.id)}
                    onSelected={(value) => toggle(a.id, value)}
                  />
                ))}
              </section>
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
                          onSelected={(value) => toggle(a.id, value)}
                        />
                      ))}
                    </details>
                  ))}
              </details>
            )}
          </div>
          {!active && selected.length > 0 && (
            <div className="flex flex-wrap justify-end gap-2 border-t p-4">
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
          )}
        </SheetPopup>
      </Sheet>
      <Dialog
        open={!!confirm}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null);
        }}
      >
        <DialogPopup className="max-w-2xl">
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
                {confirm.command.operation === "confirm" &&
                confirm.summaries.some((task) => task.inherits) &&
                channels.length > 1 ? (
                  <div className="w-64">
                    <OptionSelect
                      label={tr("Channel for this run")}
                      value={confirm.command.providerId ?? batch.defaults.providerId}
                      disabled={busy}
                      onValueChange={(value) => void switchChannel(value)}
                    >
                      {channels.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </OptionSelect>
                  </div>
                ) : (
                  <p>
                    {tr("Channels")}:{" "}
                    {confirm.providers
                      .map(
                        (id) => providers.data?.find((provider) => provider.id === id)?.name ?? id,
                      )
                      .join(", ") || "—"}
                  </p>
                )}
                {confirm.command.operation === "confirm" &&
                  confirm.summaries.some((task) => !task.inherits) &&
                  confirm.summaries.some((task) => task.inherits) && (
                    <p className="text-ui-xs text-muted-foreground">
                      {tr("Tasks with their own channel keep it.")}
                    </p>
                  )}
                {sharedModel && (
                  <p>
                    {tr("Model")}: {sharedModel}
                  </p>
                )}
                <p>
                  {tr("Estimated cost")}: {tr("Unknown")}
                </p>
                {confirm.command.operation === "confirm" &&
                  (!!batch.defaults.stylePrompt?.trim() ||
                    !!batch.defaults.styleReferences?.length) && (
                    <p className="text-ui-xs text-muted-foreground">
                      {tr("Batch style is added to every task")}
                      {batch.defaults.styleReferences?.length
                        ? " · " +
                          batch.defaults.styleReferences.length +
                          " " +
                          tr("Style reference images")
                        : ""}
                    </p>
                  )}
                {[...new Set(confirm.summaries.map((task) => outputGroup(task.output)))].map(
                  (group) => (
                    <section key={group} className="border-t pt-2">
                      {confirm.summaries.some((task) => outputGroup(task.output)) && (
                        <h3 className="text-ui-xs font-medium text-muted-foreground">
                          {group || tr("Ungrouped")}
                        </h3>
                      )}
                      {confirm.summaries
                        .filter((task) => outputGroup(task.output) === group)
                        .map((task) => (
                          <details key={task.id} className="py-1">
                            <summary className="cursor-pointer">
                              {task.name}
                              <span className="text-muted-foreground">
                                {" · " +
                                  [
                                    task.output,
                                    task.parameters.size,
                                    task.parameters.n + " " + tr("images"),
                                    task.parameters.quality &&
                                      tr("Quality") + " " + tr(task.parameters.quality),
                                    task.parameters.background &&
                                      tr("Background") + " " + tr(task.parameters.background),
                                    !sharedModel && task.model,
                                    task.references + " " + tr("references"),
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                              </span>
                            </summary>
                            <p className="my-2 whitespace-pre-wrap break-words">{task.prompt}</p>
                          </details>
                        ))}
                    </section>
                  ),
                )}
                {confirm.command.operation === "retry" && (
                  <p>
                    {tr(
                      confirm.command.mode === "missing"
                        ? "Only missing images will be requested. Existing candidates are retained."
                        : "New attempts will be created. Existing candidates are retained.",
                    )}
                  </p>
                )}
                <details className="text-ui-xs text-muted-foreground">
                  <summary className="cursor-pointer">{tr("Diagnostic details")}</summary>
                  <p className="mt-1">
                    {tr("Draft version")}: {confirm.command.version}
                    {latest
                      ? " · " + tr("Previous execution version") + ": " + latest.draftVersion
                      : ""}
                  </p>
                </details>
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
            <summary className="cursor-pointer">{tr("Diagnostic details")}</summary>
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
