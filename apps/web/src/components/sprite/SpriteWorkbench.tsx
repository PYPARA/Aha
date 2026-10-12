import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useBlocker } from "@tanstack/react-router";
import type { SpriteRun, SpriteState } from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "../ui/button";
import { DrawingModelPicker } from "../drawing/DrawingPickers";
import {
  drawingApi,
  imageUrl,
  uploadDrawingImage,
  useImageProviders,
  useDrawingEvents,
} from "../drawing/useDrawing";
import { downloadBlob } from "~/lib/browserDownload";
import {
  newSpriteProject,
  spriteContext,
  sliceFrames,
  framePlacement,
  moveFrames,
  uuid,
  safeFilename,
  type SpriteProject,
  type SpriteSource,
  type SpriteAction,
  type SliceSettings,
} from "./spriteModel";
import { listSpriteProjects, saveSpriteProject, deleteSpriteProject } from "./spriteStorage";
import {
  suggestChromaKey,
  decodeSpriteSource,
  exportSpriteProject,
  importSpriteProject,
  exportSpriteAssets,
} from "./spriteFiles";
import { SpritePreview, SpriteThumbnail, FrameThumbnail } from "./SpritePreview";
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
export default function SpriteWorkbench() {
  const tr = useAhaTranslation();
  const navigate = useNavigate();
  const providers = useImageProviders();
  useDrawingEvents();
  const [project, setProject] = useState<SpriteProject>(newSpriteProject);
  const current = useRef(project);
  current.current = project;
  const [loaded, setLoaded] = useState(false),
    [projects, setProjects] = useState<SpriteProject[]>([]);
  const [saveStatus, setSaveStatus] = useState("Loading…"),
    [error, setError] = useState("");
  const [past, setPast] = useState<SpriteProject[]>([]),
    [future, setFuture] = useState<SpriteProject[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set()),
    [index, setIndex] = useState(0),
    [playing, setPlaying] = useState(false);
  const [onion, setOnion] = useState(false),
    [chatVisible, setChatVisible] = useState(true),
    [sourceId, setSourceId] = useState("");
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
  const [candidate, setCandidate] = useState<SpriteProject | null>(null),
    [candidateId, setCandidateId] = useState<string | null>(null);
  const [exportMode, setExportMode] = useState<"sequence" | "atlas">("atlas"),
    [allActions, setAllActions] = useState(false),
    [columns, setColumns] = useState(8),
    [gap, setGap] = useState(0);
  const [progress, setProgress] = useState("");
  const abort = useRef<AbortController | null>(null);
  const saveTail = useRef<Promise<void>>(Promise.resolve());
  const importRef = useRef<HTMLInputElement>(null),
    projectImportRef = useRef<HTMLInputElement>(null);
  const report = useCallback(
    (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    [],
  );
  const action =
    project.actions.find((a) => a.id === project.selectedActionId) ?? project.actions[0]!;
  const previewProject = candidate ?? project;
  const previewAction = candidate?.actions[0] ?? action;
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
    const previous = current.current;
    const next = { ...fn(previous), updatedAt: new Date().toISOString() };
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
  const save = useCallback(async (p: SpriteProject) => {
    const pending = saveSpriteProject(p);
    saveTail.current = pending;
    await pending;
    if (current.current === p) setSaveStatus("Saved locally");
  }, []);
  useEffect(() => {
    let alive = true;
    void listSpriteProjects()
      .then((items) => {
        if (!alive) return;
        setProjects(items);
        const last = localStorage.getItem("aha:sprite:last");
        const next = items.find((p) => p.id === last) ?? items[0] ?? newSpriteProject();
        current.current = next;
        setProject(next);
        setLoaded(true);
      })
      .catch((e) => {
        if (alive) {
          report(e);
          setLoaded(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [report]);
  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => {
      void save(project)
        .then(() => {
          localStorage.setItem("aha:sprite:last", project.id);
        })
        .catch((e) => {
          setSaveStatus("Save failed");
          report(e);
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [project, loaded, save, report]);
  useEffect(
    () => () => {
      if (loaded) void saveSpriteProject(current.current).catch(() => {});
    },
    [loaded],
  );
  useBlocker({
    shouldBlockFn: async () => {
      if (!loaded) return false;
      try {
        await save(current.current);
        return false;
      } catch (error) {
        report(error);
        setSaveStatus("Save failed");
        return true;
      }
    },
    enableBeforeUnload: () => loaded && saveStatus !== "Saved locally",
  });
  const syncContext = useCallback(async () => {
    const snapshot = current.current;
    await save(snapshot);
    await drawingApi().spriteCommand({
      operation: "sync",
      projectId: snapshot.id,
      context: spriteContext(snapshot),
    });
  }, [save]);
  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => {
      void drawingApi()
        .spriteCommand({
          operation: "sync",
          projectId: project.id,
          context: spriteContext(project),
        })
        .catch(report);
    }, 400);
    return () => clearTimeout(timer);
  }, [project, loaded, report]);
  useEffect(() => {
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
  }, [project.id, report]);
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
  const switchProject = async (next: SpriteProject) => {
    await save(current.current);
    await saveTail.current;
    current.current = next;
    setProject(next);
    setPast([]);
    setFuture([]);
    setIndex(0);
    setPlaying(false);
    setSourceId("");
    setCandidate(null);
    setCandidateId(null);
    setSelected(new Set());
    await save(next);
    setProjects(await listSpriteProjects());
  };
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
    if (current.current.id !== owner || !sources.length) return;
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
  const chooseReference = async (id: string) => {
    const owner = current.current.id,
      source = current.current.sources.find((s) => s.id === id);
    if (!source) return;
    const chromaKey = await suggestChromaKey(source.blob);
    const asset = await uploadDrawingImage(source.blob, source.name);
    if (current.current.id !== owner) return;
    update((p) => ({
      ...p,
      referenceSourceId: id,
      chromaKey,
      sources: p.sources.map((s) => (s.id === id ? { ...s, assetId: asset.id } : s)),
    }));
  };
  const inspectCandidate = async (run: SpriteRun) => {
    const owner = current.current.id;
    const sources: SpriteSource[] = [];
    for (const asset of run.frames) {
      const response = await fetch(imageUrl(asset), { credentials: "include" });
      if (!response.ok) throw new Error("Could not download candidate.");
      const source = await decodeSpriteSource(await response.blob(), asset.name);
      sources.push({ ...source, assetId: asset.id });
    }
    if (current.current.id !== owner) return;
    const p = newSpriteProject();
    const action = {
      ...p.actions[0]!,
      name: run.context.action,
      fps: run.context.fps,
      loop: run.input.loop ?? true,
      frames: sources.map((s) => ({
        id: uuid(),
        sourceId: s.id,
        x: 0,
        y: 0,
        width: s.width,
        height: s.height,
        offsetX: 0,
        offsetY: 0,
      })),
    };
    setSourceId("");
    setCandidate({
      ...p,
      width: run.context.width,
      height: run.context.height,
      sources,
      actions: [action],
    });
    setCandidateId(run.id);
    setIndex(0);
    setPlaying(run.input.kind === "animation");
  };
  const adopt = async () => {
    const run = state.runs.find((r) => r.id === candidateId);
    if (!candidate || !run || project.adoptedCandidateIds.includes(run.id)) return;
    const accepted = candidate;
    if (
      [...current.current.sources, ...accepted.sources].reduce((n, s) => n + s.blob.size, 0) >
      80 * 1024 * 1024
    )
      throw new Error("Project images exceed 80 MiB. Create another project.");
    const owner = current.current.id;
    const chromaKey =
      run.input.kind === "character"
        ? await suggestChromaKey(accepted.sources[0]!.blob)
        : current.current.chromaKey;
    if (current.current.id !== owner || current.current.adoptedCandidateIds.includes(run.id))
      return;
    update((p) => ({
      ...p,
      sources: [...p.sources, ...accepted.sources],
      chromaKey,
      actions: run.input.kind === "character" ? p.actions : [...p.actions, accepted.actions[0]!],
      selectedActionId:
        run.input.kind === "character" ? p.selectedActionId : accepted.actions[0]!.id,
      referenceSourceId:
        run.input.kind === "character" ? accepted.sources[0]!.id : p.referenceSourceId,
      adoptedCandidateIds: [...p.adoptedCandidateIds, run.id],
      provenance: [
        ...p.provenance,
        {
          runId: run.id,
          prompt: run.input.prompt,
          action: run.context.action,
          model: run.context.model,
          providerId: run.context.providerId,
        },
      ],
    }));
    setCandidate(null);
    setCandidateId(null);
    setPlaying(false);
    setIndex(0);
  };
  const runCommand = async (run: SpriteRun, operation: "cancel" | "retry") => {
    const owner = project.id;
    const next = await drawingApi().spriteCommand({
      operation,
      projectId: owner,
      runId: run.id,
      ...(operation === "retry" ? { input: { ...run.input, requestId: uuid() } } : {}),
    });
    if (current.current.id === owner) setState(next);
  };
  const exportAssets = async () => {
    const controller = new AbortController();
    abort.current = controller;
    setProgress("Preparing export…");
    try {
      const blob = await exportSpriteAssets(
        project,
        allActions ? project.actions.map((a) => a.id) : [action.id],
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
    update(() => next, false);
  };
  const redo = () => {
    const next = future.at(-1);
    if (!next) return;
    setFuture((f) => f.slice(0, -1));
    setPast((p) => [...p, current.current]);
    update(() => next, false);
  };
  const safe = (fn: () => Promise<unknown>) => {
    setError("");
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
  if (!loaded) return <div className="p-6">{tr("Loading…")}</div>;
  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background"
      data-testid="sprite-workbench"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        safe(() => importImages(Array.from(e.dataTransfer.files)));
      }}
    >
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <h1 className="mr-2 text-sm font-semibold">{tr("Sprite animation")}</h1>
        <input
          className={`${inputClass} w-36`}
          value={project.name}
          aria-label={tr("Project name")}
          onChange={(e) => update((p) => ({ ...p, name: e.target.value }))}
        />
        <span className="text-xs text-muted-foreground" role="status">
          {tr(saveStatus)}
        </span>
        <select
          aria-label={tr("Open project")}
          className={`${inputClass} max-w-36`}
          value={project.id}
          onFocus={() => safe(async () => setProjects(await listSpriteProjects()))}
          onChange={(e) => {
            const next = projects.find((p) => p.id === e.target.value);
            if (next) safe(() => switchProject(next));
          }}
        >
          {[project, ...projects.filter((p) => p.id !== project.id)].map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="outline"
          onClick={() => safe(() => switchProject(newSpriteProject()))}
        >
          {tr("New")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => importRef.current?.click()}>
          {tr("Import images")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => projectImportRef.current?.click()}>
          {tr("Open package")}
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
          onClick={() => {
            if (window.confirm(tr("Delete this local sprite project?")))
              safe(async () => {
                const id = project.id;
                await switchProject(newSpriteProject());
                await deleteSpriteProject(id);
                setProjects(await listSpriteProjects());
              });
          }}
        >
          {tr("Delete")}
        </Button>
        <div className="ml-auto flex items-center gap-2">
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
      {error && (
        <div
          role="alert"
          className="flex items-center gap-3 border-b bg-destructive/10 px-4 py-2 text-sm text-destructive"
        >
          <span className="flex-1">{tr(error)}</span>
          <button onClick={() => setError("")} aria-label={tr("Dismiss")}>
            ×
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 overflow-auto">
        <aside className="flex w-44 shrink-0 flex-col gap-4 overflow-y-auto border-r p-3">
          <section>
            <div className="mb-2 flex items-center justify-between text-xs font-semibold">
              {tr("Actions")}
              <Button
                size="sm"
                variant="ghost"
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
            </div>
            {project.actions.map((a) => (
              <button
                key={a.id}
                className={`mb-1 flex w-full items-center justify-between rounded px-2 py-2 text-left text-xs ${a.id === action.id ? "bg-accent text-accent-foreground" : "hover:bg-muted"}`}
                onClick={() => {
                  update((p) => ({ ...p, selectedActionId: a.id }), false);
                  setCandidate(null);
                  setCandidateId(null);
                  setSourceId("");
                  setIndex(0);
                  setSelected(new Set());
                }}
              >
                <span className="truncate">{a.name}</span>
                <span>{a.frames.length}</span>
              </button>
            ))}
          </section>
          <section>
            <h2 className="mb-2 text-xs font-semibold">{tr("Source images")}</h2>
            {project.sources.map((s) => (
              <div key={s.id} className="mb-2 rounded border p-1">
                <button
                  className="flex w-full items-center gap-1 text-left text-xs"
                  onClick={() => {
                    setSourceId(s.id);
                    setCandidate(null);
                    setPlaying(false);
                  }}
                >
                  <SpriteThumbnail blob={s.blob} label={s.name} />
                  <span className="truncate">{s.name}</span>
                </button>
                <button
                  className="w-full text-xs text-primary"
                  onClick={() => safe(() => chooseReference(s.id))}
                >
                  {tr(
                    project.referenceSourceId === s.id
                      ? "Canonical reference ✓"
                      : "Use as reference",
                  )}
                </button>
              </div>
            ))}
          </section>
        </aside>
        <main className="flex min-w-80 flex-1 flex-col gap-3 overflow-y-auto p-4">
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
                <div className="flex items-center gap-2 rounded border border-primary/30 p-2 text-xs">
                  <span className="flex-1">
                    {tr("Candidate preview — your existing animation is preserved")}
                  </span>
                  <Button
                    size="sm"
                    disabled={project.adoptedCandidateIds.includes(candidateId ?? "")}
                    onClick={() => safe(adopt)}
                  >
                    {tr("Adopt candidate")}
                  </Button>
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
                    setIndex((i) => Math.max(0, Math.min(previewAction.frames.length - 1, i + 1)));
                  }}
                >
                  →
                </Button>
                <span className="text-xs">
                  {frame ? index + 1 : 0} / {previewAction.frames.length}
                </span>
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
          <div
            className="flex min-h-16 gap-1 overflow-x-auto rounded border p-2"
            aria-label={tr("Animation frames")}
          >
            {previewAction.frames.map((f, i) => (
              <button
                key={f.id}
                draggable={!candidate}
                onDragStart={(e) => e.dataTransfer.setData("application/x-aha-sprite-frame", f.id)}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes("application/x-aha-sprite-frame"))
                    e.preventDefault();
                }}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData("application/x-aha-sprite-frame");
                  if (!id) return;
                  e.preventDefault();
                  e.stopPropagation();
                  editAction((a) => {
                    const from = a.frames.findIndex((f) => f.id === id);
                    if (from < 0) return a;
                    const frames = [...a.frames];
                    const [moved] = frames.splice(from, 1);
                    frames.splice(i, 0, moved!);
                    return { ...a, frames };
                  });
                }}
                className={`flex w-14 shrink-0 flex-col items-center rounded border text-xs ${i === index ? "border-primary bg-accent" : ""} ${selected.has(f.id) ? "ring-1 ring-primary" : ""}`}
                onClick={(e) => {
                  setIndex(i);
                  setPlaying(false);
                  if (!candidate)
                    setSelected((prev) =>
                      e.metaKey || e.ctrlKey || e.shiftKey
                        ? new Set(
                            prev.has(f.id)
                              ? [...prev].filter((id) => id !== f.id)
                              : [...prev, f.id],
                          )
                        : new Set([f.id]),
                    );
                }}
              >
                <FrameThumbnail
                  source={previewProject.sources.find((s) => s.id === f.sourceId)!}
                  frame={f}
                />
                <span>{i + 1}</span>
                <span>
                  {f.width}×{f.height}
                </span>
              </button>
            ))}
          </div>
          {!candidate && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setSelected(new Set(action.frames.map((f) => f.id)))}
              >
                {tr("Select all frames")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!selected.size}
                onClick={() =>
                  editAction((a) => ({ ...a, frames: moveFrames(a.frames, selected, -1) }))
                }
              >
                {tr("Move earlier")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!selected.size}
                onClick={() =>
                  editAction((a) => ({ ...a, frames: moveFrames(a.frames, selected, 1) }))
                }
              >
                {tr("Move later")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!selected.size}
                onClick={() => {
                  editAction((a) => ({
                    ...a,
                    frames: a.frames.filter((f) => !selected.has(f.id)),
                  }));
                  setSelected(new Set());
                  setIndex(0);
                }}
              >
                {tr("Remove frames")}
              </Button>
            </div>
          )}
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
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const copy = {
                    ...action,
                    id: uuid(),
                    name: `${action.name} copy`,
                    frames: action.frames.map((f) => ({ ...f, id: uuid() })),
                  };
                  update((p) => ({
                    ...p,
                    actions: [...p.actions, copy],
                    selectedActionId: copy.id,
                  }));
                }}
              >
                {tr("Duplicate action")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={project.actions.length < 2}
                onClick={() => {
                  update((p) => ({
                    ...p,
                    actions: p.actions.filter((a) => a.id !== action.id),
                    selectedActionId: p.actions.find((a) => a.id !== action.id)!.id,
                  }));
                  setIndex(0);
                }}
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
                        frames: a.frames.map((f) => (f.id === frame.id ? { ...f, offsetX } : f)),
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
                        frames: a.frames.map((f) => (f.id === frame.id ? { ...f, offsetY } : f)),
                      }))
                    }
                  />
                </>
              )}
              <NumberField
                label={tr("Generated frames")}
                value={project.generationFrameCount}
                max={32}
                onChange={(generationFrameCount) => update((p) => ({ ...p, generationFrameCount }))}
              />
              <select
                aria-label={tr("Generated background")}
                className={inputClass}
                value={project.background}
                onChange={(e) =>
                  update((p) => ({ ...p, background: e.target.value as "chroma" | "transparent" }))
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
          <section className="rounded border p-3">
            <h2 className="mb-2 text-xs font-semibold">{tr("Generation candidates")}</h2>
            {!state.runs.length && (
              <p className="text-xs text-muted-foreground">
                {tr(
                  "Ask the conversation to generate a character or an action. Results appear here.",
                )}
              </p>
            )}
            <div className="flex flex-col gap-2">
              {state.runs.toReversed().map((run) => (
                <div key={run.id} className="rounded bg-muted/40 p-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong>
                      {run.input.kind === "character" ? tr("Character") : run.context.action}
                    </strong>
                    <span role="status">{tr(run.status)}</span>
                    <span className="text-muted-foreground">
                      {run.context.frameCount} {tr("frames")}
                    </span>
                    {run.frames.length > 0 && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => safe(() => inspectCandidate(run))}
                      >
                        {tr("Preview")}
                      </Button>
                    )}
                    {run.source && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          safe(async () => {
                            const owner = project.id;
                            const response = await fetch(imageUrl(run.source!), {
                              credentials: "include",
                            });
                            if (!response.ok) throw new Error("Could not download original image.");
                            const source = await decodeSpriteSource(
                              await response.blob(),
                              run.source!.name,
                            );
                            if (current.current.id !== owner) return;
                            update((p) => ({ ...p, sources: [...p.sources, source] }));
                            setSourceId(source.id);
                            setSlice((s) => ({ ...s, columns: run.context.frameCount, rows: 1 }));
                          })
                        }
                      >
                        {tr("Adjust original")}
                      </Button>
                    )}
                    {["queued", "running", "processing"].includes(run.status) ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => safe(() => runCommand(run, "cancel"))}
                      >
                        {tr("Cancel")}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => safe(() => runCommand(run, "retry"))}
                      >
                        {tr("Retry generation")}
                      </Button>
                    )}
                    {project.adoptedCandidateIds.includes(run.id) && <span>{tr("Adopted")}</span>}
                  </div>
                  {run.error && <p className="mt-1 text-destructive">{run.error}</p>}
                  {run.warnings.map((w) => (
                    <p key={w} className="mt-1 text-orange-600">
                      {w}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          </section>
          <section className="flex flex-wrap items-center gap-2 rounded border p-3">
            <strong className="text-xs">{tr("Export")}</strong>
            <select
              className={inputClass}
              aria-label={tr("Export format")}
              value={exportMode}
              onChange={(e) => setExportMode(e.target.value as "atlas" | "sequence")}
            >
              <option value="atlas">{tr("PNG atlas + JSON")}</option>
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
            {exportMode === "atlas" && (
              <>
                <NumberField label={tr("Columns")} value={columns} max={64} onChange={setColumns} />
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
              disabled={!!progress || !action.frames.length}
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
        </main>
        {chatVisible && (
          <SpriteChat
            key={project.id}
            project={project}
            onThread={(threadId) => {
              if (current.current.id === project.id) update((p) => ({ ...p, threadId }), false);
            }}
            syncContext={syncContext}
            onError={report}
          />
        )}
      </div>
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
      <input
        ref={projectImportRef}
        hidden
        type="file"
        accept=".zip"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) safe(async () => switchProject(await importSpriteProject(file)));
        }}
      />
    </div>
  );
}
