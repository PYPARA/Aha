import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Alert } from "../ui/alert";
import { spriteContext } from "./spriteModel";
import { drawingApi, uploadDrawingImage } from "../drawing/useDrawing";
import type { SpriteWorkbenchController } from "./SpriteWorkbench";
type Props = { controller: SpriteWorkbenchController };
export function SpriteSourceProperties({ controller: c }: Props) {
  return (
    <p className="p-3 text-ui-sm text-muted-foreground">
      {c.tr(
        "Source images use the same repair editor as candidates. Confirm slicing, organize actions, then align frames.",
      )}
    </p>
  );
}
/** Every source resolves to its existing task first. Import is idempotent and never invokes a provider. */
export function SpriteSourceEditor({ controller: c }: Props) {
  const source = c.source!,
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    started = useRef(false),
    activeSource = useRef<string | null>(source.id);
  const open = async () => {
    if (started.current) return;
    started.current = true;
    setBusy(true);
    setError("");
    try {
      const existing = c.state.runs.find(
        (r) =>
          r.input.kind === "animation" &&
          ((!!source.assetId && r.source?.id === source.assetId) ||
            (!!source.origin?.runId && r.id === source.origin.runId) ||
            (!!source.assetId && r.importOrigin?.sourceAssetId === source.assetId)),
      );
      if (existing?.source && existing.candidates?.length) {
        c.openSlicing(existing);
        return;
      }
      const owner = c.current.current.id;
      const asset = await uploadDrawingImage(source.blob, source.name);
      if (
        c.current.current.id !== owner ||
        c.deletionStarted.current ||
        activeSource.current !== source.id
      )
        return;
      if (!source.assetId)
        c.update((p) => ({
          ...p,
          sources: p.sources.map((s) => (s.id === source.id ? { ...s, assetId: asset.id } : s)),
        }));
      const context = {
        ...spriteContext(c.current.current),
        selection: { phase: "actions" as const, actionId: c.current.current.selectedActionId },
      };
      const frozen = [
        ...c.project.provenance,
        ...(c.project.actionVersions ?? []).flatMap((v) => v.provenance),
      ]
        .flatMap((p) => p.processingSnapshots ?? [])
        .find((s) => s.sourceAssetId === source.assetId);
      const next = await drawingApi().spriteCommand({
        slice: frozen?.configuration,
        operation: "inspect-source",
        projectId: owner,
        context,
        references: [
          { referenceId: `project:${asset.id}`, asset, role: "reference", actionId: null },
        ],
      });
      if (c.current.current.id !== owner || activeSource.current !== source.id) return;
      c.setState(next);
      const run = next.runs.find(
        (r) =>
          r.importOrigin?.sourceAssetId === asset.id &&
          r.importOrigin.targetActionIds.includes(context.selection.actionId),
      );
      if (run) c.openSlicing(run);
      else throw new Error("Imported source could not be opened. Retry reading task results.");
    } catch (e) {
      if (activeSource.current !== source.id) return;
      started.current = false;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (activeSource.current === source.id) setBusy(false);
    }
  };
  const enter = useEffectEvent(open);
  useEffect(() => {
    activeSource.current = source.id;
    started.current = false;
    void enter();
    return () => {
      activeSource.current = null;
    };
  }, [source.id]);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-4">
      <h2 className="font-medium">{source.name}</h2>
      {error ? (
        <Alert variant="error">{c.tr(error)}</Alert>
      ) : (
        <p role="status">{c.tr("Opening frame repair…")}</p>
      )}
      <Button disabled={busy} onClick={() => void open()}>
        {c.tr("Repair frames")}
      </Button>
      <Button variant="ghost" onClick={() => c.setSourceId("")}>
        {c.tr("Back to actions")}
      </Button>
    </div>
  );
}
