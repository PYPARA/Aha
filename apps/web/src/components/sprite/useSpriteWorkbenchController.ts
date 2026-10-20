/* eslint-disable oxc/no-map-spread -- Immutable snapshots preserve undo history and in-flight processing versions. */
import { EmbeddedChatAttachments } from "../chat/EmbeddedChatAttachments";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useNavigate, useBlocker } from "@tanstack/react-router";
import { spriteBlockedActions, spriteOutputSize } from "@synara/contracts";
import type { SpriteRun, SpriteState, ThreadId } from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { ensureNativeApi } from "~/nativeApi";
import {
  drawingApi,
  imageUrl,
  useImageProviders,
  useDrawingEvents,
  uploadDrawingImage,
} from "../drawing/useDrawing";
import { downloadBlob } from "~/lib/browserDownload";
import { copySpriteSourceToClipboard } from "./spriteClipboard";
import {
  newSpriteProject,
  spriteContext,
  spriteFrameGeometry,
  spriteFrameDuration,
  spriteFrameAtTime,
  removeSpriteSource,
  spriteCharacterSourceIds,
  uuid,
  safeFilename,
  type SpriteProject,
  type SpriteSource,
  type SpriteAction,
} from "./spriteModel";
import { saveSpriteProject, spriteErrorMessage } from "./spriteStorage";
import {
  suggestChromaKey,
  cropSpriteFrameSource,
  decodeSpriteSource,
  exportSpriteAssets,
  type SpriteExportMode,
} from "./spriteFiles";
import { spriteAdoption } from "./spriteAdoption";
import { spriteCandidate, SPRITE_TASK_OPEN } from "./spriteCandidate";
import {
  reviseSpritePlan,
  SPRITE_PLAN_FOCUS,
  focusedSpritePlan,
  type SpriteDraftConflict,
} from "./spritePlanNavigation";
import {
  spriteCombinedActionRun,
  spriteTaskSnapshots,
  spriteProcessingSnapshots,
  spriteFrameRun,
} from "./spriteWorkflowModel";

import {
  readSpriteWorkbenchView,
  spriteActionCandidates,
  spriteActionProgress,
  spriteActionRepairRun,
  snapshotSpriteActions,
  restoreSpriteActionVersion,
  spriteExportFingerprint,
  spriteExportFileList,
  type SpriteWorkbenchSelection,
} from "./spriteWorkbenchModel";
import {
  spriteCreationKey,
  spriteCreationDraftKey,
  spriteTargetDrafts,
  type SpriteCreationTarget,
  type SpriteCreationDraft,
} from "./spriteCreation";
import { decodeSpriteImages } from "./spriteImageInput";
const adoptionKey = (run: SpriteRun, actionId: string) =>
  `${run.id}:${run.selectedCandidateId ?? run.source?.id ?? "legacy"}:${actionId}`;
