import { Button } from "../ui/button";
import { StatusChip } from "../ui/status-chip";
import { SpriteRetryButton } from "./SpriteRetryButton";
import { spriteLatestAttempts } from "./spriteGenerationAttempts";
import { spriteCombinedActionRun } from "./spriteWorkflowModel";
import { spriteCandidate } from "./spriteCandidate";
import { spriteAdoption } from "./spriteAdoption";
import { drawingApi } from "../drawing/useDrawing";
import type { SpriteRun } from "@synara/contracts";
import type { SpriteWorkbenchController } from "./SpriteWorkbench";
export function SpriteTaskQueue({ controller: c }: { controller: SpriteWorkbenchController }) {
  const { tr, state } = c;
  const active = state.runs.filter(
    (r) => !r.removedAt && ["queued", "running", "processing"].includes(r.status),
  ).length;
  const latest = spriteLatestAttempts(state.runs).filter((r) => !r.removedAt);
  const groups = new Map<string, SpriteRun[]>();
  for (const run of latest) {
    const segment = run.configuration?.segment;
    const key = segment
      ? `${run.configuration?.sequenceId ?? run.planId ?? run.id}:${segment.actionId}`
      : run.id;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  const pending = c.actionCandidates.filter(
    (entry) => spriteAdoption(entry.run, entry.actionId, c.project).status !== "current",
  ).length;
  const row = (run: SpriteRun) => {
    const complete =
      run.input.kind === "animation" ? spriteCombinedActionRun(run, state.runs) : undefined;
    const candidate = spriteCandidate(run);
    return (
      <div key={run.id} className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <div className="min-w-40 flex-1">
          <p className="text-ui">
            {run.context.action} ·{" "}
            {tr(run.input.kind === "character" ? "Static image" : "Action animation")}
          </p>
          <p className="text-ui-sm text-muted-foreground">
            {run.submissionProviderName ?? run.context.providerId} · {run.context.model}
          </p>
        </div>
        <StatusChip
          className={run.status === "failed" ? "text-destructive" : "text-muted-foreground"}
        >
          {tr(
            run.submissionPhase === "uncertain"
              ? "Verifying submission"
              : candidate?.status === "failed" && run.source
                ? "Frame processing failed"
                : run.status,
          )}
        </StatusChip>
        {complete && candidate?.frames.length ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              c.setQueueVisible(false);
              c.safe(() => c.inspectCandidate(complete));
            }}
          >
            {tr("Review candidate")}
          </Button>
        ) : candidate && run.input.kind === "animation" ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              c.setQueueVisible(false);
              c.openSlicing(run);
            }}
          >
            {tr("Correct frame slicing")}
          </Button>
        ) : null}
        {run.input.kind === "character" && run.source && (
          <>
            <Button size="sm" onClick={() => c.safe(() => c.useCharacterCandidate(run))}>
              {tr("Use as character reference")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                c.setOriginalImage(run.source);
              }}
            >
              {tr("View original image")}
            </Button>
          </>
        )}
        {run.source && run.input.kind === "animation" && (
          <>
            <Button size="sm" variant="ghost" onClick={() => c.openSlicing(run)}>
              {tr("Adjust slicing and alignment")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => c.setOriginalImage(run.source)}>
              {tr("View original image")}
            </Button>
            {candidate?.status === "failed" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  c.safe(async () => {
                    c.setState(
                      await drawingApi().spriteCommand({
                        operation: "reprocess-candidate",
                        projectId: c.project.id,
                        runId: run.id,
                        candidateId: candidate.id,
                        version: candidate.version ?? 0,
                      }),
                    );
                  })
                }
              >
                {tr("Reprocess from original · free")}
              </Button>
            )}
          </>
        )}
        {run.planId && run.context.threadId && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => c.safe(() => c.openPlanConversation(run.context.threadId!, run.planId!))}
          >
            {tr("View plan")}
          </Button>
        )}
        {["queued", "running", "processing"].includes(run.status) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => c.safe(() => c.runCommand(run, "cancel"))}
          >
            {tr("Cancel")}
          </Button>
        )}
        {run.submissionPhase === "uncertain" && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              c.safe(async () =>
                c.setState(
                  await drawingApi().spriteCommand({ operation: "get", projectId: c.project.id }),
                ),
              )
            }
          >
            {tr("Check submission status")}
          </Button>
        )}
        {run.error && <p className="w-full text-ui-sm text-destructive">{tr(run.error)}</p>}
      </div>
    );
  };
  return (
    <section className="sb-queue" aria-label={tr("Generation tasks")}>
      {c.queueVisible && (
        <div className="sb-queue-content">
          <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
            <SpriteRetryButton
              runs={latest}
              allRuns={state.runs}
              onState={c.setState}
              onModify={(run) => c.safe(() => c.runCommand(run, "retry"))}
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                c.safe(async () => {
                  const ids = latest
                    .filter((r) => ["failed", "cancelled", "interrupted"].includes(r.status))
                    .map((r) => r.id);
                  if (ids.length)
                    c.setState(
                      await drawingApi().spriteCommand({
                        operation: "remove-run",
                        projectId: c.project.id,
                        runIds: ids,
                      }),
                    );
                })
              }
            >
              {tr("Clear failed records")}
            </Button>
          </div>
          {c.taskReadStatus === "ready" && !latest.length && (
            <p className="p-4 text-ui-sm text-muted-foreground">{tr("No generation tasks yet.")}</p>
          )}
          {[...groups.entries()].toReversed().map(([key, runs]) =>
            runs.length === 1 ? (
              row(runs[0]!)
            ) : (
              <div key={key} className="border-b px-4 py-3">
                <div className="flex flex-wrap items-center gap-2 text-ui-sm">
                  <span className="flex-1 font-medium">
                    {runs[0]!.context.action} · {runs.length} {tr("segments")}
                  </span>
                  <span className="text-muted-foreground">
                    {runs.filter((r) => ["ready", "needs-adjustment"].includes(r.status)).length}/
                    {runs.length} {tr("segments ready")}
                  </span>
                  {spriteCombinedActionRun(runs[0]!, state.runs) && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        c.setQueueVisible(false);
                        c.safe(() => c.inspectCandidate(runs[0]!));
                      }}
                    >
                      {tr("Review candidate")}
                    </Button>
                  )}
                </div>
                <details className="mt-2 text-ui-sm">
                  <summary>{tr("Segment tasks")}</summary>
                  {runs.map(row)}
                </details>
              </div>
            ),
          )}
          {state.runs.length > latest.length && (
            <details className="p-3">
              <summary className="text-ui-sm text-muted-foreground">
                {tr("Earlier attempts and removed tasks")}
              </summary>
              {state.runs
                .filter((r) => !latest.some((l) => l.id === r.id))
                .toReversed()
                .map((r) =>
                  r.removedAt ? (
                    <div key={r.id} className="flex items-center gap-2 p-2 text-ui-sm">
                      <span className="flex-1">
                        {r.context.action} · {tr(r.status)}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          c.safe(async () =>
                            c.setState(
                              await drawingApi().spriteCommand({
                                operation: "restore-run",
                                projectId: c.project.id,
                                runIds: [r.id],
                              }),
                            ),
                          )
                        }
                      >
                        {tr("Restore task")}
                      </Button>
                    </div>
                  ) : (
                    row(r)
                  ),
                )}
            </details>
          )}
        </div>
      )}
      <div className="sb-footer-note">
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={c.queueVisible}
          onClick={() => c.setQueueVisible(!c.queueVisible)}
        >
          {tr("Generation tasks")} ·{" "}
          {c.taskReadStatus === "ready" ? (
            <>
              {active} {tr("running")} · {pending} {tr("candidates")}
            </>
          ) : (
            tr(
              c.taskReadStatus === "loading"
                ? "Loading task results…"
                : c.taskReadStatus === "partial"
                  ? "Task results partially recovered"
                  : "Task results unavailable",
            )
          )}
          {latest.some((r) => r.status === "failed")
            ? ` · ${latest.filter((r) => r.status === "failed").length} ${tr("failed")}`
            : ""}
        </Button>
        <span className="ml-auto hidden text-ui-sm text-muted-foreground sm:inline">
          {tr("New results remain candidates until adopted.")}
        </span>
      </div>
    </section>
  );
}
