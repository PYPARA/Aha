import { Button } from "../ui/button";
import { useState } from "react";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Checkbox } from "../ui/checkbox";
import { StatusChip } from "../ui/status-chip";
import { Alert } from "../ui/alert";
import { PlusIcon, HistoryIcon, FolderIcon, ChatBubblePlusIcon } from "~/lib/icons";
import { SpriteNumberField } from "./SpriteNumberField";
import { SpriteSelect } from "./SpriteSelect";
import { SpriteThumbnail } from "./SpritePreview";
import { DrawingModelPicker } from "../drawing/DrawingPickers";
import { drawingApi } from "../drawing/useDrawing";
import { spriteCandidate } from "./spriteCandidate";
import { spriteCandidateStructuralErrors } from "./spriteWorkbenchModel";
import { spriteAdoption } from "./spriteAdoption";
import { uuid, type SpriteFrame } from "./spriteModel";
import { cropSpriteFrameSource } from "./spriteFiles";
import { spriteImageInput } from "./spriteImageInput";
import type { SpriteWorkbenchController } from "./SpriteWorkbench";
type Props = { controller: SpriteWorkbenchController };

export function ObjectNavigation({ controller: c }: Props) {
  const { tr, project, stage } = c;
  return (
    <div className="sb-side-content">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-ui-sm font-medium">
          {tr(
            stage === "character"
              ? "Character reference"
              : stage === "export"
                ? "Export actions"
                : "Actions",
          )}
        </h2>
        {stage === "actions" && (
          <Button
            size="icon"
            variant="ghost"
            aria-label={tr("Add action")}
            onClick={() => {
              const a = {
                id: uuid(),
                name: `action-${project.actions.length + 1}`,
                fps: 12,
                loop: true,
                frames: [],
              };
              c.update((p) => ({ ...p, actions: [...p.actions, a], selectedActionId: a.id }));
              c.resetActionPreview();
            }}
          >
            <PlusIcon />
          </Button>
        )}
      </div>
      {stage === "character" ? (
        <>
          <StatusChip className="text-muted-foreground">
            {tr(project.canonical ? "Character approved" : "Character awaiting approval")}
          </StatusChip>
          <p className="mt-3 text-ui-sm text-muted-foreground">
            {tr("New actions use the approved reference.")}
          </p>
          <Button variant="outline" className="mt-4" onClick={() => c.setMaterialsVisible(true)}>
            {tr("Choose existing image")}
          </Button>
          <Button variant="ghost" onClick={() => c.safe(() => c.prepareGeneration("character"))}>
            {tr("Generate character")}
          </Button>
        </>
      ) : (
        project.actions.map((a) =>
          stage === "export" ? (
            <label key={a.id} className="flex items-start gap-3 rounded-md p-2 text-ui">
              <Checkbox
                checked={c.exportActions.some((e) => e.id === a.id)}
                disabled={!a.frames.length}
                onCheckedChange={(checked) => {
                  const ids = c.exportActions.map((e) => e.id);
                  c.setExportActionIds(checked ? [...ids, a.id] : ids.filter((id) => id !== a.id));
                }}
              />
              <span className="min-w-0">
                <span className="block truncate">{a.name}</span>
                <span className="text-ui-sm text-muted-foreground">
                  {a.frames.length ? `${a.frames.length} ${tr("frames")}` : tr("No adopted frames")}
                </span>
              </span>
            </label>
          ) : (
            <div
              key={a.id}
              className="sb-action-row"
              data-selected={a.id === c.action.id}
              onContextMenu={(e) => {
                e.preventDefault();
                c.safe(() => c.showActionMenu(a.id, { x: e.clientX, y: e.clientY }));
              }}
            >
              <button
                aria-label={`${a.name} ${a.frames.length}`}
                onClick={() => c.selectAction(a.id)}
                onDoubleClick={() => c.setRenameAction({ id: a.id, name: a.name })}
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="truncate">{a.name}</span>
                  <span className="text-ui-sm text-muted-foreground">
                    {a.frames.length || a.plannedFrameCount || project.generationFrameCount}
                  </span>
                </span>
                <StatusChip
                  className={
                    c.actionProgress(a.id).label === "Generation failed"
                      ? "text-destructive"
                      : "text-muted-foreground"
                  }
                >
                  {tr(
                    a.frames.length || c.taskReadStatus === "ready"
                      ? c.actionProgress(a.id).label
                      : "Task results unavailable",
                  )}
                </StatusChip>
              </button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`${tr("Action options")}: ${a.name}`}
                onClick={(e) => {
                  const b = e.currentTarget.getBoundingClientRect();
                  c.safe(() => c.showActionMenu(a.id, { x: b.left, y: b.bottom }));
                }}
              >
                ⋯
              </Button>
            </div>
          ),
        )
      )}
      {stage === "actions" && c.actionCandidates.some((entry) => !entry.localActionId) && (
        <div className="mt-3 border-t pt-3">
          <h3 className="mb-2 text-ui-sm text-muted-foreground">{tr("Unassociated results")}</h3>
          {c.actionCandidates
            .filter((entry) => !entry.localActionId)
            .map((entry) => (
              <Button
                key={entry.key}
                variant="ghost"
                className="w-full justify-start"
                onClick={() => c.safe(() => c.inspectCandidate(entry.run, entry.actionId))}
              >
                {entry.run.actions?.find((a) => a.action.id === entry.actionId)?.action.name ??
                  tr("Candidate")}
              </Button>
            ))}
        </div>
      )}
      <div className="mt-auto flex flex-col gap-1 border-t pt-3">
        <Button
          variant="ghost"
          className="justify-start"
          onClick={() => {
            c.setLeftVisible(false);
            c.setMaterialsVisible(true);
          }}
        >
          <FolderIcon />
          {tr("Image sources")}
        </Button>
        {stage !== "character" && (
          <Button variant="ghost" className="justify-start" onClick={() => c.setStage("character")}>
            {tr("Character reference")}
          </Button>
        )}
      </div>
    </div>
  );
}
export function Materials({ controller: c }: Props) {
  return (
    <div
      className="sb-side-content"
      {...spriteImageInput((files) =>
        c.safe(() => c.importImages(files, "materials"), "materials"),
      )}
    >
      {c.importError && (
        <Alert variant="error" size="sm">
          {c.tr(c.importError)}
        </Alert>
      )}
      {c.copyNotice && (
        <p role="status" className="text-ui-sm">
          {c.tr(c.copyNotice)}
        </p>
      )}
      <Button variant="outline" onClick={() => c.importRef.current?.click()}>
        {c.tr("Import images")}
      </Button>
      <p className="my-2 text-ui-sm text-muted-foreground">{c.tr("Drop or paste images here")}</p>
      {c.project.sources
        .filter((s) => s.usage !== "generated-frame" && s.usage !== "generated-master")
        .map((s) => (
          <div
            key={s.id}
            className="flex items-center gap-2 rounded-md border p-2"
            onContextMenu={(e) => {
              e.preventDefault();
              c.safe(() => c.showSourceMenu(s.id, { x: e.clientX, y: e.clientY }));
            }}
          >
            <button
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              onDoubleClick={() => c.setSourceEdit({ id: s.id, name: s.name })}
              onClick={() => {
                if (c.stage === "character") {
                  c.update((p) => ({ ...p, referenceSourceId: s.id }));
                } else {
                  c.setStage("actions");
                  c.setSourceId(s.id);
                  c.setCandidate(null);
                  c.setPlaying(false);
                }
                c.setMaterialsVisible(false);
              }}
            >
              <SpriteThumbnail
                pixelated={c.project.renderSpec?.mode !== "illustration"}
                compact
                blob={s.blob}
                label={s.name}
              />
              <span className="truncate text-ui-sm">{s.name}</span>
            </button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`${c.tr("Add to conversation")}: ${s.name}`}
              disabled={c.attachmentBusy}
              onClick={() => {
                c.setMaterialsVisible(false);
                c.safe(() => c.addImageToChat(s.id));
              }}
            >
              <ChatBubblePlusIcon />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`${c.tr("Image options")}: ${s.name}`}
              onClick={(e) => {
                const b = e.currentTarget.getBoundingClientRect();
                c.safe(() => c.showSourceMenu(s.id, { x: b.left, y: b.bottom }));
              }}
            >
              ⋯
            </Button>
          </div>
        ))}
    </div>
  );
}
export function ActionProperties({ controller: c }: Props) {
  const [batchSelection, setBatchSelection] = useState<Set<string>>(new Set());
  const { tr, action, frame, project } = c;
  const targets = c.selected.size
    ? action.frames.filter((f) => c.selected.has(f.id))
    : frame
      ? [frame]
      : [];
  const changeFrames = (edit: (frame: SpriteFrame) => SpriteFrame) =>
    c.editAction((a) => ({
      ...a,
      frames: a.frames.map((f) => (targets.some((t) => t.id === f.id) ? edit(f) : f)),
    }));
  const mixed = (key: "offsetX" | "offsetY" | "durationMs") =>
    targets.some((f) => f[key] !== targets[0]?.[key]);
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <h3 className="font-medium">{tr("Action properties")}</h3>
      <label className="flex flex-col gap-1.5 text-ui-sm">
        {tr("Action name")}
        <Input
          aria-label={tr("Action name")}
          value={action.name}
          onChange={(e) => c.editAction((a) => ({ ...a, name: e.target.value }))}
        />
      </label>
      <div className="sb-input-grid">
        <SpriteNumberField
          label="FPS"
          value={action.fps}
          max={60}
          onChange={(fps) => c.editAction((a) => ({ ...a, fps }))}
        />
        <SpriteNumberField
          label={tr("Generated frames")}
          value={action.plannedFrameCount ?? project.generationFrameCount}
          max={32}
          onChange={(plannedFrameCount) => c.editAction((a) => ({ ...a, plannedFrameCount }))}
        />
      </div>
      <label className="flex items-center gap-2 text-ui-sm">
        <Checkbox
          checked={action.loop}
          onCheckedChange={(loop) => c.editAction((a) => ({ ...a, loop: !!loop }))}
        />
        {tr("Loop")}
      </label>
      <details className="space-y-3 border-t pt-4 text-ui-sm">
        <summary>{tr("Canvas settings")}</summary>
        <p className="text-muted-foreground">{tr("Canvas settings apply to every action.")}</p>
        <div className="grid grid-cols-2 gap-3">
          <SpriteNumberField
            resetKey={!!c.specChange}
            label={tr(
              project.renderSpec?.mode === "pixel" ? "Logical width" : "Action frame width",
            )}
            value={project.renderSpec?.logicalWidth ?? project.width}
            max={Math.floor(4096 / (project.renderSpec?.outputScale ?? 1))}
            onChange={(width) =>
              c.update((p) =>
                p.renderSpec
                  ? { ...p, renderSpec: { ...p.renderSpec, logicalWidth: width } }
                  : { ...p, width },
              )
            }
          />
          <SpriteNumberField
            resetKey={!!c.specChange}
            label={tr(
              project.renderSpec?.mode === "pixel" ? "Logical height" : "Action frame height",
            )}
            value={project.renderSpec?.logicalHeight ?? project.height}
            max={Math.floor(4096 / (project.renderSpec?.outputScale ?? 1))}
            onChange={(height) =>
              c.update((p) =>
                p.renderSpec
                  ? { ...p, renderSpec: { ...p.renderSpec, logicalHeight: height } }
                  : { ...p, height },
              )
            }
          />
        </div>
        {project.renderSpec?.mode === "pixel" && (
          <SpriteNumberField
            label={tr("Output scale")}
            resetKey={!!c.specChange}
            value={project.renderSpec.outputScale}
            max={Math.floor(
              4096 / Math.max(project.renderSpec.logicalWidth, project.renderSpec.logicalHeight),
            )}
            onChange={(outputScale) =>
              c.update((p) =>
                p.renderSpec ? { ...p, renderSpec: { ...p.renderSpec, outputScale } } : p,
              )
            }
          />
        )}
      </details>
      {!!targets.length && (
        <div className="space-y-4 border-t pt-4">
          <h3 className="font-medium">
            {targets.length > 1
              ? `${targets.length} ${tr("frames selected")}`
              : `${tr("Frame")} ${c.index + 1}`}
          </h3>
          {(["offsetX", "offsetY"] as const).map((key) => (
            <div key={key}>
              <SpriteNumberField
                label={tr(key === "offsetX" ? "Offset X" : "Offset Y")}
                value={(targets[0]?.[key] ?? 0) / c.offsetUnit}
                min={-4096 / c.offsetUnit}
                max={4096 / c.offsetUnit}
                onChange={(n) => changeFrames((f) => ({ ...f, [key]: n * c.offsetUnit }))}
              />
              {mixed(key) && (
                <p className="mt-1 text-ui-sm text-muted-foreground">{tr("Mixed values")}</p>
              )}
            </div>
          ))}
          <SpriteNumberField
            label={tr("Frame duration (ms)")}
            value={Math.round(targets[0]?.durationMs ?? 1000 / action.fps)}
            max={60000}
            onChange={(durationMs) => changeFrames((f) => ({ ...f, durationMs }))}
          />
          <p className="text-ui-sm text-muted-foreground">
            {tr(
              mixed("durationMs")
                ? "Mixed values"
                : targets[0]?.durationMs === undefined
                  ? "Inherits action FPS"
                  : "Custom frame duration",
            )}
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => changeFrames((f) => ({ ...f, durationMs: undefined }))}
          >
            {tr("Use action FPS")}
          </Button>
          <p className="text-ui-sm text-muted-foreground">
            {tr("Offsets preserve intentional motion; frames are not centered automatically.")}
          </p>
          {frame && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                c.safe(async () => {
                  const source = c.current.current.sources.find((s) => s.id === frame.sourceId)!;
                  const material = await cropSpriteFrameSource(
                    source,
                    frame,
                    `${action.name}-${c.index + 1}.png`,
                  );
                  c.update((p) => ({
                    ...p,
                    sources: [...p.sources, { ...material, usage: "material" }],
                  }));
                })
              }
            >
              {tr("Save current frame as material")}
            </Button>
          )}
        </div>
      )}
      <div className="space-y-4 border-t pt-4">
        <h3 className="font-medium">{tr("Make this action")}</h3>
        <label className="flex flex-col gap-1.5 text-ui-sm">
          {tr("Animation requirements")}
          <Textarea
            aria-label={tr("Animation requirements")}
            value={action.description ?? ""}
            onChange={(e) => c.editAction((a) => ({ ...a, description: e.target.value }))}
          />
        </label>
        <DrawingModelPicker
          providers={c.providers.data ?? []}
          providerId={project.providerId}
          model={project.model}
          onChange={(providerId, model) => c.update((p) => ({ ...p, providerId, model }))}
          onSettings={() =>
            void c.navigate({ to: "/settings", search: { section: "imageProviders" } })
          }
        />
        <Button
          className="w-full"
          disabled={c.generationBusy || (project.version === 2 && !project.canonical)}
          onClick={() => c.safe(() => c.prepareGeneration("animation"))}
        >
          {tr("Generate action")}
        </Button>
        <details className="space-y-3 text-ui-sm">
          <summary>{tr("Batch generation")}</summary>
          <p className="text-muted-foreground">
            {tr("Choose actions to include in one generation plan.")}
          </p>
          {project.actions.map((a) => (
            <label key={a.id} className="flex items-center gap-2">
              <Checkbox
                aria-labelledby={`sb-batch-${project.id}-${a.id}`}
                checked={batchSelection.has(a.id)}
                onCheckedChange={(checked) =>
                  setBatchSelection((p) => {
                    const next = new Set(p);
                    if (checked) next.add(a.id);
                    else next.delete(a.id);
                    return next;
                  })
                }
              />
              <span id={`sb-batch-${project.id}-${a.id}`}>{a.name}</span>
            </label>
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={!batchSelection.size || c.generationBusy}
            onClick={() => c.safe(() => c.prepareGeneration("animation", [...batchSelection]))}
          >
            {tr("Prepare selected actions")} ({batchSelection.size})
          </Button>
        </details>
        {project.version === 2 && !project.canonical && (
          <Button size="sm" variant="ghost" onClick={() => c.setStage("character")}>
            {tr("Confirm character reference")}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => c.setVersionsVisible(true)}>
          <HistoryIcon />
          {tr("Versions and source")}
        </Button>
      </div>
    </div>
  );
}
export function CandidateProperties({ controller: c }: Props) {
  const { tr } = c,
    run = c.inspectedRun,
    record = run ? spriteCandidate(run) : undefined;
  const actionId = c.previewAction.id;
  const issues = (record?.issues ?? []).filter((i) => !i.actionId || i.actionId === actionId);
  return (
    <div className="space-y-5">
      <h3 className="font-medium">{tr("Review candidate")}</h3>
      <p className="text-ui-sm text-muted-foreground">
        {tr(
          "Check the character, complete body, scale, ground position and motion. Adoption records your confirmation.",
        )}
      </p>
      {issues.map((i) => (
        <button
          key={`${i.code}:${i.frameIndex}:${i.actionId}:${i.message}`}
          className={`block w-full rounded-md border p-3 text-left text-ui-sm ${i.severity === "error" ? "text-destructive" : "text-muted-foreground"}`}
          onClick={() => {
            if (i.frameIndex !== null) {
              c.setIndex(i.frameIndex);
              c.setPlaying(false);
            }
          }}
        >
          {i.frameIndex !== null ? `${tr("Frame")} ${i.frameIndex + 1} · ` : ""}
          {tr(i.message)}
        </button>
      ))}
      {run && spriteCandidateStructuralErrors(run, actionId) && (
        <Alert variant="error" size="sm">
          {tr("Fix structural frame errors before adopting this action.")}
        </Alert>
      )}
      {c.candidate && c.candidate.actions.length > 1 && (
        <>
          <SpriteSelect
            label={tr("Preview action")}
            value={actionId}
            options={c.candidate.actions.map((a) => ({ value: a.id, label: a.name }))}
            onChange={(id) => {
              c.setCandidate({ ...c.candidate!, selectedActionId: id });
              c.setIndex(0);
              c.setPlaying(false);
            }}
          />
          <details className="border-t pt-4">
            <summary className="text-ui-sm">{tr("Select actions for adoption")}</summary>
            <div className="mt-3 space-y-3">
              {c.candidate.actions.map((a) => (
                <label key={a.id} className="flex items-center gap-2 text-ui-sm">
                  <Checkbox
                    aria-labelledby={`sb-adopt-${c.project.id}-${a.id}`}
                    checked={c.candidateSelection.has(a.id)}
                    disabled={!!run && spriteCandidateStructuralErrors(run, a.id)}
                    onCheckedChange={(checked) =>
                      c.setCandidateSelection((p) => {
                        const next = new Set(p);
                        if (checked) next.add(a.id);
                        else next.delete(a.id);
                        return next;
                      })
                    }
                  />
                  <span id={`sb-adopt-${c.project.id}-${a.id}`}>
                    {a.name} · {a.frames.length} {tr("frames")}
                  </span>
                </label>
              ))}
            </div>
          </details>
        </>
      )}
      {run &&
        !c.actionCandidates.find((item) => item.run.id === run.id && item.actionId === actionId)
          ?.localActionId && (
          <SpriteSelect
            label={tr("Adoption target")}
            value={c.candidateTargetId}
            options={[
              { value: "", label: tr("Keep as new action") },
              ...c.project.actions.map((a) => ({ value: a.id, label: a.name })),
            ]}
            onChange={c.setCandidateTargetId}
          />
        )}
      {run && (
        <>
          <Button
            variant="outline"
            className="w-full"
            onClick={() =>
              c.openSlicing(c.state.runs.find((r) => r.id === run.id) ?? run, actionId)
            }
          >
            {tr("Adjust slicing and alignment")}
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            onClick={() => c.safe(() => c.runCommand(run, "retry", actionId))}
          >
            {tr("Regenerate this action")}
          </Button>
          {record && (
            <div className="space-y-2 border-t pt-4 text-ui-sm text-muted-foreground">
              <p>{run.context.model}</p>
              <p>
                {tr("Processing version")}:{" "}
                {record.processingVersionId?.slice(0, 8) ?? tr("Original")}
              </p>
              <Button size="sm" variant="ghost" onClick={() => c.setOriginalImage(record.source)}>
                {tr("View original image")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  c.safe(async () => {
                    const next = await drawingApi().spriteCommand({
                      operation: "reprocess-candidate",
                      projectId: c.project.id,
                      runId: run.id,
                      candidateId: record.id,
                      version: record.version ?? 0,
                    });
                    c.setState(next);
                    const updated = next.runs.find((r) => r.id === run.id);
                    if (updated) await c.inspectCandidate(updated, actionId);
                  })
                }
              >
                {tr("Reprocess from original · free")}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
export function ExportProperties({ controller: c }: Props) {
  const { tr } = c;
  return (
    <div className="space-y-5">
      <h3 className="font-medium">{tr("Export settings")}</h3>
      <SpriteSelect
        label={tr("Export format")}
        value={c.exportMode}
        options={[
          { value: "combined", label: tr("Combined PNG atlas + JSON") },
          { value: "atlas", label: tr("Per-action PNG atlases + JSON") },
          { value: "sequence", label: tr("PNG sequence + JSON") },
        ]}
        onChange={c.setExportMode}
      />
      {c.project.renderSpec?.mode === "pixel" && (
        <SpriteNumberField
          label={tr("Output scale")}
          value={c.exportScale}
          max={Math.floor(
            4096 / Math.max(c.project.renderSpec.logicalWidth, c.project.renderSpec.logicalHeight),
          )}
          onChange={c.setExportScale}
        />
      )}
      <p className="text-ui-sm text-muted-foreground">
        {tr("Output frame")}: {c.exportProject.width} × {c.exportProject.height}
      </p>
      {c.exportMode !== "sequence" && (
        <div className="sb-input-grid">
          <SpriteNumberField
            label={tr("Columns")}
            value={c.columns}
            max={64}
            onChange={c.setColumns}
          />
          <SpriteNumberField
            label={tr("Spacing")}
            value={c.gap}
            min={0}
            max={128}
            onChange={c.setGap}
          />
        </div>
      )}
      <div className="space-y-3 border-t pt-4">
        <h3 className="font-medium">{tr("Export checks")}</h3>
        <StatusChip className="text-muted-foreground">
          {c.exportActions.length} {tr("actions selected")}
        </StatusChip>
        <p className="text-ui-sm text-muted-foreground">
          {tr("Candidates and unsaved corrections are not included.")}
        </p>
        {c.actionCandidates.some(
          (e) =>
            c.exportActions.some((a) => a.id === e.localActionId) &&
            spriteAdoption(e.run, e.actionId, c.project).status !== "current",
        ) && (
          <p className="text-ui-sm text-warning">
            {tr("New candidates are waiting. This export uses the currently adopted versions.")}
          </p>
        )}
      </div>
    </div>
  );
}
export function Versions({ controller: c }: Props) {
  const { tr, project } = c;
  return (
    <div className="min-h-0 space-y-4 overflow-auto p-4">
      {!(project.actionVersions ?? []).some((v) => v.action.id === c.action.id) && (
        <p className="text-ui-sm text-muted-foreground">
          {tr(
            "The current action is saved. Versions are retained when adopting or replacing an action.",
          )}
        </p>
      )}
      {(project.actionVersions ?? [])
        .filter((v) => v.action.id === c.action.id)
        .toReversed()
        .map((v) => (
          <div key={v.id} className="space-y-2 border-b pb-4">
            <div className="flex items-center justify-between gap-2">
              <span>
                {v.action.name} · {v.action.frames.length} {tr("frames")}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  c.safe(async () => {
                    await c.restoreVersion(v.id);
                    c.setVersionsVisible(false);
                  })
                }
              >
                {tr("Restore version")}
              </Button>
            </div>
            <p className="text-ui-sm text-muted-foreground">
              {new Date(v.createdAt).toLocaleString()} · {v.width} × {v.height}
            </p>
            {(v.width !== project.width ||
              v.height !== project.height ||
              JSON.stringify(v.renderSpec) !== JSON.stringify(project.renderSpec)) && (
              <details className="text-ui-sm text-muted-foreground">
                <summary>{tr("Different canvas settings")}</summary>
                <p className="py-2">
                  {tr(
                    "Restoring the recorded canvas also affects preview and export of other actions.",
                  )}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    c.safe(async () => {
                      await c.restoreVersion(v.id, true);
                      c.setVersionsVisible(false);
                    })
                  }
                >
                  {tr("Restore canvas and action")}
                </Button>
              </details>
            )}
            {v.provenance.map((p) => (
              <p key={`${p.runId}:${p.candidateId}`} className="text-ui-sm text-muted-foreground">
                {p.model} · {p.processingVersionId ?? p.candidateId}
              </p>
            ))}
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                c.update((p) => ({
                  ...p,
                  actionVersions: p.actionVersions?.filter((saved) => saved.id !== v.id),
                }))
              }
            >
              {tr("Remove saved version")}
            </Button>
          </div>
        ))}
    </div>
  );
}
