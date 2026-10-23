import { useEffect, useState } from "react";
import { RouteSurfaceHeader } from "../RouteSurface";
import { Button } from "../ui/button";
import { confirmDialog } from "../ui/confirm-dialog";
import { Input } from "../ui/input";
import { Alert } from "../ui/alert";
import { WorkAreaPanel } from "../ui/work-area-panel";
import { Menu, MenuTrigger, MenuItem, MenuSeparator } from "../ui/menu";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import {
  Undo2Icon,
  Redo2Icon,
  DownloadIcon,
  PanelLeftIcon,
  PanelRightCloseIcon,
  PlayIcon,
  PauseIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  XIcon,
  HistoryIcon,
  ChatBubblePlusIcon,
} from "~/lib/icons";
import { SpriteCharacterPanel } from "./SpriteCharacterPanel";
import { SpritePreview } from "./SpritePreview";
import { SpriteFramePicker } from "./SpriteFramePicker";
import { SpriteSliceEditor } from "./SpriteSliceEditor";
import { SpriteCreationPanel } from "./SpriteCreationPanel";
import { spriteCreationKey } from "./spriteCreation";
import { spriteImageInput } from "./spriteImageInput";
import { SpriteChat } from "./SpriteChat";
import { SpriteExportPreview } from "./SpriteExportPreview";
import { SpriteResizeHandle } from "./SpriteResizeHandle";
import { SpriteWorkbenchDialogs } from "./SpriteWorkbenchDialogs";
import { SpriteTaskQueue } from "./SpriteTaskQueue";
import { SpriteSourceEditor, SpriteSourceProperties } from "./SpriteSourceEditor";
import {
  ActionProperties,
  CandidateProperties,
  ExportProperties,
  ObjectNavigation,
  Materials,
  Versions,
} from "./SpriteWorkbenchPanels";
import { useSpriteWorkbenchController } from "./useSpriteWorkbenchController";
import { spriteCandidate } from "./spriteCandidate";
import { spriteAdoption } from "./spriteAdoption";
import {
  spriteCandidateStructuralErrors,
  spriteExportFileList,
  spriteExportFingerprint,
} from "./spriteWorkbenchModel";
import {
  safeFilename,
  spriteFrameDuration,
  spriteFrameAtTime,
  type SpriteProject,
} from "./spriteModel";
import { deleteSpriteProject } from "./spriteStorage";
import { exportSpriteProject } from "./spriteFiles";
import { downloadBlob } from "~/lib/browserDownload";
import "./spriteWorkbench.css";

