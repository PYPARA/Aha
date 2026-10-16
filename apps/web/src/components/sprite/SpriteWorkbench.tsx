import { ChatBubblePlusIcon } from "~/lib/icons";
import { EmbeddedChatAttachments } from "../chat/EmbeddedChatAttachments";
import { SpriteFramePicker } from "./SpriteFramePicker";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useBlocker } from "@tanstack/react-router";
import { spriteBlockedActions } from "@synara/contracts";
import type { SpriteRun, SpriteState, ThreadId } from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogFooter } from "../ui/dialog";
import { ensureNativeApi } from "~/nativeApi";
import { SpriteSheetActionsDialog } from "./SpriteSheetActionsDialog";
import { DrawingModelPicker } from "../drawing/DrawingPickers";
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
  sliceFrames,
  adoptSpriteSheetRows,
  framePlacement,
  removeSpriteSource,
  actionFromSelectedFrames,
  uuid,
  safeFilename,
  type SpriteProject,
  type SpriteSource,
  type SpriteAction,
  type SliceSettings,
} from "./spriteModel";
import { saveSpriteProject, deleteSpriteProject, spriteErrorMessage } from "./spriteStorage";
import {
  suggestChromaKey,
  cropSpriteFrameSource,
  decodeSpriteSource,
  exportSpriteProject,
  exportSpriteAssets,
  type SpriteExportMode,
} from "./spriteFiles";
import { SpritePreview, SpriteThumbnail } from "./SpritePreview";
import { SpriteImageDialog } from "./SpriteImageDialog";
import { SpriteResults, spriteCandidate, SPRITE_TASK_OPEN } from "./SpriteResults";
import { SpriteSliceEditor } from "./SpriteSliceEditor";
import {
  reviseSpritePlan,
  focusSpritePlan,
  type SpriteDraftConflict,
} from "./spritePlanNavigation";
import { SpriteChat } from "./SpriteChat";

const inputClass = "h-8 min-w-0 rounded-md border bg-background px-2 text-xs";
function NumberField({
  label,
  value,
  onChange,
  min = 1,
  max = 4096,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <span>{label}</span>
      <input
        aria-label={label}
        className={`${inputClass} w-20`}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = e.target.valueAsNumber;
          if (Number.isInteger(n) && n >= min && n <= max) onChange(n);
        }}
      />
    </label>
  );
}
const adoptionKey = (run: SpriteRun, actionId: string) =>
  `${run.id}:${run.selectedCandidateId ?? run.source?.id ?? "legacy"}:${actionId}`;