export function useSpriteWorkbenchController({
  initialProject,
}: {
  initialProject: SpriteProject;
  onBack: () => Promise<void>;
}) {
  const tr = useAhaTranslation();
  const navigate = useNavigate();
  const providers = useImageProviders();
  useDrawingEvents();
  const [project, setProject] = useState<SpriteProject>(initialProject);
  const [playheadMs, setPlayheadMs] = useState(0);
  const currentContextRef = useRef(spriteContext(initialProject));
  const [initialView] = useState(() => readSpriteWorkbenchView(initialProject));
  const [selection, commitSelection] = useState<SpriteWorkbenchSelection>(initialView.selection);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const setSelection = (next: SpriteWorkbenchSelection) => {
    selectionRef.current = next;
    commitSelection(next);
  };
  const autoInspectAction = useRef(
    initialView.selection.phase === "actions" && initialView.selection.mode === "current"
      ? initialView.selection.actionId
      : "",
  );
  const stage = selection.phase;
  const [leftWidth, setLeftWidth] = useState(initialView.leftWidth);
  const [rightWidth, setRightWidth] = useState(initialView.rightWidth);
  const [timelineHeight, setTimelineHeight] = useState(initialView.timelineHeight);
  const [previewZoom, setPreviewZoom] = useState(initialView.zoom);
  const [queueVisible, setQueueVisible] = useState(false);
  const [materialsVisible, setMaterialsVisible] = useState(false);
  const [versionsVisible, setVersionsVisible] = useState(false);
  const [planId, setPlanId] = useState<string | null>(null);
  const [creationTarget, setCreationTarget] = useState<SpriteCreationTarget | null>(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem(`aha-sprite-creation-target:${initialProject.id}`) ?? "null",
      );
      if (saved?.kind === "character") return { kind: "character", actionIds: [] };
      if (
        saved?.kind === "animation" &&
        Array.isArray(saved.actionIds) &&
        saved.actionIds.every((id: string) => initialProject.actions.some((a) => a.id === id))
      )
        return saved;
    } catch {
      /* Restore only valid targets. */
    }
    return null;
  });
  const creationTargetRef = useRef(creationTarget);
  creationTargetRef.current = creationTarget;
  const [creationMode, setCreationMode] = useState<"prompt" | "plan" | "chat">(
    creationTarget ? "prompt" : "chat",
  );
  const [creationSession, setCreationSession] = useState(0);
  const setStage = (phase: "character" | "actions" | "export") => {
    if (phase === "actions") autoInspectAction.current = current.current.selectedActionId;
    setPlanId(null);
    setCreationMode("chat");
    setCreationTarget(null);
    creationTargetRef.current = null;
    localStorage.removeItem(`aha-sprite-creation-target:${current.current.id}`);
    setSelection(
      phase === "actions"
        ? { phase, actionId: current.current.selectedActionId, mode: "current" }
        : { phase },
    );
    setCandidate(null);
    setPlaying(false);
    setSourceId("");
    setRepairRunId(null);
  };
  const [rightTab, setRightTab] = useState<"properties" | "assistant">(initialView.inspector);
  const [leftVisible, setLeftVisible] = useState(false),
    [workbenchWidth, setWorkbenchWidth] = useState(0);
  const workbenchRef = useRef<HTMLDivElement>(null);
  const [generationPrompt, setGenerationPrompt] = useState("");
  const [generationBusy, setGenerationBusy] = useState(false);
  useEffect(() => {
    const element = workbenchRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) =>
      setWorkbenchWidth(entries[0]?.contentRect.width ?? 0),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const current = useRef(project);
  current.current = project;
  const [deleting, setDeleting] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const deletionStarted = useRef(false);
  const [saveStatus, setSaveStatus] = useState("Unsaved changes");
  const errorKey = `${stage}:${stage === "actions" ? project.selectedActionId : ""}`;
  const errorKeyRef = useRef(errorKey);
  errorKeyRef.current = errorKey;
  const [operationErrors, setOperationErrors] = useState<Record<string, string>>({});
  const error = operationErrors[errorKey] ?? "";
  const setError = useCallback(
    (message: string) =>
      setOperationErrors((errors) => ({ ...errors, [errorKeyRef.current]: message })),
    [],
  );
  const importError = operationErrors.materials ?? "";
  const chatError = operationErrors.assistant ?? "";
  const reportChat = useCallback(
    (e: unknown) =>
      setOperationErrors((errors) => ({ ...errors, assistant: spriteErrorMessage(e) })),
    [],
  );
  const [past, setPast] = useState<SpriteProject[]>([]),
    [future, setFuture] = useState<SpriteProject[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set()),
    [index, setIndex] = useState(initialView.frameIndex),
    [playing, setPlaying] = useState(false);
  const [onion, setOnion] = useState(initialView.onion),
    [chatVisible, setChatVisible] = useState(false),
    [sourceId, setSourceId] = useState("");
  const [compareReference, setCompareReference] = useState(initialView.reference);
  const [pendingImageImport, setPendingImageImport] = useState<{
    files: File[];
    insertAt?: number;
  } | null>(null);
  const [renameAction, setRenameAction] = useState<{ id: string; name: string } | null>(null);
  const attachmentBridge = useMemo(() => new EmbeddedChatAttachments(), []);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const attachmentBusyRef = useRef(false);
  const [sourceEdit, setSourceEdit] = useState<{ id: string; name: string } | null>(null);
  const [sourceDelete, setSourceDelete] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState("");
  const [newActionName, setNewActionName] = useState<string | null>(null);
  const deletedSources = useRef(new Set<string>());
  const deletedFrames = useRef(new Set<string>());
  const associationTail = useRef<Promise<void>>(Promise.resolve());
  const removedConversationIds = useRef(new Set<string>());
  const createConversationRef = useRef<(() => Promise<ThreadId>) | null>(null);
  const registerConversationCreator = useCallback((create: (() => Promise<ThreadId>) | null) => {
    createConversationRef.current = create;
  }, []);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [stateLoaded, setStateLoaded] = useState(false);
  const [taskReadStatus, setTaskReadStatus] = useState<
    "loading" | "ready" | "stale" | "partial" | "failed"
  >("loading");
  const [taskReadError, setTaskReadError] = useState("");
  const retryTasksRef = useRef<(() => Promise<void>) | null>(null);
  const [state, setState] = useState<SpriteState>({ context: null, runs: [] });
  const [repairRunId, setRepairRunId] = useState<string | null>(null);
  const [repairFrameIndex, setRepairFrameIndex] = useState(0);
  const [repairActionId, setRepairActionId] = useState<string | null>(null);
  const repairRun = state.runs.find((r) => r.id === repairRunId);
  const [adopting, setAdopting] = useState(false);
  const [updatePrompt, setUpdatePrompt] = useState<string[] | null>(null);
  const resolveUpdate = useRef<((accepted: boolean) => void) | null>(null);
  const finishUpdatePrompt = (accepted: boolean) => {
    resolveUpdate.current?.(accepted);
    resolveUpdate.current = null;
    setUpdatePrompt(null);
  };
  useEffect(() => () => resolveUpdate.current?.(false), []);
  const adoptionLock = useRef(false);
  const adoptionUndo = useRef(
    new Map<string, { before: SpriteProject; after: SpriteProject; ids: string[] }>(),
  );
  const [candidate, setCandidate] = useState<SpriteProject | null>(null),
    [, setCandidateId] = useState<string | null>(null);
  const [exportActionIds, setExportActionIds] = useState<string[] | null>(null);
  const [exportScale, setExportScale] = useState(initialProject.renderSpec?.outputScale ?? 1);
  const [exportMode, setExportMode] = useState<SpriteExportMode>("combined"),
    [allActions, setAllActions] = useState(true),
    [columns, setColumns] = useState(8),
    [gap, setGap] = useState(0);
  const [progress, setProgress] = useState("");
  const abort = useRef<AbortController | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const report = useCallback((e: unknown) => setError(spriteErrorMessage(e)), [setError]);
  const action =
    project.actions.find((a) => a.id === project.selectedActionId) ?? project.actions[0]!;
  const exportActions = project.actions.filter(
    (a) =>
      a.frames.length &&
      (exportActionIds ? exportActionIds.includes(a.id) : allActions || a.id === action.id),
  );
  const exportProject = useMemo(
    () =>
      project.renderSpec?.mode === "pixel"
        ? {
            ...project,
            renderSpec: { ...project.renderSpec, outputScale: exportScale },
            width: project.renderSpec.logicalWidth * exportScale,
            height: project.renderSpec.logicalHeight * exportScale,
          }
        : project,
    [project, exportScale],
  );
  const skippedActions = allActions ? project.actions.length - exportActions.length : 0;
  const [candidateSelection, setCandidateSelection] = useState<Set<string>>(new Set());
  const [candidateTargetId, setCandidateTargetId] = useState("");
  const previewProject = candidate ?? project;
  const previewAction =
    candidate?.actions.find((a) => a.id === candidate.selectedActionId) ??
    candidate?.actions[0] ??
    action;
  const frame = previewAction.frames[Math.min(index, previewAction.frames.length - 1)];
  const frameSource = previewProject.sources.find((s) => s.id === frame?.sourceId);
  const frameMaster = previewProject.sources.find((s) => s.id === frameSource?.masterSourceId);
  const offsetUnit =
    previewProject.renderSpec?.mode === "pixel"
      ? frameSource && frameMaster
        ? frameSource.width / frameMaster.width
        : previewProject.renderSpec.outputScale
      : 1;
  const [specChange, setSpecChange] = useState<{
    width: number;
    height: number;
    renderSpec: SpriteProject["renderSpec"];
    canonical: SpriteProject["canonical"];
  } | null>(null);
  const source = project.sources.find((s) => s.id === sourceId);
  const update = useCallback(
    (fn: (p: SpriteProject) => SpriteProject, history = true, confirmedSpec = false) => {
      if (deletionStarted.current) return;
      const previous = current.current;
      const edited = fn(previous);
      if (
        history &&
        !confirmedSpec &&
        previous.actions.some((a) => a.frames.length) &&
        (!(["mode", "logicalWidth", "logicalHeight", "outputScale"] as const).every(
          (key) => previous.renderSpec?.[key] === edited.renderSpec?.[key],
        ) ||
          previous.width !== edited.width ||
          previous.height !== edited.height)
      ) {
        setSpecChange({
          width: edited.width,
          height: edited.height,
          renderSpec: edited.renderSpec,
          canonical: edited.canonical,
        });
        return;
      }
      if (edited.version === 2 && edited.renderSpec) {
        if (
          edited.renderSpec === previous.renderSpec &&
          (edited.width !== previous.width || edited.height !== previous.height)
        ) {
          edited.renderSpec = {
            ...edited.renderSpec,
            logicalWidth: Math.max(1, Math.round(edited.width / edited.renderSpec.outputScale)),
            logicalHeight: Math.max(1, Math.round(edited.height / edited.renderSpec.outputScale)),
          };
        }
        Object.assign(edited, spriteOutputSize(edited.renderSpec));
        if (
          edited.canonical &&
          (edited.canonical.renderSpec.mode !== edited.renderSpec.mode ||
            edited.canonical.renderSpec.logicalWidth !== edited.renderSpec.logicalWidth ||
            edited.canonical.renderSpec.logicalHeight !== edited.renderSpec.logicalHeight)
        )
          edited.canonical = undefined;
      }
      const used = new Set(
        [...edited.actions, ...(edited.actionVersions ?? []).map((v) => v.action)].flatMap((a) =>
          a.frames.map((f) => f.sourceId),
        ),
      );
      for (const id of spriteCharacterSourceIds(edited)) used.add(id);
      for (const s of edited.sources)
        if (used.has(s.id) && s.masterSourceId) used.add(s.masterSourceId);
      const removedOrigins = edited.provenance.filter(
        (p) => p.localActionId && !edited.actions.some((a) => a.id === p.localActionId),
      );
      const removedKeys = new Set(
        removedOrigins.map((p) => `${p.runId}:${p.candidateId}:${p.actionId}`),
      );
      const next = {
        ...edited,
        sources: edited.sources.filter(
          (s) =>
            !["generated-frame", "generated-master"].includes(s.usage ?? "") ||
            used.has(s.id) ||
            edited.referenceSourceId === s.id,
        ),
        provenance: edited.provenance.filter((p) => !removedOrigins.includes(p)),
        adoptedCandidateIds: edited.adoptedCandidateIds.filter((id) => !removedKeys.has(id)),
        updatedAt: new Date().toISOString(),
      };
      if (history) {
        setPast((items) => [...items.slice(-99), previous]);
        setFuture([]);
      }
      current.current = next;
      setProject(next);
      setSaveStatus("Saving…");
    },
    [],
  );
  const editAction = (fn: (a: SpriteAction) => SpriteAction) =>
    update((p) => ({
      ...p,
      actions: p.actions.map((a) => (a.id === p.selectedActionId ? fn(a) : a)),
    }));
  const resetActionPreview = () => {
    setSelection({ phase: "actions", actionId: current.current.selectedActionId, mode: "current" });
    setRepairRunId(null);
    setCandidate(null);
    setCandidateId(null);
    setSourceId("");
    setIndex(0);
    setPlaying(false);
    setSelected(new Set());
  };
  const duplicateAction = (id: string) => {
    update((p) => {
      const target = p.actions.find((a) => a.id === id);
      if (!target) return p;
      let name = `${target.name} copy`,
        n = 2;
      while (p.actions.some((a) => a.name === name)) name = `${target.name} copy ${n++}`;
      const copy = {
        ...target,
        id: uuid(),
        name,
        frames: target.frames.map((f) => Object.assign({}, f, { id: uuid() })),
      };
      return { ...p, actions: [...p.actions, copy], selectedActionId: copy.id };
    });
    resetActionPreview();
  };
  const removeAction = (id: string) => {
    const target = current.current.actions.find((a) => a.id === id);
    if (!target || current.current.actions.length < 2) return;
    update((p) => ({
      ...p,
      actions: p.actions.filter((a) => a.id !== id),
      selectedActionId:
        p.selectedActionId === id ? p.actions.find((a) => a.id !== id)!.id : p.selectedActionId,
    }));
    resetActionPreview();
  };
  const showActionMenu = async (id: string, position: { x: number; y: number }) => {
    const target = current.current.actions.find((a) => a.id === id);
    if (!target) return;
    const owner = current.current.id;
    const clicked = await ensureNativeApi().contextMenu.show(
      [
        { id: "rename", label: tr("Rename action") },
        { id: "duplicate", label: tr("Duplicate action") },
        ...(current.current.provenance.some((p) => p.localActionId === id)
          ? [{ id: "source", label: tr("View action source") }]
          : []),
        ...(current.current.actions.length > 1
          ? [{ id: "delete", label: tr("Delete action"), destructive: true, separatorBefore: true }]
          : [
              {
                id: "clear",
                label: tr("Clear action frames"),
                destructive: true,
                separatorBefore: true,
              },
            ]),
      ],
      position,
    );
    if (
      deletionStarted.current ||
      current.current.id !== owner ||
      !current.current.actions.some((a) => a.id === id)
    )
      return;
    if (clicked === "rename")
      setRenameAction({ id, name: current.current.actions.find((a) => a.id === id)!.name });
    if (clicked === "duplicate") duplicateAction(id);
    if (clicked === "source") {
      const origin = current.current.provenance.find((p) => p.localActionId === id);
      if (origin) window.dispatchEvent(new CustomEvent(SPRITE_TASK_OPEN, { detail: origin.runId }));
    }
    if (clicked === "delete") removeAction(id);
    if (clicked === "clear") {
      update((p) => ({
        ...p,
        actions: p.actions.map((a) => (a.id === id ? { ...a, frames: [] } : a)),
      }));
      resetActionPreview();
    }
  };
  const save = useCallback(async (p: SpriteProject) => {
    if (deletionStarted.current || adoptionLock.current) return;
    const pending = saveSpriteProject(p);
    await pending;
    if (current.current === p) setSaveStatus("Saved locally");
  }, []);
  useEffect(() => {
    if (deleting) return;
    const timer = setTimeout(() => {
      void associationTail.current
        .catch(() => {})
        .then(() => save(current.current))
        .catch((e) => {
          setSaveStatus("Save failed");
          report(e);
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [project, deleting, save, report]);
  useEffect(
    () => () => {
      if (!deletionStarted.current)
        void associationTail.current
          .catch(() => {})
          .then(() => saveSpriteProject(current.current))
          .catch(() => {});
    },
    [],
  );
  useBlocker({
    shouldBlockFn: async () => {
      if (deletionStarted.current) return false;
      try {
        await associationTail.current;
        await save(current.current);
        return false;
      } catch (error) {
        report(error);
        setSaveStatus("Save failed");
        return true;
      }
    },
    enableBeforeUnload: () => !deletionStarted.current && saveStatus !== "Saved locally",
  });
  const syncContext = useCallback(async () => {
    await associationTail.current.catch(() => {});
    if (deletionStarted.current) throw new Error("This sprite project is being deleted.");
    const snapshot = current.current;
    await save(snapshot);
    await drawingApi().spriteCommand({
      operation: "sync",
      projectId: snapshot.id,
      context: currentContextRef.current,
      threadIds: snapshot.threadIds,
    });
  }, [save]);
  const changeThreads = useCallback(
    (ids: string[], active: string | null) => {
      for (const id of current.current.threadIds)
        if (!ids.includes(id)) removedConversationIds.current.add(id);
      const task = associationTail.current
        .catch(() => {})
        .then(async () => {
          if (!mounted.current || deletionStarted.current)
            throw new Error("This sprite project is being deleted.");
          if (active && removedConversationIds.current.has(active))
            throw new Error("This sprite conversation has been deleted.");
          const retained = ids.filter((id) => !removedConversationIds.current.has(id));
          const next = { ...current.current, threadIds: retained, activeThreadId: active };
          await save(next);
          if (!mounted.current || deletionStarted.current)
            throw new Error("This sprite project is being deleted.");
          update((p) => ({ ...p, threadIds: retained, activeThreadId: active }), false);
          await drawingApi().spriteCommand({
            operation: "sync",
            projectId: next.id,
            context: spriteContext(next),
            threadIds: retained,
          });
        });
      associationTail.current = task;
      return task;
    },
    [save, update],
  );
  useEffect(() => {
    if (deleting || taskReadStatus !== "ready") return;
    const timer = setTimeout(() => {
      void drawingApi()
        .spriteCommand({
          operation: "sync",
          projectId: project.id,
          context: currentContextRef.current,
          threadIds: project.threadIds,
        })
        .catch(report);
    }, 400);
    return () => clearTimeout(timer);
  }, [project, deleting, report, taskReadStatus]);
  useEffect(() => {
    if (deleting) return;
    let alive = true,
      inFlight = false;
    let hasValid = false;
    setStateLoaded(false);
    setTaskReadStatus("loading");
    setTaskReadError("");
    const refresh = async (reload = false) => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await drawingApi().spriteCommand({
          operation: "get",
          projectId: project.id,
          ...(reload ? { reload: true } : {}),
        });
        if (alive) {
          setState(next);
          setStateLoaded(true);
          hasValid = true;
          setTaskReadStatus(next.recovery?.readOnly ? "partial" : "ready");
          setTaskReadError("");
        }
      } catch (e) {
        if (alive) {
          setTaskReadStatus(hasValid ? "stale" : "failed");
          setTaskReadError(spriteErrorMessage(e));
        }
      } finally {
        inFlight = false;
      }
    };
    retryTasksRef.current = () => refresh(true);
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    const unsubscribe = drawingApi().onEvent((event) => {
      if (event.type === "sprite-changed" && event.projectId === project.id) void refresh();
    });
    return () => {
      alive = false;
      clearInterval(timer);
      unsubscribe();
    };
  }, [project.id, deleting, report]);
  useEffect(() => {
    const proven = new Map<
      string,
      { runId: string; candidateId: string; processingVersionId?: string | undefined }
    >();
    for (const run of state.runs.filter((r) => r.input.kind === "animation"))
      for (const c of run.candidates ?? []) {
        if (!current.current.provenance.some((p) => p.runId === run.id)) continue;
        for (const frame of [...c.frames, ...(c.processingVersions ?? []).flatMap((v) => v.frames)])
          proven.set(frame.id, {
            runId: run.id,
            candidateId: c.id,
            processingVersionId: c.processingVersionId,
          });
      }
    const currentProject = current.current;
    const provenance = currentProject.provenance.map((origin) => {
      if (origin.localActionId) return origin;
      const run = state.runs.find((r) => r.id === origin.runId),
        c = run?.candidates?.find((c) => c.id === (origin.candidateId ?? run.candidates?.[0]?.id));
      const output = c?.actions.find((a) => a.action.id === origin.actionId);
      if (!output) return origin;
      const matching = currentProject.actions.filter(
        (a) =>
          a.frames.length === output.frames.length &&
          a.frames.every(
            (f, i) =>
              currentProject.sources.find((s) => s.id === f.sourceId)?.assetId ===
              output.frames[i]!.id,
          ),
      );
      return matching.length === 1
        ? {
            ...origin,
            localActionId: matching[0]!.id,
            candidateId: c!.id,
            processingVersionId: c!.processingVersionId,
          }
        : origin;
    });
    if (
      !currentProject.sources.some((s) => !s.usage && s.assetId && proven.has(s.assetId)) &&
      provenance.every((p, i) => p === currentProject.provenance[i])
    )
      return;
    update(
      (p) => ({
        ...p,
        provenance,
        sources: p.sources.map((s) =>
          !s.usage && s.assetId && proven.has(s.assetId)
            ? { ...s, usage: "generated-frame", origin: proven.get(s.assetId) }
            : s,
        ),
      }),
      false,
    );
  }, [state.runs, update]);
  currentContextRef.current = {
    ...spriteContext(current.current),
    selection: {
      phase: selection.phase,
      ...(selection.phase === "actions"
        ? {
            actionId: selection.actionId,
            candidateId: selection.mode !== "current" ? selection.candidateId : undefined,
            processingVersionId:
              selection.mode !== "current" ? selection.processingVersionId : undefined,
            frameId: frame?.id,
            frameIndex: index,
          }
        : {}),
    },
  };
  const playbackStart = useEffectEvent(() =>
    previewAction.frames
      .slice(0, index)
      .reduce((sum, f) => sum + spriteFrameDuration(previewAction, f), 0),
  );
  useEffect(() => {
    if (!playing || !previewAction.frames.length) return;
    const offset = playbackStart(),
      start = performance.now();
    const duration = previewAction.frames.reduce(
      (sum, f) => sum + spriteFrameDuration(previewAction, f),
      0,
    );
    let animation = 0;
    const tick = (now: number) => {
      const elapsed = offset + now - start;
      setPlayheadMs(elapsed);
      setIndex(spriteFrameAtTime(previewAction, elapsed));
      if (!previewAction.loop && elapsed >= duration) {
        setPlaying(false);
        return;
      }
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [playing, previewAction]);
  useEffect(() => {
    try {
      localStorage.setItem(
        `aha-sprite-workbench:${project.id}`,
        JSON.stringify({
          version: 1,
          selection,
          frameIndex: index,
          inspector: rightTab,
          leftWidth,
          rightWidth,
          timelineHeight,
          onion,
          reference: compareReference,
          zoom: previewZoom,
        }),
      );
    } catch {
      /* Editing remains available when browser storage is full. */
    }
  }, [
    project.id,
    selection,
    index,
    rightTab,
    leftWidth,
    rightWidth,
    timelineHeight,
    onion,
    compareReference,
    previewZoom,
  ]);
  const importImages = async (
    files: File[],
    destination: "frames" | "materials" | "source" = "frames",
    insertAt?: number,
  ) => {
    const owner = current.current.id;
    if (
      files.length > 128 ||
      files.reduce(
        (n, f) => n + f.size,
        current.current.sources.reduce((n, s) => n + s.blob.size, 0),
      ) >
        80 * 1024 * 1024
    )
      throw new Error("Import at most 128 images / 80 MiB at once.");
    const { sources, errors } = await decodeSpriteImages(files);
    if (errors.length)
      setOperationErrors((previous) => ({
        ...previous,
        [destination === "materials" ? "materials" : errorKeyRef.current]: errors.join("\n"),
      }));
    if (
      !mounted.current ||
      deletionStarted.current ||
      current.current.id !== owner ||
      !sources.length
    )
      return;
    update((p) => ({
      ...p,
      sources: [...p.sources, ...sources],
      width:
        p.version === 2
          ? p.width
          : Math.max(
              p.sources.length ? p.width : 1,
              ...sources.map((s) => Math.min(s.width, 4096)),
            ),
      height:
        p.version === 2
          ? p.height
          : Math.max(
              p.sources.length ? p.height : 1,
              ...sources.map((s) => Math.min(s.height, 4096)),
            ),
      actions: p.actions.map((a) =>
        destination !== "frames" || a.id !== p.selectedActionId
          ? a
          : {
              ...a,
              frames: [
                ...a.frames.slice(0, insertAt ?? a.frames.length),
                ...sources.map((s) => ({
                  id: uuid(),
                  sourceId: s.id,
                  x: 0,
                  y: 0,
                  width: s.width,
                  height: s.height,
                  offsetX: 0,
                  offsetY: 0,
                })),
                ...a.frames.slice(insertAt ?? a.frames.length),
              ],
            },
      ),
    }));
    if (destination !== "materials") setIndex(0);
    if (sources.length === 1 && destination !== "materials") setSourceId(sources[0]!.id);
  };
  const addImageToChat = async (sourceId: string, currentFrame = false) => {
    if (attachmentBusyRef.current || deletionStarted.current) return;
    attachmentBusyRef.current = true;
    setAttachmentBusy(true);
    try {
      const snapshot = current.current;
      let target = snapshot.activeThreadId;
      setChatVisible(true);
      if (!target) {
        for (let attempt = 0; !createConversationRef.current && attempt < 50; attempt++)
          await new Promise((resolve) => setTimeout(resolve, 100));
        if (!mounted.current || deletionStarted.current || !createConversationRef.current)
          throw new Error("Conversation is loading. Try again when it is ready.");
        target = await createConversationRef.current();
      }
      const original = snapshot.sources.find((s) => s.id === sourceId);
      if (!original) return;
      deletedSources.current.delete(original.id);
      const chosenFrame = currentFrame ? frame : null;
      if (chosenFrame) deletedFrames.current.delete(chosenFrame.id);
      setChatVisible(true);
      // Capture target before cropping. Never route this file to a newly selected thread.
      for (let attempt = 0; !attachmentBridge.ready(target) && attempt < 50; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (
          !mounted.current ||
          deletionStarted.current ||
          current.current.activeThreadId !== target
        )
          throw new Error("Conversation is loading. Try again when it is ready.");
      }
      await attachmentBridge.attach(target, async () => {
        const image = chosenFrame
          ? await cropSpriteFrameSource(original, chosenFrame, `${action.name}-${index + 1}.png`)
          : original;
        if (
          !mounted.current ||
          deletionStarted.current ||
          deletedSources.current.has(original.id) ||
          (chosenFrame && deletedFrames.current.has(chosenFrame.id))
        )
          throw new Error("The selected image has been removed.");
        return [new File([image.blob], image.name.slice(0, 255), { type: image.blob.type })];
      });
    } finally {
      attachmentBusyRef.current = false;
      if (mounted.current) setAttachmentBusy(false);
    }
  };
  const showSourceMenu = async (id: string, position: { x: number; y: number }) => {
    const owner = current.current.id;
    const clicked = await ensureNativeApi().contextMenu.show(
      [
        { id: "copy-image", label: tr("Copy Image") },
        { id: "rename", label: tr("Rename image") },
        { id: "attach", label: tr("Add to conversation") },
        { id: "delete", label: tr("Delete image"), destructive: true, separatorBefore: true },
      ],
      position,
    );
    const source = current.current.sources.find((s) => s.id === id);
    if (!source || current.current.id !== owner || deletionStarted.current) return;
    if (clicked === "copy-image") {
      const isCurrent = () =>
        mounted.current &&
        current.current.id === owner &&
        !deletionStarted.current &&
        current.current.sources.some((s) => s.id === source.id);
      await copySpriteSourceToClipboard(source.blob, isCurrent);
      if (isCurrent()) setCopyNotice("Image copied to clipboard.");
    }
    if (clicked === "rename") setSourceEdit({ id, name: source.name });
    if (clicked === "attach") await addImageToChat(id);
    if (clicked === "delete") setSourceDelete(id);
  };
  const removeSource = (id: string) => {
    if (spriteCharacterSourceIds(current.current).has(id)) {
      setOperationErrors((errors) => ({
        ...errors,
        materials: "This image is retained by a character reference or saved action version.",
      }));
      setSourceDelete(null);
      return;
    }
    deletedSources.current.add(id);
    for (const f of current.current.actions.flatMap((a) => a.frames))
      if (f.sourceId === id) deletedFrames.current.add(f.id);
    update((p) => removeSpriteSource(p, id));
    resetActionPreview();
    setSourceDelete(null);
    setMaterialsVisible(false);
  };
  const isAdopted = (run: SpriteRun, actionId: string) =>
    ["current", "unknown"].includes(spriteAdoption(run, actionId, current.current).status);
  const [inspectedRun, setInspectedRun] = useState<SpriteRun | null>(null);
  const loadCandidate = async (run: SpriteRun, selectedIds?: readonly string[]) => {
    const owner = current.current.id;
    const sources: SpriteSource[] = [];
    const masterSources: SpriteSource[] = [];
    const frameOwners = new Map(
      (run.assembledRunIds
        ? state.runs.filter((part) => run.assembledRunIds!.includes(part.id))
        : [run]
      ).flatMap((part) => part.frames.map((asset) => [asset.id, part] as const)),
    );
    const allOutputs = run.actions?.length
      ? run.actions
      : [
          {
            action: {
              id: "legacy",
              name: run.context.action,
              fps: run.context.fps,
              loop: run.input.loop ?? true,
            },
            frames: run.frames,
          },
        ];
    const outputs = selectedIds
      ? allOutputs.filter((o) => selectedIds.includes(o.action.id))
      : allOutputs;
    const masterIds = new Map(
      (run.actions ?? []).flatMap((o) => o.frames.map((a, i) => [a.id, o.masters?.[i]] as const)),
    );
    for (const asset of outputs.flatMap((o) => o.frames)) {
      const response = await fetch(imageUrl(asset), { credentials: "include" });
      if (!response.ok) throw new Error("Could not download candidate.");
      const source = await decodeSpriteSource(await response.blob(), asset.name);
      const frameOwner = frameOwners.get(asset.id) ?? run;
      sources.push({
        ...source,
        assetId: asset.id,
        usage: "generated-frame",
        origin: {
          runId: frameOwner.id,
          candidateId: frameOwner.selectedCandidateId ?? frameOwner.source!.id,
          processingVersionId: spriteCandidate(frameOwner)?.processingVersionId,
        },
      });
      const master = masterIds.get(asset.id);
      if (master) {
        const response = await fetch(imageUrl(master), { credentials: "include" });
        if (!response.ok) throw new Error("Could not download logical master.");
        const logical = {
          ...(await decodeSpriteSource(await response.blob(), master.name)),
          assetId: master.id,
          usage: "generated-master" as const,
        };
        sources[sources.length - 1]!.masterSourceId = logical.id;
        // Keep frame sources first: their temporal order is used below.
        masterSources.push(logical);
      }
    }
    const originalSources: SpriteSource[] = [];
    const partRuns = run.assembledRunIds
      ? state.runs.filter((r) => run.assembledRunIds!.includes(r.id))
      : [run];
    for (const part of partRuns) {
      const asset = part.source;
      if (!asset) continue;
      const existing = current.current.sources.find((s) => s.assetId === asset.id);
      if (existing) {
        originalSources.push(existing);
        continue;
      }
      const response = await fetch(imageUrl(asset), { credentials: "include" });
      if (!response.ok) throw new Error("Could not download source image for the repair snapshot.");
      originalSources.push({
        ...(await decodeSpriteSource(await response.blob(), asset.name)),
        assetId: asset.id,
        usage: "material",
        origin: {
          runId: part.id,
          candidateId: part.selectedCandidateId ?? asset.id,
          processingVersionId: spriteCandidate(part)?.processingVersionId,
        },
      });
    }
    if (deletionStarted.current || !mounted.current || current.current.id !== owner) return;
    const p = newSpriteProject();
    let frameOffset = 0;
    const actions = outputs.map((output) => {
      const frames = sources.slice(frameOffset, frameOffset + output.frames.length).map((s, i) => ({
        id: ("frameMetadata" in output ? output.frameMetadata?.[i]?.id : undefined) ?? uuid(),
        ...("frameMetadata" in output && output.frameMetadata?.[i]?.durationMs
          ? { durationMs: output.frameMetadata[i]!.durationMs }
          : {}),
        sourceId: s.id,
        x: 0,
        y: 0,
        width: s.width,
        height: s.height,
        offsetX: 0,
        offsetY: 0,
      }));
      frameOffset += output.frames.length;
      return {
        id: output.action.id,
        name: output.action.name,
        description: "description" in output.action ? output.action.description : "",
        plannedFrameCount: run.importOrigin
          ? current.current.actions.find((a) => a.id === output.action.id)?.plannedFrameCount
          : Math.min(32, output.frames.length),
        fps: output.action.fps,
        loop: output.action.loop,
        frames,
      };
    });
    return {
      ...p,
      width: run.context.width,
      height: run.context.height,
      version: run.context.workflowVersion === 2 ? (2 as const) : (1 as const),
      renderSpec: run.context.renderSpec,
      canonical: run.context.canonical,
      referenceSourceId: current.current.referenceSourceId,
      sources: [
        ...sources,
        ...masterSources,
        ...originalSources,
        ...current.current.sources.filter((s) => s.id === current.current.referenceSourceId),
      ],
      actions,
      selectedActionId: actions[0]!.id,
    };
  };
  const candidateRequest = useRef(0);
  const inspectCandidate = async (
    run: SpriteRun,
    outputActionId?: string,
    restoreIndex?: number,
    runs: readonly SpriteRun[] = state.runs,
  ) => {
    const request = ++candidateRequest.current;
    const complete = spriteCombinedActionRun(run, runs);
    if (!complete) throw new Error("Wait for every segment before reviewing the complete action.");
    run = complete;
    const outputId = outputActionId ?? run.actions?.[0]?.action.id ?? "legacy";
    const local =
      spriteAdoption(run, outputId, current.current).localActionId ??
      current.current.actions.find((a) => a.id === outputId)?.id ??
      current.current.selectedActionId;
    setSelection({
      phase: "actions",
      actionId: local,
      mode: "candidate",
      runId: run.id,
      candidateId: run.selectedCandidateId ?? run.source!.id,
      processingVersionId: spriteCandidate(run)?.processingVersionId,
    });
    if (current.current.actions.some((a) => a.id === local))
      update((p) => ({ ...p, selectedActionId: local }), false);
    setRepairRunId(null);
    setPlaying(false);
    setLeftVisible(false);
    const prepared = await loadCandidate(run);
    if (
      !prepared ||
      request !== candidateRequest.current ||
      selectionRef.current.phase !== "actions" ||
      selectionRef.current.mode !== "candidate" ||
      selectionRef.current.runId !== run.id
    )
      return;
    if (prepared.actions.some((a) => a.id === outputId)) prepared.selectedActionId = outputId;
    setSourceId("");
    setCandidate(prepared);
    setCandidateTargetId("");
    const actions = prepared.actions;
    setCandidateSelection(new Set(actions.filter((a) => !isAdopted(run, a.id)).map((a) => a.id)));
    setInspectedRun(run);
    setCandidateId(run.id);
    setIndex(
      Math.min(
        restoreIndex ?? 0,
        Math.max(
          0,
          prepared.actions.find((a) => a.id === prepared.selectedActionId)!.frames.length - 1,
        ),
      ),
    );
  };
  const adopt = async (
    all = false,
    supplied?: SpriteProject,
    suppliedRun?: SpriteRun,
    selection?: Set<string>,
    replace: boolean | "copy" = false,
  ): Promise<boolean> => {
    const run = suppliedRun ?? inspectedRun;
    const preview = supplied ?? candidate;
    if (!preview || !run) return false;
    const selected = preview.actions
      .filter((a) =>
        all ? (selection ?? candidateSelection).has(a.id) : a.id === preview.selectedActionId,
      )
      .filter((a) => replace || candidateTargetId || !isAdopted(run, a.id));
    if (!selected.length) {
      const existing = current.current.provenance.find(
        (p) =>
          p.runId === run.id &&
          p.candidateId === (run.selectedCandidateId ?? run.source?.id) &&
          p.localActionId,
      );
      if (existing) update((p) => ({ ...p, selectedActionId: existing.localActionId! }), false);
      return false;
    }
    const record = spriteCandidate(run),
      blocked = record
        ? spriteBlockedActions(record)
        : new Set(run.status === "needs-adjustment" ? selected.map((a) => a.id) : []);
    if (selected.some((a) => blocked.has(a.id)))
      throw new Error("Review the layout before adding this action.");
    const sourceIds = new Set(selected.flatMap((a) => a.frames.map((f) => f.sourceId)));
    for (const s of preview.sources)
      if (sourceIds.has(s.id) && s.masterSourceId) sourceIds.add(s.masterSourceId);
    const originalAssets = new Set(
      spriteProcessingSnapshots(run, state.runs).map((s) => s.sourceAssetId),
    );
    for (const source of preview.sources)
      if (source.assetId && originalAssets.has(source.assetId)) sourceIds.add(source.id);
    const accepted = {
      ...preview,
      actions: selected,
      sources: preview.sources.filter((s) => sourceIds.has(s.id)),
    };
    const owner = current.current.id;
    const chromaKey =
      run.input.kind === "character"
        ? await suggestChromaKey(accepted.sources[0]!.blob)
        : current.current.chromaKey;
    if (
      deletionStarted.current ||
      !mounted.current ||
      current.current.id !== owner ||
      (!replace && !candidateTargetId && selected.some((a) => isAdopted(run, a.id)))
    )
      return false;
    const base = current.current;
    const updates =
      replace === "copy"
        ? []
        : selected.filter(
            (a) =>
              spriteAdoption(run, a.id, base).status === "update" ||
              replace ||
              !!base.actions.find((old) => old.id === a.id && old.frames.length) ||
              (selected.length === 1 &&
                candidateTargetId &&
                base.actions.find((a) => a.id === candidateTargetId)?.frames.length),
          );
    if (updates.length) {
      if (resolveUpdate.current) throw new Error("An adoption is already being saved.");
      const accepted = await new Promise<boolean>((resolve) => {
        resolveUpdate.current = resolve;
        setUpdatePrompt(updates.map((a) => a.name));
      });
      if (!accepted || !mounted.current || deletionStarted.current || current.current.id !== owner)
        return false;
      if (current.current !== base)
        throw new Error("Project changed while saving. Reload before adding actions.");
    }
    const sourceMap = new Map(base.sources.filter((s) => s.assetId).map((s) => [s.assetId!, s]));
    const remap = new Map<string, string>();
    const incoming: SpriteSource[] = [];
    for (const source of accepted.sources) {
      const existing = source.assetId ? sourceMap.get(source.assetId) : undefined;
      if (existing) remap.set(source.id, existing.id);
      else {
        incoming.push(source);
        remap.set(source.id, source.id);
        if (source.assetId) sourceMap.set(source.assetId, source);
      }
    }
    if (
      base.sources.reduce((n, s) => n + s.blob.size, 0) +
        incoming.reduce((n, s) => n + s.blob.size, 0) >
      80 * 1024 * 1024
    )
      throw new Error("Project images exceed 80 MiB. Create another project.");
    if (
      base.sources.length + incoming.length > 1024 ||
      base.actions.length +
        selected.filter(
          (a) => replace === "copy" || spriteAdoption(run, a.id, base).status === "new",
        ).length >
        1024
    )
      throw new Error("Project exceeds 1024 images or actions.");
    const mappings = selected.map((a) => {
      const existing = spriteAdoption(run, a.id, base);
      if (existing.status === "unknown" && replace !== "copy" && !candidateTargetId)
        throw new Error("Historical source needs review");
      return {
        generated: a.id,
        local:
          replace === "copy"
            ? uuid()
            : ((selected.length === 1 && candidateTargetId ? candidateTargetId : undefined) ??
              existing.localActionId ??
              base.actions.find((b) => b.id === a.id)?.id ??
              uuid()),
      };
    });
    const adoptedActions = accepted.actions.map((a) =>
      Object.assign({}, a, {
        id: mappings.find((m) => m.generated === a.id)!.local,
        frames: a.frames.map((f) => ({ ...f, sourceId: remap.get(f.sourceId)! })),
      }),
    );
    const replacedIds = new Set(
      adoptedActions.filter((a) => base.actions.some((old) => old.id === a.id)).map((a) => a.id),
    );
    const next: SpriteProject = {
      ...base,
      actionVersions: snapshotSpriteActions(base, [...replacedIds]),
      updatedAt: new Date().toISOString(),
      sources: [
        ...base.sources,
        ...incoming.map((s) =>
          Object.assign({}, s, {
            masterSourceId: s.masterSourceId ? remap.get(s.masterSourceId) : undefined,
          }),
        ),
      ],
      chromaKey,
      actions:
        run.input.kind === "character"
          ? base.actions
          : [
              ...base.actions.map((a) => adoptedActions.find((n) => n.id === a.id) ?? a),
              ...adoptedActions.filter((a) => !base.actions.some((b) => b.id === a.id)),
            ],
      selectedActionId:
        run.input.kind === "character" ? base.selectedActionId : adoptedActions[0]!.id,
      referenceSourceId: base.referenceSourceId,
      adoptedCandidateIds: [
        ...new Set([...base.adoptedCandidateIds, ...selected.map((a) => adoptionKey(run, a.id))]),
      ],
      provenance: [
        ...base.provenance.filter((p) => !p.localActionId || !replacedIds.has(p.localActionId)),
        ...selected.map((a) => ({
          runId: run.id,
          segmentRunIds: run.assembledRunIds ? [...run.assembledRunIds] : undefined,
          taskSnapshots: spriteTaskSnapshots(run, state.runs),
          processingSnapshots: spriteProcessingSnapshots(run, state.runs),
          candidateId: run.selectedCandidateId ?? run.source?.id,
          processingVersionId: record?.processingVersionId,
          localActionId: mappings.find((m) => m.generated === a.id)!.local,
          actionId: a.id,
          planId: run.planId,
          prompt: run.input.prompt,
          action: a.name,
          model: run.context.model,
          providerId: run.context.providerId,
        })),
      ],
    };
    next.actionVersions = snapshotSpriteActions(
      next,
      adoptedActions.map((a) => a.id),
    );
    if (adoptionLock.current) throw new Error("An adoption is already being saved.");
    adoptionLock.current = true;
    setAdopting(true);
    try {
      await saveSpriteProject(next);
      if (current.current.id !== owner || deletionStarted.current) return false;
      if (current.current !== base) {
        await saveSpriteProject(current.current);
        throw new Error("Project changed while saving. Reload before adding actions.");
      }
      update(() => next);
      adoptionUndo.current.set(`${run.id}:${run.selectedCandidateId ?? run.source?.id}`, {
        before: base,
        after: next,
        ids: adoptedActions.map((a) => a.id),
      });
      setSaveStatus("Saved locally");
    } finally {
      adoptionLock.current = false;
      setAdopting(false);
    }
    setSelection({ phase: "actions", actionId: current.current.selectedActionId, mode: "current" });
    setCandidate(null);
    setCandidateId(null);
    setPlaying(false);
    setIndex(0);
    return true;
  };
  const [originalImage, setOriginalImage] = useState<import("@synara/contracts").ImageAsset | null>(
    null,
  );
  const [draftConflict, setDraftConflict] = useState<{
    error: SpriteDraftConflict;
    input: import("@synara/contracts").SpriteCommand;
  } | null>(null);
  const openPlanConversation = async (threadId: string, planId: string) => {
    await changeThreads(current.current.threadIds, threadId);
    setPlanId(planId);
    setRightTab("assistant");
    setChatVisible(true);
    setCreationMode("plan");
    setVersionsVisible(false);
    setMaterialsVisible(false);
  };
  const handlePlanNavigation = useEffectEvent((id: string) => {
    if (state.plans?.some((p) => p.id === id)) {
      setPlanId(id);
      setRightTab("assistant");
      setChatVisible(true);
      setCreationMode("plan");
      setVersionsVisible(false);
      setMaterialsVisible(false);
      setQueueVisible(false);
    }
  });
  const handleTaskNavigation = useEffectEvent((id: string) => {
    const run = state.runs.find((r) => r.id === id);
    if (!run) return;
    const combined = spriteCombinedActionRun(run, state.runs);
    if (combined && run.input.kind === "animation") safe(() => inspectCandidate(combined));
    else setQueueVisible(true);
  });
  useEffect(() => {
    const open = (event: Event) => handlePlanNavigation((event as CustomEvent<string>).detail);
    const task = (event: Event) => handleTaskNavigation((event as CustomEvent<string>).detail);
    window.addEventListener(SPRITE_PLAN_FOCUS, open);
    window.addEventListener(SPRITE_TASK_OPEN, task);
    return () => {
      window.removeEventListener(SPRITE_PLAN_FOCUS, open);
      window.removeEventListener(SPRITE_TASK_OPEN, task);
    };
  }, []);
  useEffect(() => {
    const pending = focusedSpritePlan();
    if (pending) handlePlanNavigation(pending);
  }, [state.plans]);
  const runCommand = async (run: SpriteRun, operation: "cancel" | "retry", actionId?: string) => {
    const owner = project.id;
    const input = { operation, projectId: owner, runId: run.id, ...(actionId ? { actionId } : {}) };
    try {
      const next =
        operation === "retry"
          ? await reviseSpritePlan(input)
          : await drawingApi().spriteCommand(input);
      if (current.current.id === owner) {
        setState(next);
        if (next.resultPlanId && run.context.threadId)
          await openPlanConversation(run.context.threadId, next.resultPlanId);
      }
    } catch (e) {
      if ((e as SpriteDraftConflict).currentPlan)
        setDraftConflict({ error: e as SpriteDraftConflict, input });
      else throw e;
    }
  };
  const exportAssets = async () => {
    const controller = new AbortController();
    abort.current = controller;
    setProgress("Preparing export…");
    try {
      const snapshot = exportProject;
      const formal = current.current;
      const actionIds = exportActions.map((a) => a.id);
      const versions = snapshotSpriteActions(formal, actionIds);
      const fingerprint = await spriteExportFingerprint(snapshot, actionIds);
      const blob = await exportSpriteAssets(
        snapshot,
        actionIds,
        exportMode,
        columns,
        gap,
        controller.signal,
        setProgress,
      );
      if (current.current !== formal)
        throw new Error("Project changed during export. Try exporting again.");
      downloadBlob(blob, `${safeFilename(project.name)}-${exportMode}.zip`);
      controller.signal.throwIfAborted();
      update(
        (p) => ({
          ...p,
          actionVersions: versions,
          lastExport: {
            createdAt: new Date().toISOString(),
            actionIds,
            actionVersionIds: actionIds.map(
              (id) => versions.findLast((v) => v.action.id === id)!.id,
            ),
            outputScale: snapshot.renderSpec?.outputScale ?? 1,
            fingerprint,
            mode: exportMode,
            columns,
            gap,
            files: spriteExportFileList(snapshot, actionIds, exportMode),
          },
        }),
        false,
      );
    } finally {
      setProgress("");
      abort.current = null;
    }
  };
  const undo = () => {
    const next = past.at(-1);
    if (!next) return;
    setPast((p) => p.slice(0, -1));
    setFuture((f) => [...f, current.current]);
    update((p) => ({ ...next, threadIds: p.threadIds, activeThreadId: p.activeThreadId }), false);
  };
  const undoAdoption = (run: SpriteRun) => {
    const key = `${run.id}:${run.selectedCandidateId ?? run.source?.id}`,
      entry = adoptionUndo.current.get(key);
    if (!entry) return;
    update((p) => {
      const ids = new Set(entry.ids),
        old = entry.before.actions.filter((a) => ids.has(a.id)),
        existing = p.actions.filter((a) => !ids.has(a.id));
      const sources = new Map(p.sources.map((s) => [s.id, s]));
      for (const source of entry.before.sources) sources.set(source.id, source);
      return {
        ...p,
        actions: [
          ...p.actions.flatMap((action) =>
            !ids.has(action.id) ? [action] : old.filter((previous) => previous.id === action.id),
          ),
          ...old.filter((previous) => !p.actions.some((action) => action.id === previous.id)),
        ],
        sources: [...sources.values()],
        selectedActionId: existing.some((a) => a.id === p.selectedActionId)
          ? p.selectedActionId
          : (old[0]?.id ?? existing[0]!.id),
        provenance: [
          ...p.provenance.filter((o) => !o.localActionId || !ids.has(o.localActionId)),
          ...entry.before.provenance.filter((o) => o.localActionId && ids.has(o.localActionId)),
        ],
        adoptedCandidateIds: p.adoptedCandidateIds.filter(
          (id) =>
            !entry.after.adoptedCandidateIds.includes(id) ||
            entry.before.adoptedCandidateIds.includes(id),
        ),
      };
    });
    adoptionUndo.current.delete(key);
  };
  const redo = () => {
    const next = future.at(-1);
    if (!next) return;
    setFuture((f) => f.slice(0, -1));
    setPast((p) => [...p, current.current]);
    update((p) => ({ ...next, threadIds: p.threadIds, activeThreadId: p.activeThreadId }), false);
  };
  const safe = (fn: () => Promise<unknown>, scope = errorKeyRef.current) => {
    if (adoptionLock.current) return;
    setOperationErrors((errors) => ({ ...errors, [scope]: "" }));
    setCopyNotice("");
    void fn().catch((e) =>
      setOperationErrors((errors) => ({ ...errors, [scope]: spriteErrorMessage(e) })),
    );
  };
  const prepareGeneration = async (
    kind: "character" | "animation",
    actionIds?: readonly string[],
  ) => {
    const target: SpriteCreationTarget = {
      kind,
      actionIds:
        kind === "character"
          ? []
          : [...(actionIds ?? [current.current.selectedActionId])].toSorted(),
    };
    setCreationTarget(target);
    creationTargetRef.current = target;
    localStorage.setItem(
      `aha-sprite-creation-target:${current.current.id}`,
      JSON.stringify(target),
    );
    const existing = spriteTargetDrafts(state.plans ?? [], target);
    setPlanId(existing.length === 1 ? existing[0]!.id : null);
    setCreationMode(existing.length === 1 ? "plan" : "prompt");
    setRightTab("assistant");
    setChatVisible(true);
    setLeftVisible(false);
    setVersionsVisible(false);
    setMaterialsVisible(false);
    try {
      const fresh = await drawingApi().spriteCommand({
        operation: "get",
        projectId: current.current.id,
      });
      if (
        !creationTargetRef.current ||
        spriteCreationKey(creationTargetRef.current) !== spriteCreationKey(target)
      )
        return;
      setState(fresh);
      const drafts = spriteTargetDrafts(fresh.plans ?? [], target);
      setPlanId(drafts.length === 1 ? drafts[0]!.id : null);
      setCreationMode(drafts.length === 1 ? "plan" : "prompt");
    } catch (error) {
      if (
        creationTargetRef.current &&
        spriteCreationKey(creationTargetRef.current) === spriteCreationKey(target)
      )
        reportChat(error);
    }
  };
  const submitGeneration = async (buffer: SpriteCreationDraft) => {
    const target = creationTargetRef.current;
    if (!target || !buffer.prompt.trim() || generationBusy) return;
    const targetKey = spriteCreationKey(target);
    setGenerationBusy(true);
    try {
      let threadId = current.current.activeThreadId;
      if (!threadId) {
        if (!createConversationRef.current)
          throw new Error("Conversation is not ready. Try again.");
        threadId = await createConversationRef.current();
      }
      await syncContext();
      const p = current.current;
      if (buffer.references.length)
        await drawingApi().spriteCommand({
          operation: "import-references",
          projectId: p.id,
          threadId,
          references: buffer.references,
        });
      const provider =
        providers.data?.find((v) => v.id === p.providerId && v.enabled) ??
        providers.data?.find((v) => v.enabled);
      const model = provider?.models.some((m) => m.id === p.model)
        ? p.model
        : (provider?.defaultModel ?? "");
      const result = await drawingApi().spriteCommand({
        operation: "propose",
        projectId: p.id,
        context: spriteContext(p),
        input: { kind: target.kind, prompt: buffer.prompt.trim(), requestId: buffer.requestId },
        configuration: {
          workflowVersion: p.version === 2 ? 2 : undefined,
          renderSpec: p.renderSpec,
          canonical: p.canonical,
          ...(target.kind === "animation"
            ? {
                sizing: {
                  version: 1 as const,
                  mode: "linked" as const,
                  sourceScale: 1 as const,
                  arrangement: "auto" as const,
                  margin: 0,
                  gap: 0,
                },
              }
            : {}),
          kind: target.kind,
          mode: "separate",
          prompt: buffer.prompt.trim(),
          actions: p.actions
            .filter((a) => target.kind === "character" || target.actionIds.includes(a.id))
            .map((a) => ({
              id: a.id,
              name: a.name,
              description: a.description ?? a.name,
              enabled: true,
              frameCount: a.plannedFrameCount ?? p.generationFrameCount,
              fps: a.fps,
              loop: a.loop,
            })),
          references: buffer.references,
          providerId: provider?.id ?? "",
          model,
          width: p.width,
          height: p.height,
          background: p.background,
          chromaKey: p.chromaKey,
          sizeSource: "user",
          parameters: { n: 1, size: "1024x1024", quality: "auto", outputFormat: "png" },
        },
      });
      if (current.current.id !== p.id || !mounted.current) return;
      setState(result);
      if (creationTargetRef.current && spriteCreationKey(creationTargetRef.current) === targetKey) {
        setPlanId(result.resultPlanId ?? null);
        setCreationMode("plan");
      }
    } finally {
      setGenerationBusy(false);
    }
  };
  const startNewGeneration = async () => {
    const plan = state.plans?.find((p) => p.id === planId);
    if (plan?.status === "draft")
      setState(
        await drawingApi().spriteCommand({
          operation: "dismiss-plan",
          projectId: project.id,
          planId: plan.id,
          version: plan.version,
        }),
      );
    if (creationTarget) localStorage.removeItem(spriteCreationDraftKey(project.id, creationTarget));
    setPlanId(null);
    setCreationMode("prompt");
    setCreationSession((n) => n + 1);
  };
  useEffect(() => {
    if (!creationTarget || creationMode !== "prompt") return;
    const drafts = spriteTargetDrafts(state.plans ?? [], creationTarget);
    if (drafts.length === 1) {
      setPlanId(drafts[0]!.id);
      setCreationMode("plan");
    }
  }, [creationTarget, creationMode, state.plans]);
  const replaceSlicingSource = async (files: File[]) => {
    if (!repairRun || !files[0]) return;
    const requestedRun = repairRun;
    const p = current.current;
    const { sources, errors } = await decodeSpriteImages([files[0]]);
    if (errors.length) throw new Error(errors.join("\n"));
    const source = sources[0]!;
    if (current.current.id !== p.id) return;
    if (
      current.current.sources.reduce((total, item) => total + item.blob.size, 0) +
        source.blob.size >
      80 * 1024 * 1024
    )
      throw new Error("Project images exceed 80 MiB. Create another project.");
    const asset = await uploadDrawingImage(source.blob, source.name);
    update((value) => ({
      ...value,
      sources: [...value.sources, { ...source, assetId: asset.id, usage: "material" as const }],
    }));
    const next = await drawingApi().spriteCommand({
      operation: "inspect-source",
      projectId: p.id,
      context: spriteContext(p),
      configuration: requestedRun.configuration,
      references: [
        { referenceId: `project:${asset.id}`, asset, role: "reference", actionId: null },
      ],
    });
    if (current.current.id !== p.id) return;
    setState(next);
    const imported = next.runs.find((r) => r.importOrigin?.sourceAssetId === asset.id);
    if (imported) {
      setRepairRunId(imported.id);
      setRepairActionId(imported.configuration?.actions[0]?.id ?? null);
    }
  };
  const activePlan = creationTarget
    ? spriteTargetDrafts(state.plans ?? [], creationTarget).at(-1)
    : undefined;
  const placement = frame ? spriteFrameGeometry(previewProject, frame) : null;
  const clipped =
    frame &&
    placement &&
    (placement.x < 0 ||
      placement.y < 0 ||
      placement.x + placement.width > previewProject.width ||
      placement.y + placement.height > previewProject.height);
  const actionCandidates = spriteActionCandidates(project, state);
  const correctionRun = spriteActionRepairRun(project, state, action.id);
  const actionProgress = (id: string) =>
    spriteActionProgress(
      project,
      state,
      project.actions.find((a) => a.id === id)!,
      actionCandidates,
    );
  const selectAction = (id: string) => {
    autoInspectAction.current = id;
    setPlanId(null);
    setCreationMode("chat");
    setCreationTarget(null);
    creationTargetRef.current = null;
    localStorage.removeItem(`aha-sprite-creation-target:${current.current.id}`);
    update((p) => ({ ...p, selectedActionId: id }), false);
    resetActionPreview();
    setLeftVisible(false);
  };
  const openSlicing = (run: SpriteRun, actionId?: string) => {
    const target =
      candidate && inspectedRun?.id === run.id
        ? spriteFrameRun(inspectedRun, state.runs, frameSource?.assetId)
        : { run, index: 0 };
    run = target.run;
    const outputId =
      actionId ?? run.configuration?.segment?.actionId ?? run.actions?.[0]?.action.id;
    const local =
      current.current.actions.find((a) => a.id === outputId)?.id ??
      current.current.provenance.find(
        (p) => (p.runId === run.id || p.segmentRunIds?.includes(run.id)) && p.actionId === outputId,
      )?.localActionId ??
      current.current.selectedActionId;
    if (local !== current.current.selectedActionId)
      update((p) => ({ ...p, selectedActionId: local }), false);
    setRepairActionId(outputId ?? null);
    setRepairFrameIndex(target.index);
    setRepairRunId(run.id);
    setQueueVisible(false);
    setRightTab("properties");
    setChatVisible(true);
    setCandidate(null);
    setPlaying(false);
    setSourceId("");
    setSelection({
      phase: "actions",
      actionId: current.current.selectedActionId,
      mode: "slicing",
      runId: run.id,
      candidateId: run.selectedCandidateId ?? run.source!.id,
      processingVersionId: spriteCandidate(run)?.processingVersionId,
    });
    setLeftVisible(false);
  };
  const reviewLock = useRef(false);
  const reviewAndAdopt = async (
    run: SpriteRun,
    ids: string[],
    replace: boolean | "copy" = false,
  ) => {
    if (reviewLock.current || adoptionLock.current)
      throw new Error("An adoption is already being saved.");
    reviewLock.current = true;
    setAdopting(true);
    try {
      if (
        ids.length === 1 &&
        !candidateTargetId &&
        !spriteActionCandidates(current.current, state).find(
          (item) => item.run.id === run.id && item.actionId === ids[0],
        )?.localActionId
      )
        replace = "copy";
      let latest = state;
      const parts = run.assembledRunIds
        ? run.assembledRunIds.map((id) => latest.runs.find((r) => r.id === id)!).filter(Boolean)
        : [run];
      for (const part of parts) {
        const candidate = spriteCandidate(part);
        if (!candidate) throw new Error("Animation candidate not found.");
        for (const actionId of ids.filter((id) =>
          candidate.actions.some((a) => a.action.id === id),
        )) {
          latest = await drawingApi().spriteCommand({
            operation: "review-candidate",
            projectId: project.id,
            runId: part.id,
            candidateId: candidate.id,
            version: candidate.version ?? 0,
            processingVersionId: candidate.processingVersionId,
            analysisRevision: candidate.analysisRevision ?? 0,
            actionId,
          });
        }
      }
      setState(latest);
      const selectedRun = latest.runs.find((r) => r.id === run.id) ?? run;
      const complete = spriteCombinedActionRun(selectedRun, latest.runs);
      if (!complete) throw new Error("Wait for every segment before adding the complete action.");
      const prepared = await loadCandidate(complete, ids);
      return prepared ? await adopt(true, prepared, complete, new Set(ids), replace) : false;
    } finally {
      reviewLock.current = false;
      setAdopting(false);
    }
  };
  const restoreVersion = async (id: string, restoreCanvas = false) => {
    if (adoptionLock.current) throw new Error("Another project operation is in progress.");
    adoptionLock.current = true;
    setAdopting(true);
    try {
      const before = current.current;
      const next = {
        ...restoreSpriteActionVersion(before, id, restoreCanvas),
        updatedAt: new Date().toISOString(),
      };
      await saveSpriteProject(next);
      setPast((items) => [...items.slice(-99), before]);
      setFuture([]);
      current.current = next;
      setProject(next);
      setSaveStatus("Saved locally");
      resetActionPreview();
    } finally {
      adoptionLock.current = false;
      setAdopting(false);
    }
  };
  const useCharacterCandidate = async (run: SpriteRun) => {
    if (!run.source) throw new Error("Character source not found.");
    let source = current.current.sources.find((s) => s.assetId === run.source!.id);
    if (!source) {
      const response = await fetch(imageUrl(run.source), { credentials: "include" });
      if (!response.ok) throw new Error("Could not download character reference.");
      source = {
        ...(await decodeSpriteSource(await response.blob(), run.source.name)),
        assetId: run.source.id,
        usage: "material",
      };
    }
    const chosen = source;
    update((p) => ({
      ...p,
      sources: p.sources.some((s) => s.id === chosen.id) ? p.sources : [...p.sources, chosen],
      referenceSourceId: chosen.id,
    }));
    setQueueVisible(false);
    setStage("character");
  };
  const restoredSelection = useRef(false);
  const restoreSelection = useEffectEvent(() => {
    if (restoredSelection.current) return;
    restoredSelection.current = true;
    const saved = initialView.selection;
    if (saved.phase === "actions") {
      update((p) => ({ ...p, selectedActionId: saved.actionId }), false);
      if (saved.mode !== "current") {
        const original = state.runs.find((r) => r.id === saved.runId);
        const record = original
          ? spriteCandidate({ ...original, selectedCandidateId: saved.candidateId })
          : undefined;
        if (original && record) {
          const run = {
            ...original,
            selectedCandidateId: record.id,
            source: record.source,
            frames: record.frames,
            actions: record.actions,
          };
          if (saved.mode === "slicing") openSlicing(run, saved.actionId);
          else safe(() => inspectCandidate(run, saved.actionId, initialView.frameIndex));
          return;
        }
        resetActionPreview();
      }
    }
  });
  useEffect(() => {
    if (stateLoaded) restoreSelection();
  }, [stateLoaded]);
  const previewInitialCandidate = useEffectEvent(() => {
    if (
      stage !== "actions" ||
      selection.mode !== "current" ||
      action.frames.length ||
      sourceId ||
      autoInspectAction.current !== action.id
    )
      return;
    autoInspectAction.current = "";
    const entry = actionCandidates.find((c) => c.localActionId === action.id);
    if (entry) safe(() => inspectCandidate(entry.run, entry.actionId));
    else if (correctionRun) openSlicing(correctionRun);
  });
  useEffect(() => {
    if (stateLoaded) previewInitialCandidate();
  }, [stateLoaded, stage, selection, action.id, action.frames.length, sourceId, state.runs]);
  return {
    specChange,
    cancelSpecChange: () => setSpecChange(null),
    confirmSpecChange: () => {
      if (!specChange) return;
      update(
        (p) => ({
          ...p,
          ...specChange,
          actionVersions: snapshotSpriteActions(
            p,
            p.actions.filter((a) => a.frames.length).map((a) => a.id),
          ),
        }),
        true,
        true,
      );
      setSpecChange(null);
    },
    exportActionIds,
    setExportActionIds,
    exportScale,
    setExportScale,
    exportProject,
    selection,
    setSelection,
    initialView,
    stateLoaded,
    taskReadStatus,
    taskReadError,
    retryTasks: () => retryTasksRef.current?.() ?? Promise.resolve(),
    leftWidth,
    setLeftWidth,
    rightWidth,
    setRightWidth,
    previewZoom,
    setPreviewZoom,
    timelineHeight,
    setTimelineHeight,
    queueVisible,
    setQueueVisible,
    materialsVisible,
    setMaterialsVisible,
    versionsVisible,
    setVersionsVisible,
    planId,
    setPlanId,
    creationTarget,
    creationMode,
    setCreationMode,
    creationSession,
    submitGeneration,
    startNewGeneration,
    importError,
    chatError,
    reportChat,
    candidateTargetId,
    setCandidateTargetId,
    actionCandidates,
    correctionRun,
    actionProgress,
    selectAction,
    openSlicing,
    reviewAndAdopt,
    restoreVersion,
    useCharacterCandidate,
    tr,
    navigate,
    providers,
    project,
    setProject,
    stage,
    setStage,
    rightTab,
    setRightTab,
    leftVisible,
    setLeftVisible,
    workbenchWidth,
    setWorkbenchWidth,
    workbenchRef,
    generationPrompt,
    setGenerationPrompt,
    generationBusy,
    setGenerationBusy,
    current,
    deleting,
    setDeleting,
    deleteBusy,
    setDeleteBusy,
    deletionStarted,
    saveStatus,
    setSaveStatus,
    error,
    setError,
    past,
    setPast,
    future,
    setFuture,
    selected,
    setSelected,
    index,
    setIndex,
    playing,
    playheadMs,
    setPlaying,
    onion,
    setOnion,
    chatVisible,
    setChatVisible,
    sourceId,
    setSourceId,
    compareReference,
    setCompareReference,
    renameAction,
    setRenameAction,
    attachmentBridge,
    attachmentBusy,
    setAttachmentBusy,
    attachmentBusyRef,
    sourceEdit,
    setSourceEdit,
    sourceDelete,
    setSourceDelete,
    copyNotice,
    setCopyNotice,
    newActionName,
    setNewActionName,
    deletedSources,
    deletedFrames,
    associationTail,
    removedConversationIds,
    createConversationRef,
    registerConversationCreator,
    mounted,
    state,
    setState,
    repairRunId,
    repairFrameIndex,
    setRepairRunId,
    repairActionId,
    setRepairActionId,
    repairRun,
    replaceSlicingSource,
    adopting,
    setAdopting,
    updatePrompt,
    setUpdatePrompt,
    resolveUpdate,
    finishUpdatePrompt,
    adoptionLock,
    adoptionUndo,
    candidate,
    setCandidate,
    setCandidateId,
    exportMode,
    setExportMode,
    allActions,
    setAllActions,
    columns,
    setColumns,
    gap,
    setGap,
    progress,
    setProgress,
    abort,
    importRef,
    report,
    action,
    exportActions,
    skippedActions,
    candidateSelection,
    setCandidateSelection,
    previewProject,
    previewAction,
    frame,
    frameSource,
    frameMaster,
    offsetUnit,
    source,
    update,
    editAction,
    resetActionPreview,
    duplicateAction,
    removeAction,
    showActionMenu,
    save,
    syncContext,
    changeThreads,
    importImages,
    pendingImageImport,
    setPendingImageImport,
    addImageToChat,
    showSourceMenu,
    removeSource,
    isAdopted,
    inspectedRun,
    setInspectedRun,
    loadCandidate,
    inspectCandidate,
    adopt,
    originalImage,
    setOriginalImage,
    draftConflict,
    setDraftConflict,
    openPlanConversation,
    runCommand,
    exportAssets,
    undo,
    undoAdoption,
    redo,
    safe,
    prepareGeneration,
    activePlan,
    placement,
    clipped,
  };
}