export type SpriteWorkbenchController = ReturnType<typeof useSpriteWorkbenchController>;
export default function SpriteWorkbench({
  initialProject,
  onBack,
}: {
  initialProject: SpriteProject;
  onBack: () => Promise<void>;
}) {
  const c = useSpriteWorkbenchController({ initialProject, onBack });
  const {
    tr,
    project,
    stage,
    leftVisible,
    chatVisible,
    setLeftVisible,
    setChatVisible,
    exportProject,
    exportMode,
    columns,
    gap,
    materialsVisible,
    versionsVisible,
    setMaterialsVisible,
    setVersionsVisible,
  } = c;
  const [inspectorHost, setInspectorHost] = useState<HTMLDivElement | null>(null);
  const [repairFooterHost, setRepairFooterHost] = useState<HTMLDivElement | null>(null);
  const [compare, setCompare] = useState(false);
  const [exportModified, setExportModified] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(true);
  const wide = c.workbenchWidth >= 1280,
    showLeft = c.workbenchWidth >= 1024 && (wide || !c.chatVisible);
  const inlineRight = c.workbenchWidth >= 1024 && (wide || c.chatVisible || c.versionsVisible);
  const inspectorWidth = Math.max(c.rightWidth, c.rightTab === "assistant" ? 360 : 280);
  useEffect(() => {
    if (materialsVisible && !wide) {
      setChatVisible(false);
      setVersionsVisible(false);
    }
  }, [materialsVisible, wide, setChatVisible, setVersionsVisible]);
  useEffect(() => {
    if ((chatVisible || versionsVisible) && !wide) {
      setMaterialsVisible(false);
      setLeftVisible(false);
    }
  }, [chatVisible, versionsVisible, wide, setMaterialsVisible, setLeftVisible]);
  useEffect(() => {
    if (leftVisible && !showLeft) setChatVisible(false);
  }, [leftVisible, showLeft, setChatVisible]);
  useEffect(() => {
    if (chatVisible && !showLeft) setLeftVisible(false);
  }, [chatVisible, showLeft, setLeftVisible]);
  useEffect(() => {
    if (!project.lastExport) {
      setExportModified(false);
      return;
    }
    let alive = true;
    void spriteExportFingerprint(exportProject, project.lastExport.actionIds)
      .then((hash) => {
        if (alive)
          setExportModified(
            hash !== project.lastExport!.fingerprint ||
              exportMode !== project.lastExport!.mode ||
              columns !== project.lastExport!.columns ||
              gap !== project.lastExport!.gap,
          );
      })
      .catch(() => {
        if (alive) setExportModified(true);
      });
    return () => {
      alive = false;
    };
  }, [project.lastExport, exportProject, exportMode, columns, gap]);
  const inspectedPlan =
    c.creationMode === "plan" ? c.state.plans?.find((p) => p.id === c.planId) : undefined;
  const assistantTarget = inspectedPlan
    ? inspectedPlan.configuration.kind === "character"
      ? tr("Character reference")
      : inspectedPlan.configuration.actions
          .filter((a) => a.enabled)
          .map((a) => a.name)
          .join(" · ")
    : c.creationMode === "prompt" && c.creationTarget
      ? c.creationTarget.kind === "character"
        ? tr("Character reference")
        : project.actions
            .filter((a) => c.creationTarget!.actionIds.includes(a.id))
            .map((a) => a.name)
            .join(" · ")
      : stage === "character"
        ? tr("Character reference")
        : stage === "export"
          ? tr("Export")
          : c.previewAction.name;
  const inspector = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="sb-toolbar border-b">
        <Button
          size="sm"
          variant={c.rightTab === "properties" ? "secondary" : "ghost"}
          aria-pressed={c.rightTab === "properties"}
          onClick={() => c.setRightTab("properties")}
        >
          {tr("Properties")}
        </Button>
        <Button
          size="sm"
          variant={c.rightTab === "assistant" ? "secondary" : "ghost"}
          aria-pressed={c.rightTab === "assistant"}
          onClick={() => c.setRightTab("assistant")}
        >
          {tr("AI assistant")}
        </Button>
      </div>
      <div className={`sb-inspector-content ${c.rightTab === "properties" ? "" : "hidden"}`}>
        {stage === "character" ? (
          <div ref={setInspectorHost} />
        ) : stage === "export" ? (
          <ExportProperties controller={c} />
        ) : c.repairRun ? (
          <div ref={setInspectorHost} />
        ) : c.source ? (
          <SpriteSourceProperties controller={c} />
        ) : c.candidate ? (
          <CandidateProperties controller={c} />
        ) : (
          <ActionProperties controller={c} />
        )}
      </div>
      <div
        data-sprite-chat
        className={`${c.rightTab === "assistant" ? "flex" : "hidden"} min-h-0 flex-1 flex-col`}
      >
        <div className="border-b px-3 py-2 text-ui-sm text-muted-foreground">
          {assistantTarget}
          {stage === "actions" && c.frame ? ` · ${tr("Frame")} ${c.index + 1}` : ""}
          {c.candidate ? ` · ${tr("Awaiting review")}` : ""}
        </div>
        {c.chatError && (
          <Alert variant="error" size="sm">
            {tr(c.chatError)}
          </Alert>
        )}
        {c.creationMode !== "chat" && (
          <SpriteCreationPanel
            key={`${c.creationTarget ? spriteCreationKey(c.creationTarget) : c.planId}:${c.creationSession}`}
            controller={c}
          />
        )}
        <div className={`${c.creationMode === "chat" ? "flex" : "hidden"} min-h-0 flex-1 flex-col`}>
          {c.creationMode === "chat" && (
            <div className="sb-toolbar border-b">
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  c.safe(() =>
                    c.prepareGeneration(stage === "character" ? "character" : "animation"),
                  )
                }
              >
                {tr("Prepare generation plan")}
              </Button>
            </div>
          )}
          <SpriteChat
            project={project}
            attachmentBridge={c.attachmentBridge}
            onThread={(id, activate = true) => {
              if (c.removedConversationIds.current.has(id))
                return Promise.reject(new Error("This sprite conversation has been deleted."));
              return c.changeThreads(
                [...new Set([...c.current.current.threadIds, id])],
                activate ? id : c.current.current.activeThreadId,
              );
            }}
            onThreads={c.changeThreads}
            onCreateReady={c.registerConversationCreator}
            syncContext={c.syncContext}
            onError={c.reportChat}
          />
        </div>
      </div>
    </div>
  );
  const closeCandidate = () => {
    c.resetActionPreview();
    setCompare(false);
  };
  const currentComparisonFrame = () => {
    const action = c.action;
    const elapsed = c.playing
      ? c.playheadMs
      : c.previewAction.frames
          .slice(0, c.index)
          .reduce((n, f) => n + spriteFrameDuration(c.previewAction, f), 0);
    return action.frames[spriteFrameAtTime(action, elapsed)];
  };
  return (
    <div ref={c.workbenchRef} data-testid="sprite-workbench" className="sprite-workbench">
      <RouteSurfaceHeader rowClassName="min-w-0">
        <div className="no-drag flex min-w-0 flex-1 items-center gap-2" inert={c.adopting}>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              c.safe(async () => {
                await c.associationTail.current;
                await c.save(c.current.current);
                await onBack();
              })
            }
          >
            {tr("Sprite animation")}
          </Button>
          <span className="text-muted-foreground">/</span>
          <Input
            size="sm"
            className="max-w-48 border-transparent bg-transparent"
            value={project.name}
            maxLength={200}
            aria-label={tr("Project name")}
            onChange={(e) => c.update((p) => ({ ...p, name: e.target.value }))}
          />
          <span className="hidden shrink-0 text-ui-sm text-muted-foreground md:block" role="status">
            {tr(c.saveStatus)}
          </span>
          {c.saveStatus === "Save failed" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => c.safe(() => c.save(c.current.current))}
            >
              {tr("Retry save")}
            </Button>
          )}
        </div>
        <div className="no-drag flex shrink-0 items-center gap-1" inert={c.adopting}>
          <Menu>
            <MenuTrigger
              render={<Button size="icon" variant="ghost" aria-label={tr("Project options")} />}
            >
              ⋯
            </MenuTrigger>
            <ComposerPickerMenuPopup align="end">
              <MenuItem onClick={() => c.importRef.current?.click()}>
                {tr("Import images")}
              </MenuItem>
              <MenuItem
                onClick={() =>
                  c.safe(async () =>
                    downloadBlob(
                      await exportSpriteProject(project),
                      `${safeFilename(project.name)}.aha-sprite.zip`,
                    ),
                  )
                }
              >
                {tr("Save project package")}
              </MenuItem>
              <MenuItem
                onClick={() =>
                  c.safe(async () => {
                    await c.save(c.current.current);
                    await onBack();
                  })
                }
              >
                {tr("Back to projects")}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                disabled={c.deleteBusy}
                onClick={async () => {
                  if (
                    c.deleting ||
                    (await confirmDialog({
                      title: tr('Delete sprite project "{name}"?').replace("{name}", project.name),
                      description: tr(
                        "Deletes the project, its frames and generation records. This cannot be undone. Conversation history is kept.",
                      ),
                      confirmLabel: tr("Delete"),
                      destructive: true,
                    }))
                  )
                    c.safe(async () => {
                      c.deletionStarted.current = true;
                      c.setDeleting(true);
                      c.setPlaying(false);
                      c.setDeleteBusy(true);
                      try {
                        await deleteSpriteProject(project.id);
                        await onBack();
                      } catch (e) {
                        if ((e as { deletionStarted?: boolean }).deletionStarted === false) {
                          c.deletionStarted.current = false;
                          c.setDeleting(false);
                        }
                        throw e;
                      } finally {
                        c.setDeleteBusy(false);
                      }
                    });
                }}
              >
                {tr(c.deleting ? "Retry deletion" : "Delete")}
              </MenuItem>
            </ComposerPickerMenuPopup>
          </Menu>
        </div>
      </RouteSurfaceHeader>
      <nav
        inert={c.adopting}
        aria-label={tr("Sprite workflow")}
        className="flex shrink-0 flex-wrap items-center gap-1 border-b px-3 py-2"
      >
        {!showLeft && (
          <Button
            size="icon"
            variant="ghost"
            aria-label={tr("Actions list")}
            onClick={() => {
              c.setChatVisible(false);
              c.setLeftVisible(true);
            }}
          >
            <PanelLeftIcon />
          </Button>
        )}
        {(["character", "actions", "export"] as const).map((phase) => (
          <Button
            key={phase}
            size="sm"
            variant={stage === phase ? "secondary" : "ghost"}
            aria-current={stage === phase ? "step" : undefined}
            onClick={() => c.setStage(phase)}
          >
            {tr(phase === "character" ? "Character" : phase === "actions" ? "Actions" : "Export")}
          </Button>
        ))}
        <div className="ml-auto flex items-center gap-1">
          {" "}
          {!c.repairRun && (
            <>
              <Button
                size="icon"
                variant="ghost"
                disabled={!c.past.length}
                aria-label={tr("Undo")}
                onClick={c.undo}
              >
                <Undo2Icon />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                disabled={!c.future.length}
                aria-label={tr("Redo")}
                onClick={c.redo}
              >
                <Redo2Icon />
              </Button>
            </>
          )}
          {stage !== "export" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                c.safe(() => c.prepareGeneration(stage === "character" ? "character" : "animation"))
              }
            >
              {tr(stage === "character" ? "Generate character" : "Generate action")}
            </Button>
          )}
        </div>
        <span className="hidden text-ui-sm text-muted-foreground sm:inline">
          {project.canonical
            ? `${tr("Character approved")} · ${project.renderSpec?.logicalWidth ?? project.width} × ${project.renderSpec?.logicalHeight ?? project.height}`
            : tr("Character awaiting approval")}
        </span>
        {!wide && (
          <Button
            size="icon"
            variant="ghost"
            aria-label={tr("Open inspector")}
            onClick={() => {
              c.setLeftVisible(false);
              c.setChatVisible(true);
            }}
          >
            <PanelRightCloseIcon />
          </Button>
        )}
      </nav>
      {c.taskReadStatus !== "ready" && (
        <Alert
          variant={c.taskReadStatus === "loading" ? "info" : "warning"}
          size="sm"
          className="rounded-none shrink-0"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex-1">
              {tr(
                c.taskReadStatus === "loading"
                  ? "Loading task results…"
                  : c.taskReadStatus === "partial"
                    ? "Some task results could not be read. Valid results and local actions are preserved; generation changes are paused."
                    : "Task results could not be refreshed. Your last results and local actions are preserved.",
              )}
            </span>
            <Button size="sm" variant="outline" onClick={() => void c.retryTasks()}>
              {tr("Retry reading")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => c.setMaterialsVisible(true)}>
              {tr("View image sources")}
            </Button>
          </div>
          {c.taskReadError || c.state.recovery?.diagnostics.length ? (
            <details className="mt-1 text-ui-sm">
              <summary>{tr("Diagnostic details")}</summary>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all">
                {c.taskReadError ||
                  c.state.recovery?.diagnostics.map((d) => `${d.path}: ${d.message}`).join("\n")}
                {c.state.recovery?.backupFile ? `\n${c.state.recovery.backupFile}` : ""}
              </pre>
            </details>
          ) : null}
        </Alert>
      )}
      {c.error && (
        <Alert variant="error" size="sm" className="flex shrink-0 items-center gap-2 rounded-none">
          <span className="flex-1">{tr(c.error)}</span>
          <Button
            size="icon"
            variant="ghost"
            aria-label={tr("Dismiss error")}
            onClick={() => c.setError("")}
          >
            <XIcon />
          </Button>
        </Alert>
      )}
      {c.copyNotice && !c.materialsVisible && (
        <div role="status" className="sb-footer-note border-b">
          <span className="flex-1 text-ui-sm">{tr(c.copyNotice)}</span>
          <Button
            size="icon"
            variant="ghost"
            aria-label={tr("Dismiss")}
            onClick={() => c.setCopyNotice("")}
          >
            <XIcon />
          </Button>
        </div>
      )}
      {c.deleting && (
        <p role="status" className="px-4 py-2">
          {tr("Deletion has started. Retry deletion to finish removing this project.")}
        </p>
      )}
      <div className="sb-body relative" inert={c.deleting || c.adopting}>
        {showLeft && (
          <>
            <aside className="sb-sidebar" style={{ width: c.leftWidth }}>
              {c.materialsVisible ? (
                <>
                  <div className="sb-toolbar border-b">
                    <h2 className="flex-1 text-ui font-medium">{tr("Image sources")}</h2>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={tr("Close image sources")}
                      onClick={() => c.setMaterialsVisible(false)}
                    >
                      <XIcon />
                    </Button>
                  </div>
                  <Materials controller={c} />
                </>
              ) : (
                <ObjectNavigation controller={c} />
              )}
            </aside>
            <SpriteResizeHandle
              label={tr("Resize action navigation")}
              value={c.leftWidth}
              min={180}
              max={Math.max(180, Math.min(320, c.workbenchWidth - 640))}
              onChange={c.setLeftWidth}
            />
          </>
        )}
        <main
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          {...(stage === "actions" && !c.repairRun
            ? spriteImageInput((files) => c.setPendingImageImport({ files }))
            : {})}
        >
          {stage === "character" ? (
            <SpriteCharacterPanel
              fieldResetKey={!!c.specChange}
              project={project}
              state={c.state}
              onChange={c.update}
              onState={c.setState}
              onDone={() => c.setStage("actions")}
              onGenerate={() => c.safe(() => c.prepareGeneration("character"))}
              inspectorHost={inspectorHost}
              onImportSheet={() => {
                c.setStage("actions");
                c.importRef.current?.click();
              }}
            />
          ) : stage === "export" ? (
            <>
              <div className="sb-work-header">
                <div>
                  <h2 className="font-medium">{tr("Export preview")}</h2>
                  <p className="text-ui-sm text-muted-foreground">
                    {tr("Only adopted and manually imported frames are exported.")}
                  </p>
                </div>
                <span className="text-ui-sm text-muted-foreground">
                  {c.exportActions.length} {tr("actions")} ·{" "}
                  {c.exportActions.reduce((n, a) => n + a.frames.length, 0)} {tr("frames")}
                </span>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-4">
                {c.exportActions.length ? (
                  <SpriteExportPreview
                    project={c.exportProject}
                    actionIds={c.exportActions.map((a) => a.id)}
                    mode={c.exportMode}
                    columns={c.columns}
                    gap={c.gap}
                  />
                ) : (
                  <div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 text-center">
                    <p>{tr("No frames to export.")}</p>
                    <p className="text-ui-sm text-muted-foreground">
                      {tr(
                        c.actionCandidates.length
                          ? "Candidates are ready to review before export."
                          : "Create an action or import a sprite sheet to begin.",
                      )}
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => {
                        c.setStage("actions");
                        const item = c.actionCandidates[0];
                        if (item) c.safe(() => c.inspectCandidate(item.run, item.actionId));
                      }}
                    >
                      {tr(c.actionCandidates.length ? "Review candidate" : "Back to actions")}
                    </Button>
                  </div>
                )}
                {!!c.exportActions.length && (
                  <div className="mt-5 space-y-2">
                    <h3 className="font-medium">{tr("Export files")}</h3>
                    {spriteExportFileList(
                      c.exportProject,
                      c.exportActions.map((a) => a.id),
                      c.exportMode,
                    )
                      .slice(0, 30)
                      .map((file) => (
                        <p key={file} className="truncate border-b py-2 text-ui-sm">
                          {file}
                        </p>
                      ))}
                  </div>
                )}
                {project.lastExport && (
                  <p className="mt-4 text-ui-sm text-muted-foreground">
                    {tr(exportModified ? "Modified since last export" : "Last export")}:{" "}
                    {new Date(project.lastExport.createdAt).toLocaleString()}
                  </p>
                )}
              </div>
              <div className="sb-work-footer">
                <span className="mr-auto text-ui-sm text-muted-foreground" role="status">
                  {tr(c.progress || "Ready to export")}
                </span>
                {c.progress && (
                  <Button variant="ghost" onClick={() => c.abort.current?.abort()}>
                    {tr("Cancel")}
                  </Button>
                )}
                {window.desktopBridge?.resourceLibrary && (
                  <Button
                    variant="outline"
                    disabled={!c.exportActions.length || !!c.progress}
                    title={tr(
                      "Animation resources added to the resource center keep this project as their source.",
                    )}
                    onClick={() => c.safe(() => c.exportAssets("resources"))}
                  >
                    {tr("Add to resource center")}
                  </Button>
                )}
                <Button
                  disabled={!c.exportActions.length || !!c.progress}
                  onClick={() => c.safe(() => c.exportAssets("download"))}
                >
                  <DownloadIcon />
                  {tr("Export animation resources")}
                </Button>
              </div>
            </>
          ) : c.repairRun && spriteCandidate(c.repairRun) ? (
            <SpriteSliceEditor
              key={`${project.id}:${c.repairRun.id}:${c.repairRun.selectedCandidateId}`}
              run={c.repairRun}
              onReplaceSource={c.replaceSlicingSource}
              footerHost={repairFooterHost}
              initialActionId={c.repairActionId}
              initialFrameIndex={c.repairFrameIndex}
              inspectorHost={inspectorHost}
              onState={c.setState}
              onBack={() => {
                const run = c.state.runs.find((r) => r.id === c.repairRunId);
                c.setRepairRunId(null);
                if (run)
                  c.safe(() => c.inspectCandidate(run, c.repairActionId ?? undefined, c.index));
                else closeCandidate();
              }}
              onSaved={(next) => {
                c.setState(next);
                const run = next.runs.find((r) => r.id === c.repairRunId);
                c.setRepairRunId(null);
                if (run)
                  c.safe(() =>
                    c.inspectCandidate(run, c.repairActionId ?? undefined, c.index, next.runs),
                  );
              }}
            />
          ) : c.source ? (
            <SpriteSourceEditor controller={c} />
          ) : (
            <>
              <div className="sb-work-header">
                <div>
                  <h2 className="font-medium">{c.previewAction.name}</h2>
                  <p className="text-ui-sm text-muted-foreground">
                    {tr(
                      c.candidate
                        ? "Candidate preview — your existing animation is preserved"
                        : "Current adopted version",
                    )}{" "}
                    · {c.previewAction.frames.length} {tr("frames")}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {c.candidate ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          c.inspectedRun &&
                          c.openSlicing(
                            c.state.runs.find((r) => r.id === c.inspectedRun!.id) ?? c.inspectedRun,
                            c.previewAction.id,
                          )
                        }
                      >
                        {tr("Adjust slicing and alignment")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={closeCandidate}>
                        {tr("Return to adopted version")}
                      </Button>
                    </>
                  ) : (
                    <>
                      {c.actionProgress(c.action.id).candidate && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            const item = c.actionProgress(c.action.id).candidate!;
                            c.safe(() => c.inspectCandidate(item.run, item.actionId));
                          }}
                        >
                          {tr("Review new version")}
                        </Button>
                      )}
                      {c.correctionRun && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => c.openSlicing(c.correctionRun!)}
                        >
                          {tr("Inspect processing issues")}
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => c.setVersionsVisible(true)}>
                        <HistoryIcon />
                        {tr("Versions and source")}
                      </Button>
                    </>
                  )}
                </div>
              </div>
              <div className="sb-toolbar">
                <Button
                  size="sm"
                  variant={c.onion ? "secondary" : "ghost"}
                  aria-pressed={c.onion}
                  onClick={() => c.setOnion(!c.onion)}
                >
                  {tr("Onion skin")}
                </Button>
                {project.referenceSourceId && (
                  <Button
                    size="sm"
                    variant={c.compareReference ? "secondary" : "ghost"}
                    aria-pressed={c.compareReference}
                    onClick={() => c.setCompareReference(!c.compareReference)}
                  >
                    {tr("Compare character reference")}
                  </Button>
                )}
                {c.candidate && c.action.frames.length > 0 && (
                  <Button
                    size="sm"
                    variant={compare ? "secondary" : "ghost"}
                    aria-pressed={compare}
                    onClick={() => setCompare(!compare)}
                  >
                    {tr("Before and after")}
                  </Button>
                )}
              </div>
              <div className="sb-action-stage" data-comparing={compare && !!c.candidate}>
                {compare && c.candidate && c.action.frames.length > 0 && (
                  <div className="sb-preview-column">
                    <p className="text-ui-sm text-muted-foreground">
                      {tr("Current adopted version")}
                    </p>
                    <SpritePreview project={project} frame={currentComparisonFrame()} />
                  </div>
                )}
                <div className="sb-preview-column">
                  <SpritePreview
                    zoom={c.previewZoom}
                    onZoomChange={c.setPreviewZoom}
                    project={c.previewProject}
                    frame={c.frame}
                    previous={
                      c.onion && c.index > 0 ? c.previewAction.frames[c.index - 1] : undefined
                    }
                    next={c.onion ? c.previewAction.frames[c.index + 1] : undefined}
                    reference={c.compareReference}
                    onOffset={
                      !c.candidate && c.frame
                        ? (x, y) =>
                            c.editAction((a) => ({
                              ...a,
                              frames: a.frames.map((f) =>
                                f.id === c.frame!.id ? { ...f, offsetX: x, offsetY: y } : f,
                              ),
                            }))
                        : undefined
                    }
                  />
                  {!c.frame && (
                    <div className="space-y-3 p-3 text-center text-ui-sm text-muted-foreground">
                      <p>
                        {tr(
                          c.taskReadStatus !== "ready"
                            ? "Task results unavailable"
                            : c.actionProgress(c.action.id).label === "Not generated"
                              ? "Create an action or import a sprite sheet to begin."
                              : c.actionProgress(c.action.id).label,
                        )}
                      </p>
                      <div className="flex flex-wrap justify-center gap-2">
                        {c.actionProgress(c.action.id).label !== "Not generated" && (
                          <Button variant="outline" onClick={() => c.setQueueVisible(true)}>
                            {tr("Open generation tasks")}
                          </Button>
                        )}
                        <Button variant="outline" onClick={() => c.importRef.current?.click()}>
                          {tr("Import images")}
                        </Button>
                        <Button onClick={() => c.safe(() => c.prepareGeneration("animation"))}>
                          {tr("Generate action")}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
              {c.clipped && (
                <Alert variant="warning" size="sm" className="mx-4 shrink-0">
                  {tr(
                    "Some pixels are outside the canvas. Increase the canvas or adjust the frame offset.",
                  )}
                </Alert>
              )}
              <div className="sb-toolbar justify-center border-t">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={tr("Previous frame")}
                  disabled={!c.frame}
                  onClick={() => {
                    c.setPlaying(false);
                    c.setIndex(Math.max(0, c.index - 1));
                  }}
                >
                  <ChevronLeftIcon />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!c.frame}
                  onClick={() => {
                    if (!c.playing && c.index >= c.previewAction.frames.length - 1) c.setIndex(0);
                    c.setPlaying(!c.playing);
                  }}
                >
                  {c.playing ? <PauseIcon /> : <PlayIcon />}
                  {tr(c.playing ? "Pause" : "Play")}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={tr("Next frame")}
                  disabled={!c.frame}
                  onClick={() => {
                    c.setPlaying(false);
                    c.setIndex(Math.min(c.previewAction.frames.length - 1, c.index + 1));
                  }}
                >
                  <ChevronRightIcon />
                </Button>
                <span className="text-ui-sm text-muted-foreground">
                  {c.frame ? c.index + 1 : 0} / {c.previewAction.frames.length} ·{" "}
                  {c.previewAction.fps} FPS · {tr(c.previewAction.loop ? "Loop" : "Once")}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-expanded={timelineOpen}
                  onClick={() => setTimelineOpen(!timelineOpen)}
                >
                  {tr("Animation frames")}
                </Button>
                {!c.candidate && (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={tr("Add current frame to conversation")}
                    disabled={!c.frame || c.attachmentBusy}
                    onClick={() =>
                      c.frame && c.safe(() => c.addImageToChat(c.frame!.sourceId, true))
                    }
                  >
                    <ChatBubblePlusIcon />
                  </Button>
                )}
              </div>
              {timelineOpen && (
                <>
                  <SpriteResizeHandle
                    horizontal
                    reverse
                    label={tr("Resize timeline")}
                    value={c.timelineHeight}
                    min={120}
                    max={320}
                    onChange={c.setTimelineHeight}
                  />
                  <div
                    className="sb-timeline"
                    style={{ height: c.timelineHeight }}
                    {...spriteImageInput((files) => {
                      if (!c.candidate) c.setPendingImageImport({ files, insertAt: c.index + 1 });
                    })}
                  >
                    <SpriteFramePicker
                      project={c.previewProject}
                      frames={c.previewAction.frames}
                      actionId={c.previewAction.id}
                      index={c.index}
                      selected={c.selected}
                      onSelection={c.setSelected}
                      onPreview={(i) => {
                        c.setIndex(i);
                        c.setPlaying(false);
                      }}
                      onFrames={(frames) => {
                        const ids = new Set(frames.map((f) => f.id));
                        for (const f of c.action.frames)
                          if (!ids.has(f.id)) c.deletedFrames.current.add(f.id);
                        c.editAction((a) => ({ ...a, frames }));
                        c.setIndex(0);
                        c.setPlaying(false);
                      }}
                      onCreate={() => c.setNewActionName(`${c.action.name} copy`)}
                      readOnly={!!c.candidate}
                      onError={c.report}
                    />
                  </div>
                </>
              )}
              {c.candidate && c.inspectedRun && (
                <div className="sb-work-footer">
                  <span className="mr-auto text-ui-sm text-muted-foreground">
                    {tr("Confirm appearance, complete body, alignment and motion before adopting.")}
                  </span>
                  <Button
                    variant="outline"
                    disabled={spriteCandidateStructuralErrors(c.inspectedRun, c.previewAction.id)}
                    onClick={() =>
                      c.safe(() => c.reviewAndAdopt(c.inspectedRun!, [c.previewAction.id], "copy"))
                    }
                  >
                    {tr("Keep as new action")}
                  </Button>
                  {c.candidate.actions.length > 1 && c.candidateSelection.size > 1 && (
                    <Button
                      variant="outline"
                      disabled={
                        [...c.candidateSelection].some((id) =>
                          spriteCandidateStructuralErrors(c.inspectedRun!, id),
                        ) || c.adopting
                      }
                      onClick={() =>
                        c.safe(() => c.reviewAndAdopt(c.inspectedRun!, [...c.candidateSelection]))
                      }
                    >
                      {tr("Confirm review and adopt selected")} ({c.candidateSelection.size})
                    </Button>
                  )}
                  <Button
                    disabled={
                      spriteCandidateStructuralErrors(c.inspectedRun, c.previewAction.id) ||
                      c.adopting ||
                      spriteAdoption(c.inspectedRun, c.previewAction.id, project).status ===
                        "current"
                    }
                    onClick={() =>
                      c.safe(() => c.reviewAndAdopt(c.inspectedRun!, [c.previewAction.id]))
                    }
                  >
                    {tr("Confirm review and adopt")}
                  </Button>
                </div>
              )}
            </>
          )}
        </main>
        {inlineRight && (
          <>
            <SpriteResizeHandle
              reverse
              label={tr("Resize inspector")}
              value={c.rightWidth}
              min={260}
              max={Math.max(260, Math.min(420, c.workbenchWidth - c.leftWidth - 500))}
              onChange={c.setRightWidth}
            />
            <aside className="sb-inspector" style={{ width: inspectorWidth }}>
              {c.versionsVisible ? (
                <>
                  <div className="sb-toolbar border-b">
                    <h2 className="flex-1 text-ui font-medium">{tr("Versions and source")}</h2>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={tr("Close versions")}
                      onClick={() => c.setVersionsVisible(false)}
                    >
                      <XIcon />
                    </Button>
                  </div>
                  <Versions controller={c} />
                </>
              ) : (
                inspector
              )}
            </aside>
          </>
        )}
        {!showLeft && (c.leftVisible || c.materialsVisible) && (
          <WorkAreaPanel
            overlay
            side="left"
            title={tr(c.materialsVisible ? "Image sources" : "Actions list")}
            closeLabel={tr("Close panel")}
            onClose={() => {
              c.setLeftVisible(false);
              c.setMaterialsVisible(false);
            }}
          >
            {c.materialsVisible ? (
              <Materials controller={c} />
            ) : (
              <ObjectNavigation controller={c} />
            )}
          </WorkAreaPanel>
        )}
        {!inlineRight && (
          <div
            className={c.chatVisible || c.versionsVisible ? "contents" : "hidden"}
            inert={!c.chatVisible && !c.versionsVisible}
          >
            <WorkAreaPanel
              overlay
              width={inspectorWidth}
              active={c.chatVisible || c.versionsVisible}
              title={tr(c.versionsVisible ? "Versions and source" : "Inspector")}
              closeLabel={tr("Close panel")}
              onClose={() => {
                c.setChatVisible(false);
                c.setVersionsVisible(false);
              }}
              footer={
                c.repairRun && (c.chatVisible || c.versionsVisible) ? (
                  <div ref={setRepairFooterHost} />
                ) : undefined
              }
            >
              {c.versionsVisible ? <Versions controller={c} /> : inspector}
            </WorkAreaPanel>
          </div>
        )}
      </div>
      <div className="shrink-0" inert={c.adopting}>
        <SpriteTaskQueue controller={c} />
      </div>
      <SpriteWorkbenchDialogs controller={c} />
    </div>
  );
}
