import type { ImageBatchAttempt, ImageBatchState } from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { StatusChip } from "../ui/status-chip";

/** Each task's most recent attempt across executions, so rows can show where the task stands. */
export function latestTaskAttempts(batch: ImageBatchState) {
  const latest = new Map<string, ImageBatchAttempt>();
  for (const execution of batch.executions)
    for (const attempt of execution.attempts) latest.set(attempt.taskId, attempt);
  return latest;
}

export const attemptInFlight = (status: string) =>
  ["prepared", "queued", "running", "saving"].includes(status);

const TONES: Record<string, { text: string; dot: string }> = {
  succeeded: { text: "text-success", dot: "bg-success" },
  partial: { text: "text-warning", dot: "bg-warning" },
  uncertain: { text: "text-warning", dot: "bg-warning" },
  interrupted: { text: "text-warning", dot: "bg-warning" },
  failed: { text: "text-destructive", dot: "bg-destructive" },
};

export function TaskStatus({ attempt }: { attempt: ImageBatchAttempt | undefined }) {
  const tr = useAhaTranslation();
  if (!attempt)
    return <span className="text-ui-xs text-muted-foreground">{tr("Not generated")}</span>;
  const tone = TONES[attempt.status] ?? { text: "text-muted-foreground", dot: "bg-current" };
  return (
    <StatusChip
      className={"text-ui-xs " + tone.text}
      dotClassName={tone.dot}
      pulse={attempt.status === "running" || attempt.status === "saving"}
    >
      {tr(attempt.status)}
      {!attemptInFlight(attempt.status) && attempt.status !== "cancelled"
        ? ` ${attempt.outputs}/${attempt.parameters.n}`
        : ""}
    </StatusChip>
  );
}
