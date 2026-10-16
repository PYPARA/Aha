/* eslint-disable react/no-array-index-key -- Candidate assets can repeat; temporal frame and issue positions are their identity. */
import { useEffect, useEffectEvent, useState } from "react";
import {
  spriteBlockedActions,
  SPRITE_ANALYSIS_VERSION,
  type SpriteRun,
  type SpriteState,
  type ImageAsset,
} from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "../ui/button";
import { Menu, MenuTrigger, MenuItem } from "../ui/menu";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { Dialog, DialogPopup, DialogHeader, DialogTitle } from "../ui/dialog";
import { drawingApi, imageUrl } from "../drawing/useDrawing";
import { spriteGenerationFailureMessage } from "./spriteGenerationFailure";
export const SPRITE_TASK_OPEN = "aha-sprite-task-open";
export const spriteCandidate = (run: SpriteRun) =>
  run.candidates?.find((c) => c.id === (run.selectedCandidateId ?? run.source?.id));
export function spriteActionAdopted(run: SpriteRun, actionId: string, adopted: readonly string[]) {
  return (
    adopted.includes(`${run.id}:${run.selectedCandidateId ?? run.source?.id}:${actionId}`) ||
    ((!run.candidates || (run.selectedCandidateId ?? run.source?.id) === run.candidates[0]?.id) &&
      (adopted.includes(run.id) || adopted.includes(`${run.id}:${actionId}`)))
  );
}
type Props = {
  state: SpriteState;
  adopted: readonly string[];
  onPreview: (run: SpriteRun) => void;
  onCommand: (run: SpriteRun, operation: "cancel" | "retry", actionId?: string) => void;
  onOriginal: (asset: ImageAsset) => void;
  onAdjust: (run: SpriteRun) => void;
  onReference: (run: SpriteRun) => void;
  onPlan: (run: SpriteRun) => void;
  onState?: (state: SpriteState) => void;
  onAdopt?:
    | ((run: SpriteRun, actionIds: string[], replace?: boolean) => Promise<void> | void)
    | undefined;
  onImport?: (asset: ImageAsset) => void;
  onUndo?: ((run: SpriteRun) => void) | undefined;
  onLocate?: ((run: SpriteRun, actionId: string) => void) | undefined;
};
export function SpriteResults(props: Props) {
  const { state, onState } = props,
    tr = useAhaTranslation();
  const [opened, setOpened] = useState<string | null>(null),
    [removed, setRemoved] = useState(false),
    [undoIds, setUndoIds] = useState<string[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    const open = (event: Event) => {
      const run = state.runs.find((r) => r.id === (event as CustomEvent<string>).detail);
      if (run) {
        setRemoved(!!run.removedAt);
        setOpened(run.planId ?? run.id);
      }
    };
    window.addEventListener(SPRITE_TASK_OPEN, open);
    return () => window.removeEventListener(SPRITE_TASK_OPEN, open);
  }, [state.runs]);
  const change = async (operation: "remove-run" | "restore-run", runIds: string[]) => {
    if (!runIds.length) return;
    try {
      const next = await drawingApi().spriteCommand({
        operation,
        projectId: state.context?.projectId ?? state.runs[0]!.context.projectId,
        runIds,
      });
      onState?.(next);
      setUndoIds(operation === "remove-run" ? runIds : []);
    } catch (e) {
      setError(String(e));
    }
  };
  const groups = new Map<string, SpriteRun[]>();
  for (const run of state.runs.toReversed().filter((r) => !!r.removedAt === removed)) {
    const key = run.planId ?? run.id;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return (
    <details open className="min-w-0" aria-label={tr("Generation tasks")}>
      <summary className="cursor-pointer text-xs font-semibold">{tr("Generation tasks")}</summary>
      <div className="my-2 flex gap-1">
        <Menu>
          <MenuTrigger render={<Button size="sm" variant="ghost" />}>
            {tr("Manage tasks")}
          </MenuTrigger>
          <ComposerPickerMenuPopup>
            <MenuItem onClick={() => setRemoved((v) => !v)}>
              {tr(removed ? "Back to tasks" : "View removed tasks")}
            </MenuItem>
            {!removed && (
              <MenuItem
                onClick={() =>
                  void change(
                    "remove-run",
                    state.runs
                      .filter(
                        (r) =>
                          !r.removedAt && ["failed", "cancelled", "interrupted"].includes(r.status),
                      )
                      .map((r) => r.id),
                  )
                }
              >
                {tr("Clear failed records")}
              </MenuItem>
            )}
          </ComposerPickerMenuPopup>
        </Menu>
        {!!undoIds.length && (
          <Button size="sm" variant="outline" onClick={() => void change("restore-run", undoIds)}>
            {tr("Undo removal")}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {!groups.size && (
        <p className="text-xs text-muted-foreground">
          {tr(
            "Ask the conversation to prepare a generation plan. Results appear here after confirmation.",
          )}
        </p>
      )}
      <div className="space-y-2">
        {[...groups].map(([id, runs]) => {
          const count = runs.reduce(
              (n, r) =>
                n +
                (r.actions?.length ??
                  r.configuration?.actions.filter((a) => a.enabled).length ??
                  1),
              0,
            ),
            first = runs[0]!,
            title =
              first.input.kind === "character"
                ? tr("Static image")
                : `${tr("Action animation")} · ${count} ${tr("actions")}`;
          return (
            <div key={id}>
              <button
                className="flex w-full items-center gap-2 rounded-lg border p-2 text-left hover:bg-muted/50"
                onClick={() => setOpened(id)}
              >
                {first.source && (
                  <img
                    src={imageUrl(first.source, "thumbnail")}
                    alt=""
                    className="size-10 shrink-0 rounded object-contain"
                  />
                )}
                <span className="min-w-0 flex-1 text-xs">
                  <span className="block truncate font-medium">{title}</span>
                  <span className="text-muted-foreground">
                    {runs.map((r) => tr(r.status)).join(" · ")} ·{" "}
                    {runs.reduce((n, r) => n + (r.candidates?.length ?? (r.source ? 1 : 0)), 0)}{" "}
                    {tr("candidates")}
                  </span>
                </span>
              </button>
              <Dialog
                open={opened === id}
                onOpenChange={(open) => {
                  if (!open) setOpened(null);
                }}
              >
                <DialogPopup className="flex max-h-[90vh] max-w-5xl flex-col overflow-hidden">
                  <DialogHeader>
                    <DialogTitle>{tr("Generation task details")}</DialogTitle>
                  </DialogHeader>
                  <div className="min-h-0 overflow-y-auto p-4">
                    {runs.length > 1 && (
                      <p className="mb-3 text-xs text-muted-foreground">
                        {tr("One image per action")} · {runs.length} {tr("image tasks")}
                      </p>
                    )}
                    {runs.map((run) => (
                      <TaskCandidate
                        key={run.id}
                        {...props}
                        run={run}
                        active={opened === id}
                        onClose={() => setOpened(null)}
                        onRemove={() =>
                          void change(removed ? "restore-run" : "remove-run", [run.id])
                        }
                        removed={removed}
                      />
                    ))}
                  </div>
                </DialogPopup>
              </Dialog>
            </div>
          );
        })}
      </div>
    </details>
  );
}
function TaskCandidate(
  props: Props & {
    run: SpriteRun;
    active: boolean;
    onClose: () => void;
    onRemove: () => void;
    removed: boolean;
  },
) {
  const {
      run,
      adopted,
      onState,
      onAdopt,
      onAdjust,
      onOriginal,
      onCommand,
      onReference,
      onPlan,
      onImport,
      onPreview,
      onClose,
      onRemove,
      removed,
      onUndo,
      onLocate,
    } = props,
    tr = useAhaTranslation();
  const candidate = spriteCandidate(run),
    outputs = run.actions ?? [],
    blocked = candidate
      ? spriteBlockedActions(candidate)
      : new Set<string>(run.status === "needs-adjustment" ? outputs.map((a) => a.action.id) : []);
  const [actionId, setActionId] = useState(outputs[0]?.action.id ?? ""),
    [selection, setSelection] = useState<string[]>(() =>
      outputs
        .filter((a) => !blocked.has(a.action.id) && !spriteActionAdopted(run, a.action.id, adopted))
        .map((a) => a.action.id),
    ),
    [frame, setFrame] = useState(0),
    [playing, setPlaying] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [added, setAdded] = useState(0);
  const output = outputs.find((a) => a.action.id === actionId) ?? outputs[0],
    frames = output?.frames ?? run.frames;
  const animation = run.input.kind === "animation",
    active = ["queued", "running", "processing"].includes(run.status);
  const resetSelection = useEffectEvent(() => {
    setFrame(0);
    setPlaying(false);
    setActionId(run.actions?.[0]?.action.id ?? "");
    setSelection(
      (run.actions ?? [])
        .filter(
          (a) =>
            !(candidate && spriteBlockedActions(candidate).has(a.action.id)) &&
            !spriteActionAdopted(run, a.action.id, adopted),
        )
        .map((a) => a.action.id),
    );
  });
  useEffect(
    () => resetSelection(),
    [run.selectedCandidateId, candidate?.processingVersionId, candidate?.version],
  );
  useEffect(() => {
    if (!props.active || !playing || !frames.length) return;
    const timer = setInterval(
      () =>
        setFrame((i) => {
          if (i + 1 >= frames.length && output && !output.action.loop) {
            setPlaying(false);
            return i;
          }
          return (i + 1) % frames.length;
        }),
      1000 / (output?.action.fps ?? run.context.fps),
    );
    return () => clearInterval(timer);
  }, [props.active, playing, frames.length, output, run.context.fps]);
  const acceptAnalysis = useEffectEvent((next: SpriteState) => onState?.(next));
  const analysisSourceId = candidate?.id,
    analysisVersion = candidate?.version ?? 0,
    hasAnalysis = candidate?.analysis?.algorithmVersion === SPRITE_ANALYSIS_VERSION,
    analysisProject = run.context.projectId;
  useEffect(() => {
    if (!props.active || !animation || !analysisSourceId || hasAnalysis) return;
    let live = true;
    setBusy(true);
    void drawingApi()
      .spriteCommand({
        operation: "analyze-candidate",
        projectId: analysisProject,
        runId: run.id,
        candidateId: analysisSourceId,
        version: analysisVersion,
      })
      .then((next) => {
        if (live) {
          setBusy(false);
          if (next) acceptAnalysis(next);
        }
      })
      .catch((e) => {
        if (live) {
          setBusy(false);
          setError(String(e));
        }
      });
    return () => {
      live = false;
    };
  }, [
    props.active,
    animation,
    analysisSourceId,
    analysisVersion,
    hasAnalysis,
    analysisProject,
    run.id,
  ]);
  const choose = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      const next = await drawingApi().spriteCommand({
        operation: "select-candidate",
        projectId: run.context.projectId,
        runId: run.id,
        candidateId: id,
      });
      onState?.(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const add = async (ids: string[], replace = false) => {
    if (!onAdopt) return;
    setBusy(true);
    setError("");
    try {
      await onAdopt(run, ids, replace);
      setAdded(ids.length);
      setSelection([]);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const issues = candidate?.issues ?? [],
    categories = new Map<string, number>();
  for (const issue of issues) categories.set(issue.code, (categories.get(issue.code) ?? 0) + 1);
  const adoptedCount = outputs.filter((a) => spriteActionAdopted(run, a.action.id, adopted)).length;
  const available =
    !!run.context.threadId &&
    (props.state.threadIds === undefined || props.state.threadIds.includes(run.context.threadId));
  return (
    <article
      data-testid={`sprite-result-${run.id}`}
      className="mb-4 space-y-3 rounded-xl border bg-background/30 p-3 last:mb-0"
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">
            {animation
              ? `${tr("Action animation")} · ${outputs.length || run.configuration?.actions.length || 0} ${tr("actions")}`
              : tr("Static image")}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {new Date(run.createdAt).toLocaleString()} · {tr("Image generation")}:{" "}
            {tr(run.imageStatus ?? run.status)} · {run.context.model}
          </p>
          {animation && (
            <p className="mt-1 text-xs">
              {tr("Frame inspection")}:{" "}
              {blocked.size ? tr("Needs layout correction") : tr(run.status)} ·{" "}
              {tr("Added actions")}: {adoptedCount}/{outputs.length}
            </p>
          )}
        </div>
        <Menu>
          <MenuTrigger render={<Button size="sm" variant="outline" />}>{tr("More")}</MenuTrigger>
          <ComposerPickerMenuPopup align="end">
            {run.source && (
              <MenuItem onClick={() => onOriginal(run.source!)}>
                {tr("View original sheet")}
              </MenuItem>
            )}
            {run.planId && (
              <MenuItem
                onClick={() => {
                  onClose();
                  onPlan(run);
                }}
              >
                {tr("View generation plan")}
              </MenuItem>
            )}
            {run.source && onImport && (
              <MenuItem onClick={() => onImport(run.source!)}>
                {tr("Import as image source")}
              </MenuItem>
            )}
            {run.source && (
              <MenuItem
                disabled={!available}
                onClick={() => {
                  onClose();
                  onReference(run);
                }}
              >
                {tr("Add to plan references")}
              </MenuItem>
            )}
            {!active && (
              <MenuItem
                disabled={!available}
                onClick={() => {
                  onClose();
                  onCommand(run, "retry");
                }}
              >
                {tr("Edit before generating again")}
              </MenuItem>
            )}
            {!active && (
              <MenuItem onClick={onRemove}>
                {tr(removed ? "Restore record" : "Remove record")}
              </MenuItem>
            )}
          </ComposerPickerMenuPopup>
        </Menu>
      </header>
      {run.candidates && run.candidates.length > 1 && (
        <div className="flex gap-2 overflow-x-auto" aria-label={tr("Candidate")}>
          {run.candidates.map((c, i) => (
            <button
              key={c.id}
              disabled={busy}
              aria-pressed={c.id === candidate?.id}
              className={`shrink-0 rounded-lg border p-1 text-xs ${c.id === candidate?.id ? "ring-2 ring-primary" : ""}`}
              onClick={() => void choose(c.id)}
            >
              <img
                src={imageUrl(c.source, "thumbnail")}
                alt={`${tr("Candidate")} ${i + 1}`}
                className="size-16 object-contain"
              />
              {i + 1} · {tr(c.status)}
            </button>
          ))}
        </div>
      )}
      {candidate?.analysis && animation && (
        <p className="text-xs text-muted-foreground">
          {tr("Planned frames")}: {candidate.analysis.plannedFrames} · {tr("Grid cells")}:{" "}
          {candidate.analysis.cells} · {tr("Non-empty cells")}: {candidate.analysis.nonEmptyCells} ·{" "}
          {tr("Possible subjects")}: {candidate.analysis.suspectedSubjects ?? tr("Uncertain")} ·{" "}
          {tr("Correction frames")}: {run.frames.length}
        </p>
      )}
      {animation && blocked.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-orange-500/40 bg-orange-500/10 p-3 text-xs">
          <div>
            <p className="font-medium">
              {tr("The image layout needs review before adding affected actions.")}
            </p>
            <p className="mt-1 text-muted-foreground">
              {[...categories].map(([code, n]) => `${tr(`layout-${code}`)} ${n}`).join(" · ") ||
                tr("Review the original image and frame boundaries.")}
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => {
              onClose();
              onAdjust(run);
            }}
          >
            {tr("Correct frame slicing")}
          </Button>
        </div>
      )}
      {animation && frames.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-[12rem_minmax(0,1fr)]">
          <div className="space-y-1 rounded-lg border p-2" aria-label={tr("Actions")}>
            {outputs.map((a) => {
              const picked = spriteActionAdopted(run, a.action.id, adopted),
                invalid = blocked.has(a.action.id);
              return (
                <div
                  key={a.action.id}
                  className={`flex items-center gap-1 rounded p-1 ${output?.action.id === a.action.id ? "bg-primary/10" : ""}`}
                >
                  <input
                    type="checkbox"
                    aria-label={`${tr("Select action")}: ${a.action.name}`}
                    disabled={busy || picked || invalid}
                    checked={selection.includes(a.action.id) && !picked && !invalid}
                    onChange={(e) =>
                      setSelection((v) =>
                        e.target.checked
                          ? [...v, a.action.id]
                          : v.filter((id) => id !== a.action.id),
                      )
                    }
                  />
                  <button
                    className="min-w-0 flex-1 text-left text-xs"
                    aria-pressed={output?.action.id === a.action.id}
                    onClick={() => {
                      setActionId(a.action.id);
                      setFrame(0);
                    }}
                  >
                    <span className="block truncate font-medium">{a.action.name}</span>
                    <span className="text-muted-foreground">
                      {a.frames.length} {tr("frames")} ·{" "}
                      {tr(
                        picked ? "Adopted" : invalid ? "Needs layout correction" : "Ready to add",
                      )}
                    </span>
                  </button>
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`${a.action.name} ${tr("Action options")}`}
                        />
                      }
                    >
                      ⋯
                    </MenuTrigger>
                    <ComposerPickerMenuPopup>
                      <MenuItem
                        disabled={!available}
                        onClick={() => {
                          onClose();
                          onCommand(run, "retry", a.action.id);
                        }}
                      >
                        {tr("Regenerate this action")}
                      </MenuItem>
                      {picked && (
                        <MenuItem
                          disabled={invalid || busy}
                          onClick={() => void add([a.action.id], true)}
                        >
                          {tr("Replace with current correction")}
                        </MenuItem>
                      )}
                      {picked && onLocate && (
                        <MenuItem
                          onClick={() => {
                            onClose();
                            onLocate(run, a.action.id);
                          }}
                        >
                          {tr("Go to action")}
                        </MenuItem>
                      )}
                    </ComposerPickerMenuPopup>
                  </Menu>
                </div>
              );
            })}
          </div>
          <div className="min-w-0 rounded-lg border bg-muted/20 p-3">
            <div className="flex min-h-52 items-center justify-center rounded bg-[repeating-conic-gradient(#80808016_0%_25%,transparent_0%_50%)] bg-size-[20px_20px]">
              {frames[Math.min(frame, frames.length - 1)] && (
                <img
                  src={imageUrl(frames[Math.min(frame, frames.length - 1)]!)}
                  alt={output?.action.name ?? run.context.action}
                  className="h-56 max-w-full object-contain [image-rendering:pixelated]"
                />
              )}
            </div>
            <div className="my-2 flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => setPlaying((v) => !v)}>
                {tr(playing ? "Pause" : "Play")}
              </Button>
              <input
                className="min-w-0 flex-1"
                aria-label={tr("Frame")}
                type="range"
                min={0}
                max={Math.max(0, frames.length - 1)}
                value={frame}
                onChange={(e) => {
                  setPlaying(false);
                  setFrame(Number(e.target.value));
                }}
              />
              <span className="text-xs tabular-nums">
                {frame + 1}/{frames.length} · {output?.action.fps ?? run.context.fps} FPS
              </span>
            </div>
            <div className="flex gap-1 overflow-x-auto">
              {frames.map((f, i) => (
                <button
                  key={`${f.id}:${i}`}
                  aria-label={`${tr("Frame")} ${i + 1}`}
                  aria-pressed={frame === i}
                  className={`shrink-0 rounded border ${frame === i ? "ring-2 ring-primary" : ""}`}
                  onClick={() => {
                    setPlaying(false);
                    setFrame(i);
                  }}
                >
                  <img src={imageUrl(f, "thumbnail")} alt="" className="size-12 object-contain" />
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : !animation && run.source ? (
        <button
          aria-label={tr("View image")}
          className="block w-full rounded-lg border bg-muted/20 p-4"
          onClick={() => onOriginal(run.source!)}
        >
          <img
            src={imageUrl(run.source)}
            alt={tr("Static image")}
            className="mx-auto max-h-96 object-contain"
          />
          <span className="text-xs">{tr("View image")}</span>
        </button>
      ) : null}
      {(run.error || error) && (
        <p role="alert" className="text-xs text-destructive">
          {error || tr(spriteGenerationFailureMessage(run.error!))}
        </p>
      )}
      {run.error && (
        <details className="text-xs">
          <summary>{tr("Error details")}</summary>
          <p>{run.error}</p>
        </details>
      )}
      {!!issues.length && (
        <details className="text-xs">
          <summary className="cursor-pointer">
            {tr("Inspection details")} ·{" "}
            {[...categories].map(([code, n]) => `${tr(`layout-${code}`)} ${n}`).join(" · ")}
          </summary>
          <div className="mt-2 max-h-48 space-y-1 overflow-auto">
            {issues.map((issue, i) => (
              <button
                key={i}
                className="block text-left"
                onClick={() => {
                  if (issue.actionId) setActionId(issue.actionId);
                  if (issue.frameIndex !== null) setFrame(issue.frameIndex);
                }}
              >
                {issue.actionId ?? tr("Whole image")} · {tr(`layout-${issue.code}`)}
                {issue.frameIndex !== null ? ` · ${tr("Frame")} ${issue.frameIndex + 1}` : ""}
              </button>
            ))}
          </div>
        </details>
      )}
      {!candidate?.issues && !!run.warnings.length && (
        <details className="text-xs">
          <summary>{tr("Historical inspection details")}</summary>
          {run.warnings.map((w, i) => (
            <p key={i}>{tr(w)}</p>
          ))}
        </details>
      )}
      {animation && (
        <footer className="sticky bottom-0 flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-[var(--color-background-elevated-primary)] p-3">
          <div className="text-xs">
            {added
              ? `${tr("Added actions")}: ${added}`
              : `${tr("Selected actions")}: ${selection.filter((id) => !blocked.has(id) && !spriteActionAdopted(run, id, adopted)).length}`}
            {added > 0 && onUndo && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  onUndo(run);
                  setAdded(0);
                }}
              >
                {tr("Undo")}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                onClose();
                onAdjust(run);
              }}
            >
              {tr("Correct frame slicing")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onClose();
                onPreview(run);
              }}
            >
              {tr("Open in frame editor")}
            </Button>
            {onAdopt && (
              <Button
                size="sm"
                disabled={
                  busy ||
                  !selection.some(
                    (id) => !blocked.has(id) && !spriteActionAdopted(run, id, adopted),
                  )
                }
                onClick={() =>
                  void add(
                    selection.filter(
                      (id) => !blocked.has(id) && !spriteActionAdopted(run, id, adopted),
                    ),
                  )
                }
              >
                {tr("Add selected actions")} (
                {
                  selection.filter(
                    (id) => !blocked.has(id) && !spriteActionAdopted(run, id, adopted),
                  ).length
                }
                )
              </Button>
            )}
          </div>
        </footer>
      )}
      {active && (
        <Button size="sm" variant="outline" onClick={() => onCommand(run, "cancel")}>
          {tr("Cancel generation")}
        </Button>
      )}
      {busy && (
        <p role="status" className="text-xs">
          {tr("Processing…")}
        </p>
      )}
    </article>
  );
}