export default function SpriteWorkbench({
  initialProject,
  onBack,
}: {
  initialProject: SpriteProject;
  onBack: () => Promise<void>;
}) {
  const tr = useAhaTranslation();
  const navigate = useNavigate();
  const providers = useImageProviders();
  useDrawingEvents();
  const [project, setProject] = useState<SpriteProject>(initialProject);
  const current = useRef(project);
  current.current = project;
  const [deleting, setDeleting] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const deletionStarted = useRef(false);
  const [saveStatus, setSaveStatus] = useState("Saved locally"),
    [error, setError] = useState("");
  const [past, setPast] = useState<SpriteProject[]>([]),
    [future, setFuture] = useState<SpriteProject[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set()),
    [index, setIndex] = useState(0),
    [playing, setPlaying] = useState(false);
  const [onion, setOnion] = useState(false),
    [chatVisible, setChatVisible] = useState(true),
    [sourceId, setSourceId] = useState("");
  const [rowImport, setRowImport] = useState<{
    source: SpriteSource;
    frames: import("./spriteModel").SpriteFrame[];
    actionDefaults?: readonly { name: string; frameCount: number; fps: number; loop: boolean }[];
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
  const [slice, setSlice] = useState<SliceSettings>({
    mode: "grid",
    columns: 8,
    rows: 1,
    width: 64,
    height: 64,
    margin: 0,
    gap: 0,
  });
  const [state, setState] = useState<SpriteState>({ context: null, runs: [] });
  const [repairRunId, setRepairRunId] = useState<string | null>(null);
  const repairRun = state.runs.find((r) => r.id === repairRunId);
  const [adopting, setAdopting] = useState(false);
  const adoptionLock = useRef(false);
  const adoptionUndo = useRef(
    new Map<string, { before: SpriteProject; after: SpriteProject; ids: string[] }>(),
  );
  const [candidate, setCandidate] = useState<SpriteProject | null>(null),
    [, setCandidateId] = useState<string | null>(null);
  const [exportMode, setExportMode] = useState<SpriteExportMode>("combined"),
    [allActions, setAllActions] = useState(true),
    [columns, setColumns] = useState(8),
    [gap, setGap] = useState(0);
  const [progress, setProgress] = useState("");
  const abort = useRef<AbortController | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const report = useCallback((e: unknown) => setError(spriteErrorMessage(e)), []);
  const action =
    project.actions.find((a) => a.id === project.selectedActionId) ?? project.actions[0]!;
  const exportActions = (allActions ? project.actions : [action]).filter((a) => a.frames.length);
  const skippedActions = allActions ? project.actions.length - exportActions.length : 0;
  const [candidateSelection, setCandidateSelection] = useState<Set<string>>(new Set());
  const previewProject = candidate ?? project;
  const previewAction =
    candidate?.actions.find((a) => a.id === candidate.selectedActionId) ??
    candidate?.actions[0] ??
    action;
  const frame = previewAction.frames[Math.min(index, previewAction.frames.length - 1)];
  const source = project.sources.find((s) => s.id === sourceId);
  const slicePreview = useMemo(() => {
    try {
      return source ? { frames: sliceFrames(source, slice), error: "" } : { frames: [], error: "" };
    } catch (e) {
      return { frames: [], error: (e as Error).message };
    }
  }, [source, slice]);
  const update = useCallback((fn: (p: SpriteProject) => SpriteProject, history = true) => {
    if (deletionStarted.current) return;
    const previous = current.current;
    const edited = fn(previous);
    const used = new Set(edited.actions.flatMap((a) => a.frames.map((f) => f.sourceId)));
    const removedOrigins = edited.provenance.filter(
      (p) => p.localActionId && !edited.actions.some((a) => a.id === p.localActionId),
    );
    const removedKeys = new Set(
      removedOrigins.map((p) => `${p.runId}:${p.candidateId}:${p.actionId}`),
    );
    const next = {
      ...edited,
      sources: edited.sources.filter(
        (s) => s.usage !== "generated-frame" || used.has(s.id) || edited.referenceSourceId === s.id,
      ),
      provenance: edited.provenance.filter((p) => !removedOrigins.includes(p)),
      adoptedCandidateIds: edited.adoptedCandidateIds.filter((id) => !removedKeys.has(id)),
      updatedAt: new Date().toISOString(),
    };
    if (history) {
      setPast((items) => [...items.slice(-49), previous]);
      setFuture([]);
    }
    current.current = next;
    setProject(next);
    setSaveStatus("Saving…");
  }, []);
  const editAction = (fn: (a: SpriteAction) => SpriteAction) =>
    update((p) => ({
      ...p,
      actions: p.actions.map((a) => (a.id === p.selectedActionId ? fn(a) : a)),
    }));
  const resetActionPreview = () => {
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
    if (deletionStarted.current) return;
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
      context: spriteContext(snapshot),
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
    if (deleting) return;
    const timer = setTimeout(() => {
      void drawingApi()
        .spriteCommand({
          operation: "sync",
          projectId: project.id,
          context: spriteContext(project),
          threadIds: project.threadIds,
        })
        .catch(report);
    }, 400);
    return () => clearTimeout(timer);
  }, [project, deleting, report]);
  useEffect(() => {
    if (deleting) return;
    let alive = true,
      inFlight = false;
    setState({ context: null, runs: [] });
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await drawingApi().spriteCommand({ operation: "get", projectId: project.id });
        if (alive) setState(next);
      } catch (e) {
        if (alive) report(e);
      } finally {
        inFlight = false;
      }
    };
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
  useEffect(() => {
    if (!playing || !previewAction.frames.length) return;
    const timer = setInterval(
      () =>
        setIndex((i) => {
          if (i + 1 < previewAction.frames.length) return i + 1;
          if (!previewAction.loop) {
            setPlaying(false);
            return i;
          }
          return 0;
        }),
      1000 / previewAction.fps,
    );
    return () => clearInterval(timer);
  }, [playing, previewAction]);
  const importImages = async (files: File[]) => {
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
    const sources: SpriteSource[] = [];
    for (const file of files.toSorted((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true }),
    ))
      sources.push(await decodeSpriteSource(file, file.name));
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
      width: Math.max(
        p.sources.length ? p.width : 1,
        ...sources.map((s) => Math.min(s.width, 4096)),
      ),
      height: Math.max(
        p.sources.length ? p.height : 1,
        ...sources.map((s) => Math.min(s.height, 4096)),
      ),
      actions: p.actions.map((a) =>
        a.id !== p.selectedActionId
          ? a
          : {
              ...a,
              frames: [
                ...a.frames,
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
              ],
            },
      ),
    }));
    setIndex(0);
    if (sources.length === 1) setSourceId(sources[0]!.id);
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
    deletedSources.current.add(id);
    for (const f of current.current.actions.flatMap((a) => a.frames))
      if (f.sourceId === id) deletedFrames.current.add(f.id);
    update((p) => removeSpriteSource(p, id));
    resetActionPreview();
    setRowImport(null);
    setSourceDelete(null);
  };
  const isAdopted = (run: SpriteRun, actionId: string) => {
    const keys = current.current.adoptedCandidateIds;
    return (
      keys.includes(adoptionKey(run, actionId)) ||
      ((run.selectedCandidateId ?? run.source?.id) ===
        (run.candidates?.[0]?.id ?? run.source?.id) &&
        (keys.includes(run.id) || keys.includes(`${run.id}:${actionId}`)))
    );
  };
  const [inspectedRun, setInspectedRun] = useState<SpriteRun | null>(null);
  const loadCandidate = async (run: SpriteRun) => {
    const owner = current.current.id;
    const sources: SpriteSource[] = [];
    for (const asset of run.frames) {
      const response = await fetch(imageUrl(asset), { credentials: "include" });
      if (!response.ok) throw new Error("Could not download candidate.");
      const source = await decodeSpriteSource(await response.blob(), asset.name);
      sources.push({
        ...source,
        assetId: asset.id,
        usage: "generated-frame",
        origin: {
          runId: run.id,
          candidateId: run.selectedCandidateId ?? run.source!.id,
          processingVersionId: spriteCandidate(run)?.processingVersionId,
        },
      });
    }
    if (deletionStarted.current || !mounted.current || current.current.id !== owner) return;
    const p = newSpriteProject();
    let frameOffset = 0;
    const outputs = run.actions?.length
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
    const actions = outputs.map((output) => {
      const frames = sources.slice(frameOffset, frameOffset + output.frames.length).map((s) => ({
        id: uuid(),
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
        fps: output.action.fps,
        loop: output.action.loop,
        frames,
      };
    });
    return {
      ...p,
      width: run.context.width,
      height: run.context.height,
      sources,
      actions,
      selectedActionId: actions[0]!.id,
    };
  };
  const inspectCandidate = async (run: SpriteRun) => {
    const prepared = await loadCandidate(run);
    if (!prepared) return;
    setSourceId("");
    setCandidate(prepared);
    const actions = prepared.actions;
    setCandidateSelection(new Set(actions.filter((a) => !isAdopted(run, a.id)).map((a) => a.id)));
    setInspectedRun(run);
    setCandidateId(run.id);
    setIndex(0);
    setPlaying(run.input.kind === "animation");
  };
  const adopt = async (
    all = false,
    supplied?: SpriteProject,
    suppliedRun?: SpriteRun,
    selection?: Set<string>,
    replace = false,
  ) => {
    const run = suppliedRun ?? inspectedRun;
    const preview = supplied ?? candidate;
    if (!preview || !run) return;
    const selected = preview.actions
      .filter((a) =>
        all ? (selection ?? candidateSelection).has(a.id) : a.id === preview.selectedActionId,
      )
      .filter((a) => replace || !isAdopted(run, a.id));
    if (!selected.length) {
      const existing = current.current.provenance.find(
        (p) =>
          p.runId === run.id &&
          p.candidateId === (run.selectedCandidateId ?? run.source?.id) &&
          p.localActionId,
      );
      if (existing) update((p) => ({ ...p, selectedActionId: existing.localActionId! }), false);
      return;
    }
    const record = spriteCandidate(run),
      blocked = record
        ? spriteBlockedActions(record)
        : new Set(run.status === "needs-adjustment" ? selected.map((a) => a.id) : []);
    if (selected.some((a) => blocked.has(a.id)))
      throw new Error("Review the layout before adding this action.");
    const sourceIds = new Set(selected.flatMap((a) => a.frames.map((f) => f.sourceId)));
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
      (!replace && selected.some((a) => isAdopted(run, a.id)))
    )
      return;
    const base = current.current;
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
      (!replace && base.actions.length + selected.length > 1024)
    )
      throw new Error("Project exceeds 1024 images or actions.");
    const mappings = selected.map((a) => {
      const old = base.provenance.find(
        (p) =>
          p.runId === run.id &&
          p.actionId === a.id &&
          (p.candidateId ?? run.candidates?.[0]?.id ?? run.source?.id) ===
            (run.selectedCandidateId ?? run.source?.id),
      );
      const localId = replace && old?.localActionId ? old.localActionId : uuid();
      if (replace && old && !old.localActionId)
        throw new Error(
          "This historical action has no reliable replacement mapping. Add a new action explicitly instead.",
        );
      return { generated: a.id, local: localId };
    });
    const adoptedActions = accepted.actions.map((a) =>
      Object.assign({}, a, {
        id: mappings.find((m) => m.generated === a.id)!.local,
        frames: a.frames.map((f) => ({ ...f, sourceId: remap.get(f.sourceId)! })),
      }),
    );
    const replacedIds = new Set(replace ? adoptedActions.map((a) => a.id) : []);
    const next: SpriteProject = {
      ...base,
      updatedAt: new Date().toISOString(),
      sources: [...base.sources, ...incoming],
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
      referenceSourceId: null,
      adoptedCandidateIds: [
        ...new Set([...base.adoptedCandidateIds, ...selected.map((a) => adoptionKey(run, a.id))]),
      ],
      provenance: [
        ...base.provenance.filter((p) => !p.localActionId || !replacedIds.has(p.localActionId)),
        ...selected.map((a) => ({
          runId: run.id,
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
    if (adoptionLock.current) throw new Error("An adoption is already being saved.");
    adoptionLock.current = true;
    setAdopting(true);
    try {
      await saveSpriteProject(next);
      if (current.current.id !== owner || deletionStarted.current) return;
      if (current.current !== base)
        throw new Error("Project changed while saving. Reload before adding actions.");
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
    setCandidate(null);
    setCandidateId(null);
    setPlaying(false);
    setIndex(0);
  };
  const [originalImage, setOriginalImage] = useState<import("@synara/contracts").ImageAsset | null>(
    null,
  );
  const [draftConflict, setDraftConflict] = useState<{
    error: SpriteDraftConflict;
    input: import("@synara/contracts").SpriteCommand;
  } | null>(null);
  const openPlanConversation = async (threadId: string, planId: string) => {
    setChatVisible(true);
    await changeThreads(current.current.threadIds, threadId);
    focusSpritePlan(planId);
  };
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
      const blob = await exportSpriteAssets(
        project,
        exportActions.map((a) => a.id),
        exportMode,
        columns,
        gap,
        controller.signal,
        setProgress,
      );
      downloadBlob(blob, `${safeFilename(project.name)}-${exportMode}.zip`);
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
        actions: [...existing, ...old],
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
  const safe = (fn: () => Promise<unknown>) => {
    if (adoptionLock.current) return;
    setError("");
    setCopyNotice("");
    void fn().catch(report);
  };
  const placement = frame
    ? framePlacement(frame, previewProject.width, previewProject.height)
    : null;
  const clipped =
    frame &&
    placement &&
    (placement.x < 0 ||
      placement.y < 0 ||
      placement.x + frame.width > previewProject.width ||
      placement.y + frame.height > previewProject.height);
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      data-testid="sprite-workbench"
      inert={adopting}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        safe(() => importImages(Array.from(e.dataTransfer.files)));
      }}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-3">
        <h1 className="mr-2 text-sm font-semibold">{tr("Sprite animation")}</h1>
        <input
          className={`${inputClass} w-36`}
          value={project.name}
          maxLength={200}
          aria-label={tr("Project name")}
          onChange={(e) => update((p) => ({ ...p, name: e.target.value }))}
        />
        <span className="text-xs text-muted-foreground" role="status">
          {tr(saveStatus)}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={deleting}
          onClick={() =>
            safe(async () => {
              await associationTail.current;
              await save(current.current);
              await onBack();
            })
          }
        >
          {tr("Back to projects")}
        </Button>
        {saveStatus === "Save failed" && (
          <Button size="sm" variant="outline" onClick={() => safe(() => save(current.current))}>
            {tr("Retry save")}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => importRef.current?.click()}>
          {tr("Import images")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            safe(async () =>
              downloadBlob(
                await exportSpriteProject(project),
                `${safeFilename(project.name)}.aha-sprite.zip`,
              ),
            )
          }
        >
          {tr("Save package")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={deleteBusy}
          onClick={() => {
            if (
              deleting ||
              window.confirm(
                tr(
                  "Delete this sprite project and its generation records? Conversation history will be kept.",
                ),
              )
            )
              safe(async () => {
                deletionStarted.current = true;
                setDeleting(true);
                setPlaying(false);
                setDeleteBusy(true);
                try {
                  await deleteSpriteProject(project.id);
                  await onBack();
                } finally {
                  setDeleteBusy(false);
                }
              });
          }}
        >
          {tr(deleting ? "Retry deletion" : "Delete")}
        </Button>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <DrawingModelPicker
            providers={providers.data ?? []}
            providerId={project.providerId}
            model={project.model}
            onChange={(providerId, model) => update((p) => ({ ...p, providerId, model }))}
            onSettings={() =>
              void navigate({ to: "/settings", search: { section: "imageProviders" } })
            }
          />
          <Button size="sm" variant="ghost" onClick={() => setChatVisible((v) => !v)}>
            {tr("Conversation")}
          </Button>
        </div>
      </header>
      {copyNotice && (
        <div role="status" className="flex shrink-0 items-center gap-3 border-b px-4 py-2 text-sm">
          <span className="flex-1">{tr(copyNotice)}</span>
          <button onClick={() => setCopyNotice("")} aria-label={tr("Dismiss")}>
            ×
          </button>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-3 border-b bg-destructive/10 px-4 py-2 text-sm text-destructive"
        >
          <span className="flex-1">{tr(error)}</span>
          <button onClick={() => setError("")} aria-label={tr("Dismiss")}>
            ×
          </button>
        </div>
      )}
      <div
        inert={deleting || adopting}
        className={`flex min-h-0 flex-1 overflow-auto ${deleting ? "opacity-50" : ""}`}
      >
        <aside className="flex w-60 min-w-44 max-w-96 shrink-0 resize-x flex-col gap-4 overflow-auto border-r p-3">
          <details open>
            <summary className="mb-2 flex cursor-pointer items-center justify-between text-xs font-semibold">
              {tr("Actions")}
              <Button
                size="sm"
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
                  update((p) => ({ ...p, actions: [...p.actions, a], selectedActionId: a.id }));
                  setIndex(0);
                }}
              >
                +
              </Button>
            </summary>
            {project.actions.map((a) => (
              <div
                key={a.id}
                className={`mb-1 flex items-center rounded text-xs ${a.id === action.id ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  safe(() => showActionMenu(a.id, { x: e.clientX, y: e.clientY }));
                }}
              >
                <button
                  className="flex min-w-0 flex-1 items-center justify-between gap-2 px-2 py-2 text-left"
                  onClick={() => {
                    update((p) => ({ ...p, selectedActionId: a.id }), false);
                    resetActionPreview();
                  }}
                  onDoubleClick={() => setRenameAction({ id: a.id, name: a.name })}
                >
                  <span className="truncate">{a.name}</span>
                  <span>{a.frames.length}</span>
                </button>
                <button
                  className="shrink-0 px-2 py-2 text-muted-foreground hover:text-foreground"
                  aria-label={`${tr("Action options")}: ${a.name}`}
                  onClick={(e) => {
                    const bounds = e.currentTarget.getBoundingClientRect();
                    safe(() => showActionMenu(a.id, { x: bounds.left, y: bounds.bottom }));
                  }}
                >
                  ⋯
                </button>
              </div>
            ))}
          </details>
          <details open>
            <summary className="mb-2 cursor-pointer text-xs font-semibold">
              {tr("Image sources")}
            </summary>

            {project.sources
              .filter((s) => s.usage !== "generated-frame")
              .map((s) => (
                <div
                  key={s.id}
                  className="mb-1 flex items-center gap-1 rounded border p-1"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    safe(() => showSourceMenu(s.id, { x: e.clientX, y: e.clientY }));
                  }}
                >
                  <button
                    className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs"
                    title={s.name}
                    onDoubleClick={() => setSourceEdit({ id: s.id, name: s.name })}
                    onClick={() => {
                      setSourceId(s.id);
                      setCandidate(null);
                      setPlaying(false);
                    }}
                  >
                    <SpriteThumbnail compact blob={s.blob} label={s.name} />
                    <span className="truncate">{s.name}</span>
                  </button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7 shrink-0"
                    title={tr("Add to conversation")}
                    aria-label={`${tr("Add to conversation")}: ${s.name}`}
                    disabled={attachmentBusy}
                    onClick={() => safe(() => addImageToChat(s.id))}
                  >
                    <ChatBubblePlusIcon className="size-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7 shrink-0"
                    title={tr("Image options")}
                    aria-label={`${tr("Image options")}: ${s.name}`}
                    onClick={(e) => {
                      const b = e.currentTarget.getBoundingClientRect();
                      safe(() => showSourceMenu(s.id, { x: b.left, y: b.bottom }));
                    }}
                  >
                    ⋯
                  </Button>
                </div>
              ))}
          </details>
          <SpriteResults
            state={state}
            onState={setState}
            onUndo={undoAdoption}
            onLocate={(run, id) => {
              const p = current.current.provenance.find(
                (p) =>
                  p.runId === run.id &&
                  p.actionId === id &&
                  p.candidateId === (run.selectedCandidateId ?? run.source?.id),
              );
              if (p?.localActionId) {
                update((project) => ({ ...project, selectedActionId: p.localActionId! }), false);
                setCandidate(null);
                setSourceId("");
                setPlaying(false);
              }
            }}
            onAdopt={async (run, ids, replace) => {
              const prepared = await loadCandidate(run);
              if (prepared) await adopt(true, prepared, run, new Set(ids), replace);
            }}
            onImport={(asset) =>
              safe(async () => {
                const existing = current.current.sources.find((s) => s.assetId === asset.id);
                if (existing) {
                  if (existing.usage === "generated-frame")
                    update((p) => ({
                      ...p,
                      sources: p.sources.map((s) =>
                        s.id === existing.id ? { ...s, usage: "material" } : s,
                      ),
                    }));
                  return;
                }
                const owner = current.current.id;
                const response = await fetch(imageUrl(asset), { credentials: "include" });
                if (!response.ok) throw new Error("Could not download original image.");
                const source = {
                  ...(await decodeSpriteSource(await response.blob(), asset.name)),
                  assetId: asset.id,
                  usage: "material" as const,
                };
                if (current.current.id !== owner || deletionStarted.current) return;
                if (
                  current.current.sources.reduce((n, s) => n + s.blob.size, source.blob.size) >
                  80 * 1024 * 1024
                )
                  throw new Error("Project images exceed 80 MiB. Create another project.");
                update((p) => ({ ...p, sources: [...p.sources, source] }));
              })
            }
            adopted={project.adoptedCandidateIds}
            onPreview={(run) => safe(() => inspectCandidate(run))}
            onCommand={(run, operation, actionId) =>
              safe(() => runCommand(run, operation, actionId))
            }
            onOriginal={(asset) => setOriginalImage(asset)}
            onPlan={(run) => {
              if (run.planId && run.context.threadId)
                safe(() => openPlanConversation(run.context.threadId!, run.planId!));
            }}
            onReference={(run) =>
              safe(async () => {
                const asset = run.source!;
                let latest = await drawingApi().spriteCommand({
                  operation: "get",
                  projectId: project.id,
                });
                let draft = latest.plans?.find(
                  (p) => p.threadId === run.context.threadId && p.status === "draft",
                );
                if (!draft) {
                  latest = await reviseSpritePlan({
                    operation: "retry",
                    projectId: project.id,
                    runId: run.id,
                    candidateId: run.selectedCandidateId ?? run.source?.id,
                  });
                  draft = latest.plans?.find((p) => p.id === latest.resultPlanId);
                }
                if (!draft) throw new Error("Generation plan not found.");
                const refs = new Map(draft.configuration.references.map((r) => [r.asset.id, r]));
                refs.set(asset.id, {
                  referenceId: `candidate:${run.id}:${asset.id}`,
                  asset,
                  role: "character",
                  actionId: null,
                });
                const next = await drawingApi().spriteCommand({
                  operation: "update-plan",
                  projectId: project.id,
                  planId: draft.id,
                  version: draft.version,
                  configuration: { ...draft.configuration, references: [...refs.values()] },
                });
                setState(next);
                await openPlanConversation(draft.threadId, draft.id);
              })
            }
            onAdjust={(run) => {
              setCandidate(null);
              setPlaying(false);
              setRepairRunId(run.id);
            }}
          />
        </aside>
        <main className="flex min-w-80 flex-1 flex-col gap-3 overflow-y-auto p-4">
          {repairRun && spriteCandidate(repairRun) ? (
            <SpriteSliceEditor
              key={`${project.id}:${repairRun.id}:${repairRun.selectedCandidateId}`}
              run={repairRun}
              onState={setState}
              onBack={() => {
                setRepairRunId(null);
                requestAnimationFrame(() =>
                  window.dispatchEvent(new CustomEvent(SPRITE_TASK_OPEN, { detail: repairRun.id })),
                );
              }}
            />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" disabled={!past.length} onClick={undo}>
                  {tr("Undo")}
                </Button>
                <Button size="sm" variant="outline" disabled={!future.length} onClick={redo}>
                  {tr("Redo")}
                </Button>
                <span className="ml-auto text-xs text-muted-foreground">
                  {project.width} × {project.height}
                </span>
              </div>
              {source ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-xs">{tr("Slice sprite sheet")}</strong>
                    <select
                      className={inputClass}
                      value={slice.mode}
                      onChange={(e) =>
                        setSlice((s) => ({ ...s, mode: e.target.value as "grid" | "size" }))
                      }
                    >
                      <option value="grid">{tr("Rows and columns")}</option>
                      <option value="size">{tr("Fixed frame size")}</option>
                    </select>
                    {(slice.mode === "grid"
                      ? (["columns", "rows"] as const)
                      : (["width", "height"] as const)
                    ).map((k) => (
                      <NumberField
                        key={k}
                        label={tr(k)}
                        value={slice[k]}
                        onChange={(n) => setSlice((s) => ({ ...s, [k]: n }))}
                      />
                    ))}
                    <NumberField
                      label={tr("Margin")}
                      value={slice.margin}
                      min={0}
                      onChange={(n) => setSlice((s) => ({ ...s, margin: n }))}
                    />
                    <NumberField
                      label={tr("Spacing")}
                      value={slice.gap}
                      min={0}
                      onChange={(n) => setSlice((s) => ({ ...s, gap: n }))}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        safe(async () => {
                          const owner = current.current.id,
                            context = spriteContext(current.current),
                            asset = await uploadDrawingImage(source.blob, source.name);
                          if (current.current.id !== owner || deletionStarted.current) return;
                          const actions = Array.from({ length: slice.rows }, (_, i) => ({
                            id: `row-${i + 1}`,
                            name: `action-${i + 1}`,
                            description: "",
                            enabled: true,
                            frameCount: slice.columns,
                            fps: 12,
                            loop: true,
                          }));
                          const next = await drawingApi().spriteCommand({
                            operation: "inspect-source",
                            projectId: owner,
                            context,
                            references: [
                              {
                                referenceId: `project:${asset.id}`,
                                asset,
                                role: "reference",
                                actionId: null,
                              },
                            ],
                            configuration: {
                              kind: "animation",
                              mode: "combined",
                              prompt: "Imported source slicing",
                              actions,
                              references: [],
                              providerId: context.providerId,
                              model: context.model,
                              width: context.width,
                              height: context.height,
                              background: context.background,
                              chromaKey: context.chromaKey,
                              parameters: { n: 1, size: "auto", outputFormat: "png" },
                            },
                          });
                          if (current.current.id !== owner) return;
                          setState(next);
                          setRepairRunId(
                            next.runs.find((r) => r.input.requestId === `source:${asset.id}`)!.id,
                          );
                          setSourceId("");
                        })
                      }
                    >
                      {tr("Correct frame slicing")}
                    </Button>
                    <Button
                      size="sm"
                      disabled={!slicePreview.frames.length}
                      onClick={() => setRowImport({ source, frames: slicePreview.frames })}
                    >
                      {tr("Split rows into actions")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!slicePreview.frames.length}
                      onClick={() => {
                        update((p) => ({
                          ...p,
                          width: Math.max(...slicePreview.frames.map((f) => f.width)),
                          height: Math.max(...slicePreview.frames.map((f) => f.height)),
                          actions: p.actions.map((a) =>
                            a.id !== p.selectedActionId
                              ? a
                              : {
                                  ...a,
                                  frames: [
                                    ...a.frames.filter(
                                      (f) =>
                                        f.sourceId !== source.id ||
                                        f.width !== source.width ||
                                        f.height !== source.height,
                                    ),
                                    ...slicePreview.frames,
                                  ],
                                },
                          ),
                        }));
                        setSourceId("");
                        setIndex(0);
                      }}
                    >
                      {tr("Apply slicing")} ({slicePreview.frames.length})
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setSourceId("")}>
                      {tr("Close")}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {tr(
                      "For multi-action sheets, split rows into actions. Apply slicing adds every cell to the current action.",
                    )}
                  </p>
                  {slicePreview.error && (
                    <p className="text-xs text-destructive">{tr(slicePreview.error)}</p>
                  )}
                  {slice.mode === "size" && (
                    <p className="text-xs text-muted-foreground">
                      {tr("Only complete cells are included; unused edge pixels are excluded.")}
                    </p>
                  )}
                  <SpritePreview
                    project={{ ...project, width: source.width, height: source.height }}
                    frame={{
                      id: "source",
                      sourceId: source.id,
                      x: 0,
                      y: 0,
                      width: source.width,
                      height: source.height,
                      offsetX: 0,
                      offsetY: 0,
                    }}
                    grid={slicePreview.frames}
                  />
                </>
              ) : (
                <>
                  {candidate && (
                    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs">
                      <span className="flex-1">
                        {tr("Candidate preview — your existing animation is preserved")}
                      </span>
                      <Button
                        size="sm"
                        disabled={
                          !!inspectedRun && isAdopted(inspectedRun, candidate.selectedActionId)
                        }
                        onClick={() => safe(() => adopt())}
                      >
                        {tr("Add this action")}
                      </Button>
                      {candidate.actions.length > 1 && (
                        <>
                          <select
                            className={inputClass}
                            aria-label={tr("Preview action")}
                            value={candidate.selectedActionId}
                            onChange={(e) => {
                              setCandidate({ ...candidate, selectedActionId: e.target.value });
                              setIndex(0);
                            }}
                          >
                            {candidate.actions.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                          </select>
                          <Button
                            size="sm"
                            disabled={!candidateSelection.size}
                            onClick={() => safe(() => adopt(true))}
                          >
                            {tr("Add selected actions")} · {candidateSelection.size}
                          </Button>
                        </>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setCandidate(null);
                          setCandidateId(null);
                          setPlaying(false);
                          setIndex(0);
                        }}
                      >
                        {tr("Close")}
                      </Button>
                    </div>
                  )}
                  {candidate && candidate.actions.length > 1 && (
                    <div className="mb-3 flex flex-wrap gap-x-4 gap-y-2 rounded-lg border p-3">
                      {candidate.actions.map((a) => (
                        <label key={a.id} className="flex items-center gap-2 text-xs">
                          <Checkbox
                            checked={candidateSelection.has(a.id)}
                            disabled={!!inspectedRun && isAdopted(inspectedRun, a.id)}
                            onCheckedChange={(checked) =>
                              setCandidateSelection((p) => {
                                const next = new Set(p);
                                if (checked) next.add(a.id);
                                else next.delete(a.id);
                                return next;
                              })
                            }
                          />
                          <span>
                            {a.name}{" "}
                            <span className="text-muted-foreground">
                              · {a.frames.length} {tr("frames")} · {a.fps} FPS
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                  <SpritePreview
                    project={previewProject}
                    {...(frame ? { frame } : {})}
                    {...(onion && index > 0 && previewAction.frames[index - 1]
                      ? { previous: previewAction.frames[index - 1]! }
                      : {})}
                    {...(!candidate && frame
                      ? {
                          onOffset: (x: number, y: number) =>
                            editAction((a) => ({
                              ...a,
                              frames: a.frames.map((f) =>
                                f.id === frame.id ? { ...f, offsetX: x, offsetY: y } : f,
                              ),
                            })),
                        }
                      : {})}
                  />
                  {!frame && (
                    <p className="text-center text-sm text-muted-foreground">
                      {tr(
                        "Drop a sprite sheet or frame sequence here, or describe a character in the conversation.",
                      )}
                    </p>
                  )}
                  {clipped && (
                    <p className="text-xs text-orange-600">
                      {tr(
                        "Some pixels are outside the canvas. Increase the canvas or adjust the frame offset.",
                      )}{" "}
                      {!candidate && (
                        <button
                          className="underline"
                          onClick={() =>
                            update((p) => ({
                              ...p,
                              width: Math.min(
                                4096,
                                Math.max(
                                  p.width,
                                  ...action.frames.map((f) => f.width + 2 * Math.abs(f.offsetX)),
                                ),
                              ),
                              height: Math.min(
                                4096,
                                Math.max(
                                  p.height,
                                  ...action.frames.map((f) => f.height + Math.abs(f.offsetY)),
                                ),
                              ),
                              actions: p.actions.map((a) => ({
                                ...a,
                                frames: a.frames.map((f) => ({
                                  ...f,
                                  offsetY: Math.min(0, f.offsetY),
                                })),
                              })),
                            }))
                          }
                        >
                          {tr("Expand canvas")}
                        </button>
                      )}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setPlaying(false);
                        setIndex((i) => Math.max(0, i - 1));
                      }}
                    >
                      ←
                    </Button>
                    <Button
                      size="sm"
                      disabled={!frame}
                      onClick={() => {
                        if (!playing && index >= previewAction.frames.length - 1) setIndex(0);
                        setPlaying((v) => !v);
                      }}
                    >
                      {tr(playing ? "Pause" : "Play")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setPlaying(false);
                        setIndex((i) =>
                          Math.max(0, Math.min(previewAction.frames.length - 1, i + 1)),
                        );
                      }}
                    >
                      →
                    </Button>
                    <span className="text-xs">
                      {frame ? index + 1 : 0} / {previewAction.frames.length}
                    </span>
                    {!candidate && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        disabled={!frame || attachmentBusy}
                        title={tr("Add current frame to conversation")}
                        aria-label={tr("Add current frame to conversation")}
                        onClick={() => frame && safe(() => addImageToChat(frame.sourceId, true))}
                      >
                        <ChatBubblePlusIcon className="size-3.5" />
                      </Button>
                    )}
                    {!candidate && frame && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          safe(async () => {
                            const source = current.current.sources.find(
                              (s) => s.id === frame.sourceId,
                            )!;
                            const cropped = await cropSpriteFrameSource(
                              source,
                              frame,
                              `${action.name}-${index + 1}.png`,
                            );
                            update((p) => ({
                              ...p,
                              sources: [...p.sources, { ...cropped, usage: "material" }],
                            }));
                          })
                        }
                      >
                        {tr("Save current frame as material")}
                      </Button>
                    )}
                    <label className="text-xs">
                      <input
                        type="checkbox"
                        checked={onion}
                        onChange={(e) => setOnion(e.target.checked)}
                      />{" "}
                      {tr("Onion skin")}
                    </label>
                  </div>
                </>
              )}
              <SpriteFramePicker
                project={previewProject}
                frames={previewAction.frames}
                actionId={previewAction.id}
                index={index}
                selected={selected}
                onSelection={setSelected}
                onPreview={(i) => {
                  setIndex(i);
                  setPlaying(false);
                }}
                onFrames={(frames) => {
                  const ids = new Set(frames.map((f) => f.id));
                  for (const f of action.frames)
                    if (!ids.has(f.id)) deletedFrames.current.add(f.id);
                  editAction((a) => ({ ...a, frames }));
                  setIndex(0);
                  setPlaying(false);
                }}
                onCreate={() => setNewActionName(`${action.name} copy`)}
                readOnly={!!candidate}
                onError={report}
              />
              <details open className="rounded border p-3">
                <summary className="cursor-pointer text-xs font-semibold">
                  {tr("Animation and generation settings")}
                </summary>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <input
                    className={`${inputClass} w-32`}
                    aria-label={tr("Action name")}
                    value={action.name}
                    onChange={(e) => editAction((a) => ({ ...a, name: e.target.value }))}
                  />
                  <NumberField
                    label="FPS"
                    value={action.fps}
                    max={60}
                    onChange={(fps) => editAction((a) => ({ ...a, fps }))}
                  />
                  <label className="text-xs">
                    <input
                      type="checkbox"
                      checked={action.loop}
                      onChange={(e) => editAction((a) => ({ ...a, loop: e.target.checked }))}
                    />{" "}
                    {tr("Loop")}
                  </label>
                  <Button size="sm" variant="outline" onClick={() => duplicateAction(action.id)}>
                    {tr("Duplicate action")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={project.actions.length < 2}
                    title={
                      project.actions.length < 2
                        ? tr("Keep at least one action. Use Clear action frames to start over.")
                        : undefined
                    }
                    onClick={() => removeAction(action.id)}
                  >
                    {tr("Delete action")}
                  </Button>
                  <NumberField
                    label={tr("Canvas width")}
                    value={project.width}
                    onChange={(width) => update((p) => ({ ...p, width }))}
                  />
                  <NumberField
                    label={tr("Canvas height")}
                    value={project.height}
                    onChange={(height) => update((p) => ({ ...p, height }))}
                  />
                  {frame && !candidate && (
                    <>
                      <NumberField
                        label={tr("Offset X")}
                        value={frame.offsetX}
                        min={-4096}
                        onChange={(offsetX) =>
                          editAction((a) => ({
                            ...a,
                            frames: a.frames.map((f) =>
                              f.id === frame.id ? { ...f, offsetX } : f,
                            ),
                          }))
                        }
                      />
                      <NumberField
                        label={tr("Offset Y")}
                        value={frame.offsetY}
                        min={-4096}
                        onChange={(offsetY) =>
                          editAction((a) => ({
                            ...a,
                            frames: a.frames.map((f) =>
                              f.id === frame.id ? { ...f, offsetY } : f,
                            ),
                          }))
                        }
                      />
                    </>
                  )}
                  <NumberField
                    label={tr("Generated frames")}
                    value={project.generationFrameCount}
                    max={32}
                    onChange={(generationFrameCount) =>
                      update((p) => ({ ...p, generationFrameCount }))
                    }
                  />
                  <select
                    aria-label={tr("Generated background")}
                    className={inputClass}
                    value={project.background}
                    onChange={(e) =>
                      update((p) => ({
                        ...p,
                        background: e.target.value as "chroma" | "transparent",
                      }))
                    }
                  >
                    <option value="chroma">{tr("Chroma background")}</option>
                    <option value="transparent">{tr("Transparent")}</option>
                  </select>
                  {project.background === "chroma" && (
                    <input
                      type="color"
                      aria-label={tr("Chroma key")}
                      value={project.chromaKey}
                      onChange={(e) => update((p) => ({ ...p, chromaKey: e.target.value }))}
                    />
                  )}
                </div>
              </details>
              {(state.plans ?? []).some((p) => p.status === "draft") && (
                <div className="flex shrink-0 items-center justify-between rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs">
                  <span>{tr("A plan is awaiting confirmation")}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const plan = state.plans!.find((p) => p.status === "draft")!;
                      void openPlanConversation(plan.threadId, plan.id);
                    }}
                  >
                    {tr("Go to conversation")}
                  </Button>
                </div>
              )}
              <section className="flex flex-wrap items-center gap-2 rounded border p-3">
                <strong className="text-xs">{tr("Export")}</strong>
                <select
                  className={inputClass}
                  aria-label={tr("Export format")}
                  value={exportMode}
                  onChange={(e) => setExportMode(e.target.value as SpriteExportMode)}
                >
                  <option value="combined">{tr("Combined PNG atlas + JSON")}</option>
                  <option value="atlas">{tr("Per-action PNG atlases + JSON")}</option>
                  <option value="sequence">{tr("PNG sequence + JSON")}</option>
                </select>
                <label className="text-xs">
                  <input
                    type="checkbox"
                    checked={allActions}
                    onChange={(e) => setAllActions(e.target.checked)}
                  />{" "}
                  {tr("All actions")}
                </label>
                {skippedActions > 0 && (
                  <span className="text-xs text-muted-foreground" role="status">
                    {tr("Empty actions skipped")}: {skippedActions}
                  </span>
                )}
                {exportMode !== "sequence" && (
                  <>
                    <NumberField
                      label={tr("Columns")}
                      value={columns}
                      max={64}
                      onChange={setColumns}
                    />
                    <NumberField
                      label={tr("Spacing")}
                      value={gap}
                      min={0}
                      max={128}
                      onChange={setGap}
                    />
                  </>
                )}
                <Button
                  size="sm"
                  disabled={!!progress || !exportActions.length}
                  onClick={() => safe(exportAssets)}
                >
                  {tr("Download ZIP")}
                </Button>
                {progress && (
                  <>
                    <span className="text-xs" role="status">
                      {tr(progress)}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => abort.current?.abort()}>
                      {tr("Cancel")}
                    </Button>
                  </>
                )}
              </section>
            </>
          )}
        </main>
        {chatVisible && (
          <SpriteChat
            key={project.id}
            project={project}
            attachmentBridge={attachmentBridge}
            onThread={(threadId, activate = true) => {
              if (removedConversationIds.current.has(threadId))
                return Promise.reject(new Error("This sprite conversation has been deleted."));
              return changeThreads(
                [...new Set([...current.current.threadIds, threadId])],
                activate ? threadId : current.current.activeThreadId,
              );
            }}
            onThreads={changeThreads}
            onCreateReady={registerConversationCreator}
            syncContext={syncContext}
            onError={report}
          />
        )}
      </div>
      {rowImport && (
        <SpriteSheetActionsDialog
          source={rowImport.source}
          frames={rowImport.frames}
          actionDefaults={rowImport.actionDefaults}
          onClose={() => setRowImport(null)}
          onApply={(rows) => {
            let next = adoptSpriteSheetRows(current.current, rowImport.source.id, rows);
            if (rowImport.actionDefaults) {
              const existingIds = new Set(current.current.actions.map((a) => a.id));
              const imported = rows.filter((r) => r.enabled);
              let index = 0;
              next = {
                ...next,
                actions: next.actions.map((a) => {
                  if (existingIds.has(a.id)) return a;
                  const defaults = rowImport.actionDefaults?.[imported[index++]!.row - 1];
                  return defaults ? { ...a, fps: defaults.fps, loop: defaults.loop } : a;
                }),
              };
            }
            update(() => next);
            resetActionPreview();
            setRowImport(null);
          }}
        />
      )}
      <SpriteImageDialog asset={originalImage} onClose={() => setOriginalImage(null)} />
      <Dialog
        open={!!draftConflict}
        onOpenChange={(open) => {
          if (!open) setDraftConflict(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{tr("A draft already exists")}</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => {
                const plan = draftConflict!.error.currentPlan!;
                setDraftConflict(null);
                safe(() => openPlanConversation(plan.threadId, plan.id));
              }}
            >
              {tr("Continue editing current plan")}
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                safe(async () => {
                  const { error, input } = draftConflict!;
                  const current = error.currentPlan!;
                  const next = await drawingApi().spriteCommand({
                    ...input,
                    replacePlanId: current.id,
                    version: current.version,
                    displayAfter: new Date().toISOString(),
                  });
                  setState(next);
                  setDraftConflict(null);
                  if (next.resultPlanId)
                    await openPlanConversation(current.threadId, next.resultPlanId);
                })
              }
            >
              {tr("Discard current draft and create this plan")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={!!renameAction}
        onOpenChange={(open) => {
          if (!open) setRenameAction(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{tr("Rename action")}</DialogTitle>
          </DialogHeader>
          <input
            autoFocus
            className="mx-4 my-3 h-9 rounded border bg-background px-3 text-sm"
            aria-label={tr("Action name")}
            maxLength={200}
            value={renameAction?.name ?? ""}
            onChange={(e) => setRenameAction((a) => (a ? { ...a, name: e.target.value } : null))}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameAction(null)}>
              {tr("Cancel")}
            </Button>
            <Button
              disabled={!renameAction?.name.trim()}
              onClick={() => {
                if (!renameAction) return;
                update((p) => ({
                  ...p,
                  actions: p.actions.map((a) =>
                    a.id === renameAction.id ? { ...a, name: renameAction.name.trim() } : a,
                  ),
                }));
                setRenameAction(null);
              }}
            >
              {tr("Save")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={sourceEdit !== null}
        onOpenChange={(open) => {
          if (!open) setSourceEdit(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{tr("Rename image")}</DialogTitle>
          </DialogHeader>
          <input
            autoFocus
            aria-label={tr("Image name")}
            maxLength={200}
            className="mx-4 my-3 h-9 rounded border bg-background px-3 text-sm"
            value={sourceEdit?.name ?? ""}
            onChange={(e) => setSourceEdit((s) => (s ? { ...s, name: e.target.value } : null))}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSourceEdit(null)}>
              {tr("Cancel")}
            </Button>
            <Button
              disabled={!sourceEdit?.name.trim()}
              onClick={() => {
                if (!sourceEdit) return;
                update((p) => ({
                  ...p,
                  sources: p.sources.map((s) =>
                    s.id === sourceEdit.id ? { ...s, name: sourceEdit.name.trim() } : s,
                  ),
                }));
                setSourceEdit(null);
              }}
            >
              {tr("Save")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={sourceDelete !== null}
        onOpenChange={(open) => {
          if (!open) setSourceDelete(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{tr("Delete image")}</DialogTitle>
          </DialogHeader>
          <div className="px-4 py-3 text-sm">
            <p className="font-medium">
              {project.sources.find((s) => s.id === sourceDelete)?.name}
            </p>
            <p className="mt-2">
              {tr("This removes the image and its frames. You can undo this change.")}
            </p>
            {project.actions
              .filter((a) => a.frames.some((f) => f.sourceId === sourceDelete))
              .map((a) => (
                <p key={a.id} className="mt-1">
                  {a.name}: {a.frames.filter((f) => f.sourceId === sourceDelete).length}{" "}
                  {tr("frames")}
                </p>
              ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSourceDelete(null)}>
              {tr("Cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => sourceDelete && removeSource(sourceDelete)}
            >
              {tr("Delete")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={newActionName !== null}
        onOpenChange={(open) => {
          if (!open) setNewActionName(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{tr("New action from selection")}</DialogTitle>
          </DialogHeader>
          <input
            autoFocus
            aria-label={tr("Action name")}
            maxLength={200}
            className="mx-4 my-3 h-9 rounded border bg-background px-3 text-sm"
            value={newActionName ?? ""}
            onChange={(e) => setNewActionName(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewActionName(null)}>
              {tr("Cancel")}
            </Button>
            <Button
              disabled={!newActionName?.trim() || !selected.size}
              onClick={() => {
                if (!newActionName) return;
                try {
                  update((p) => actionFromSelectedFrames(p, selected, newActionName));
                  resetActionPreview();
                  setNewActionName(null);
                } catch (error) {
                  report(error);
                }
              }}
            >
              {tr("Create action")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <input
        ref={importRef}
        hidden
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          safe(() => importImages(files));
        }}
      />
    </div>
  );
}
