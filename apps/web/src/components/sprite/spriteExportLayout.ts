import { safeFilename, type SpriteProject } from "./spriteModel";

export type SpriteExportMode = "combined" | "atlas" | "sequence";
/** One layout is shared by the preview, generated PNGs, metadata and file list. */
export function spriteExportLayout(
  project: SpriteProject,
  ids: readonly string[],
  mode: SpriteExportMode,
  columns: number,
  gap: number,
) {
  if (
    !Number.isInteger(columns) ||
    columns < 1 ||
    columns > 64 ||
    !Number.isInteger(gap) ||
    gap < 0 ||
    gap > 128
  )
    throw new Error("Invalid atlas columns or spacing.");
  const actions = project.actions.filter((a) => ids.includes(a.id));
  if (!actions.length) return null;
  for (const action of actions)
    if (!action.frames.length) throw new Error(`Action ${action.name} has no frames.`);
  let firstRow = 0;
  const entries = actions.map((action, index) => {
    const prefix = `${String(index + 1).padStart(2, "0")}-${safeFilename(action.name)}`;
    const cols = Math.min(columns, action.frames.length),
      rows = Math.ceil(action.frames.length / cols),
      start = mode === "combined" ? firstRow : 0;
    firstRow += rows;
    return {
      action,
      prefix,
      cols,
      rows,
      frames: action.frames.map((frame, i) => ({
        frame,
        x: (i % cols) * (project.width + gap),
        y: (start + Math.floor(i / cols)) * (project.height + gap),
        file: `${prefix}/${String(i + 1).padStart(4, "0")}.png`,
      })),
    };
  });
  return {
    entries,
    cols: Math.min(columns, Math.max(...actions.map((a) => a.frames.length))),
    rows: firstRow,
    files: [
      ...entries.flatMap((e) =>
        mode === "sequence"
          ? e.frames.map((f) => f.file)
          : mode === "atlas"
            ? [`${e.prefix}.png`]
            : [],
      ),
      ...(mode === "combined" ? ["atlas.png"] : []),
      "animation.json",
    ],
  };
}
