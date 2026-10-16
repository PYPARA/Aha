import { useEffect, useMemo, useState } from "react";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { FrameThumbnail } from "./SpritePreview";
import {
  groupSpriteSheetRows,
  type SpriteSource,
  type SpriteFrame,
  type SpriteSheetRow,
} from "./spriteModel";
import { visibleSpriteFrameIds } from "./spriteFiles";

export function SpriteSheetActionsDialog({
  source,
  frames,
  onClose,
  onApply,
  actionDefaults,
}: {
  source: SpriteSource;
  frames: SpriteFrame[];
  actionDefaults?: readonly { name: string; frameCount: number }[] | undefined;
  onClose: () => void;
  onApply: (rows: SpriteSheetRow[]) => void;
}) {
  const tr = useAhaTranslation();
  const allRows = useMemo(() => groupSpriteSheetRows(frames), [frames]);
  const [visible, setVisible] = useState<Set<string> | null>(null);
  const [skipEmpty, setSkipEmpty] = useState(!actionDefaults);
  const [names, setNames] = useState<Record<number, string>>({});
  const [enabled, setEnabled] = useState<Record<number, boolean>>({});
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void visibleSpriteFrameIds(source, frames)
      .then((ids) => {
        if (alive) setVisible(ids);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [source, frames]);
  const rows = allRows.map((row) => {
    const valid = row.frames.slice(
      0,
      actionDefaults?.[row.row - 1]?.frameCount ?? row.frames.length,
    );
    const selectedFrames = skipEmpty && visible ? valid.filter((f) => visible.has(f.id)) : valid;
    return {
      ...row,
      name: names[row.row] ?? actionDefaults?.[row.row - 1]?.name ?? row.name,
      frames: selectedFrames,
      enabled: selectedFrames.length > 0 && (enabled[row.row] ?? true),
    };
  });
  const selected = rows.filter((row) => row.enabled);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{tr("Split rows into actions")}</DialogTitle>
          <DialogDescription>
            {tr(
              "Each row becomes a separate action. Name the actions and choose the rows to import. Existing animations are preserved.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 py-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={skipEmpty}
              onChange={(e) => setSkipEmpty(e.target.checked)}
            />
            {tr("Skip fully transparent frames")}
          </label>
          {!visible && !error && (
            <p role="status" className="text-sm">
              {tr("Checking empty frames…")}
            </p>
          )}
          {rows.map((row) => (
            <div key={row.row} className="rounded border p-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={row.enabled}
                    disabled={!row.frames.length}
                    onChange={(e) => setEnabled((p) => ({ ...p, [row.row]: e.target.checked }))}
                  />
                  {tr("Row")} {row.row}
                </label>
                <input
                  className="h-8 min-w-0 flex-1 rounded border bg-background px-2 text-sm"
                  aria-label={`${tr("Action name")} ${row.row}`}
                  value={row.name}
                  onChange={(e) => setNames((p) => ({ ...p, [row.row]: e.target.value }))}
                  maxLength={200}
                />
                <span className="text-xs text-muted-foreground">
                  {row.frames.length} / {allRows[row.row - 1]!.frames.length} {tr("frames")}
                </span>
              </div>
              <div className="mt-2 flex gap-1 overflow-x-auto">
                {row.frames.map((f) => (
                  <FrameThumbnail key={f.id} source={source} frame={f} />
                ))}
              </div>
            </div>
          ))}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {tr(error)}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tr("Cancel")}
          </Button>
          <Button
            disabled={!visible || !selected.length || selected.some((row) => !row.name.trim())}
            onClick={() => {
              try {
                onApply(rows);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            {tr("Create actions")} ({selected.length})
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
