import { useEffect, useRef, useState } from "react";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { renderSpriteAtlasPreview, type SpriteExportMode } from "./spriteFiles";
import type { SpriteProject } from "./spriteModel";
export function SpriteExportPreview({
  project,
  actionIds,
  mode,
  columns,
  gap,
}: {
  project: SpriteProject;
  actionIds: string[];
  mode: SpriteExportMode;
  columns: number;
  gap: number;
}) {
  const tr = useAhaTranslation(),
    ref = useRef<HTMLCanvasElement>(null),
    [size, setSize] = useState(""),
    [error, setError] = useState("");
  const key = actionIds.join("|");
  useEffect(() => {
    let active = true;
    setError("");
    void renderSpriteAtlasPreview(project, key.split("|"), mode, columns, gap)
      .then((atlas) => {
        if (!active) return;
        const canvas = ref.current;
        if (!canvas) return;
        if (!atlas) {
          canvas.width = 0;
          setSize("");
          return;
        }
        canvas.width = atlas.width;
        canvas.height = atlas.height;
        canvas.getContext("2d")!.drawImage(atlas, 0, 0);
        setSize(`${atlas.width} × ${atlas.height}`);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [project, key, mode, columns, gap]);
  return (
    <section className="space-y-3 p-4">
      <p className="text-ui-sm text-muted-foreground">
        {size ? `${tr("Atlas size")}: ${size}` : tr("Preparing preview…")}
      </p>
      <p className="text-xs text-muted-foreground">
        {tr(
          mode === "atlas"
            ? "Preview shows the first action atlas."
            : mode === "sequence"
              ? "Preview shows the first exported frame."
              : "Frames are assembled locally in action and frame order.",
        )}
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {tr(error)}
        </p>
      )}
      <div className="max-h-[60vh] overflow-auto">
        <canvas
          ref={ref}
          className="sb-checker max-w-full"
          style={{
            imageRendering: project.renderSpec?.mode === "illustration" ? "auto" : "pixelated",
          }}
        />
      </div>
    </section>
  );
}
