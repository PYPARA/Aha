import { lazy, Suspense, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Model3DBuild,
  Model3DCommand,
  Model3DEnvironment,
  Model3DMaterialEdit,
  Model3DProject,
  Model3DVersion,
} from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { SkillCubeIcon, PlusIcon, ArrowLeftIcon } from "~/lib/icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import { OptionSelect } from "../ui/option-select";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";
import { confirmDialog } from "../ui/confirm-dialog";
import { RouteSurfaceHeader } from "../RouteSurface";
import {
  ModelRuntimeDialog,
  shouldRemindBlender,
  type RuntimeDialogIntent,
} from "./ModelRuntimeDialog";
import { collectResources } from "../resources/resourceLibrary";
const ModelChat = lazy(() =>
  import("./ModelChat").then((module) => ({ default: module.ModelChat })),
);
import {
  model3dApi,
  model3dKey,
  modelAssetUrl,
  useModel3D,
  useModel3DCommand,
  useModel3DEvents,
} from "./useModel3D";

const ModelViewer = lazy(() => import("./ModelViewer"));
const running = (status: string) => ["queued", "running", "validating"].includes(status);
const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(2) + " MB";

export default function Model3DWorkbench({ projectId }: { projectId?: string }) {
  useModel3DEvents();
  const tr = useAhaTranslation(),
    navigate = useNavigate(),
    queryClient = useQueryClient(),
    command = useModel3DCommand(),
    narrow = useMediaQuery("(max-width: 900px)");
  const [query, setQuery] = useState(""),
    [archived, setArchived] = useState(false),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [settings, setSettings] = useState<RuntimeDialogIntent | null>(null);
  const list = useQuery({ queryKey: [...model3dKey, "list"], queryFn: () => model3dApi().list() });
  const detail = useModel3D(projectId ?? null);
  const environment = useQuery({
    queryKey: [...model3dKey, "environment"],
    queryFn: async () => (await model3dApi().command({ operation: "environment" })).environment!,
  });
  const showError = (cause: unknown) =>
    setError(cause instanceof Error ? cause.message : String(cause));
  const select = (id?: string) => {
    setError(null);
    void navigate({ to: "/model3d", search: id ? { projectId: id } : {} });
  };
  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await command({ operation: "create", name: tr("Untitled 3D project") });
      if (result.project) select(result.project.id);
    } catch (cause) {
      showError(cause);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {!projectId && (
        <RouteSurfaceHeader>
          <SkillCubeIcon className="size-4" />
          <h1 className="text-ui font-medium">{tr("3D Workshop")}</h1>
          <div className="no-drag ms-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSettings("settings")}>
              {tr("Runtime settings")}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void create()}>
              <PlusIcon />
              {tr("New 3D project")}
            </Button>
          </div>
        </RouteSurfaceHeader>
      )}
      {(error || detail.error || list.error) && (
        <div
          role="alert"
          className="flex items-start gap-2 border-b border-border p-3 text-ui-sm text-destructive"
        >
          <span className="min-w-0 flex-1 break-words">
            {error ?? detail.error?.message ?? list.error?.message}
          </span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setError(null);
              void detail.refetch();
              void list.refetch();
            }}
          >
            {tr("Retry")}
          </Button>
        </div>
      )}
      {environment.data && !environment.data.desktop && (
        <div
          role="status"
          className="border-b border-border px-4 py-2 text-ui-sm text-muted-foreground"
        >
          {tr(
            "Local 3D execution requires the Aha desktop app. Saved models remain available for preview.",
          )}
        </div>
      )}
      {projectId ? (
        detail.data ? (
          <ProjectWorkspace
            key={detail.data.id}
            project={detail.data}
            narrow={narrow}
            desktop={environment.data?.desktop === true}
            onBack={() => select()}
            onError={showError}
            onSettings={() => setSettings("settings")}
            onBlenderSelected={() => {
              const current = queryClient.getQueryData<Model3DEnvironment>([
                ...model3dKey,
                "environment",
              ]);
              if (shouldRemindBlender(current)) setSettings("blender");
            }}
          />
        ) : (
          <div className="p-5 text-ui-sm" role="status">
            {tr(detail.error ? "Model project unavailable" : "Loading…")}
            <Button className="ms-3" size="sm" variant="outline" onClick={() => select()}>
              {tr("Back to projects")}
            </Button>
          </div>
        )
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-5">
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <Input
              className="max-w-sm"
              aria-label={tr("Search 3D projects")}
              placeholder={tr("Search 3D projects")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <label className="flex items-center gap-2 text-ui-sm">
              <Checkbox
                checked={archived}
                onCheckedChange={(value) => setArchived(value === true)}
              />
              {tr("Archived projects")}
            </label>
          </div>
          {list.isLoading && (
            <p role="status" className="text-ui-sm text-muted-foreground">
              {tr("Loading…")}
            </p>
          )}
          {!list.isLoading &&
            !list.data?.some(
              (p) => p.archived === archived && p.name.toLowerCase().includes(query.toLowerCase()),
            ) && (
              <div className="mx-auto flex max-w-lg flex-col items-center gap-4 py-16 text-center">
                <SkillCubeIcon className="size-10 text-muted-foreground" />
                <h2 className="text-ui-lg font-medium">
                  {tr(archived ? "No archived models" : "Create your first game prop")}
                </h2>
                <p className="text-ui-sm text-muted-foreground">
                  {tr(
                    "Generate a static prop with Three.js or Blender, inspect the real model, then adopt and export it as GLB.",
                  )}
                </p>
                {!archived && (
                  <Button disabled={busy} onClick={() => void create()}>
                    {tr("New 3D project")}
                  </Button>
                )}
              </div>
            )}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4">
            {list.data
              ?.filter(
                (p) =>
                  p.archived === archived && p.name.toLowerCase().includes(query.toLowerCase()),
              )
              .map((project) => (
                <button
                  key={project.id}
                  type="button"
                  className="overflow-hidden rounded-lg border border-border text-start outline-none hover:bg-accent/40 focus-visible:ring-1 focus-visible:ring-ring"
                  onClick={() => select(project.id)}
                >
                  <div className="flex aspect-[4/3] items-center justify-center bg-muted/30">
                    {project.previewVersionId ? (
                      <img
                        className="h-full w-full object-contain"
                        alt=""
                        loading="lazy"
                        src={modelAssetUrl(project.id, project.previewVersionId, "thumbnail.png")}
                      />
                    ) : (
                      <SkillCubeIcon className="size-10 text-muted-foreground" />
                    )}
                  </div>
                  <div className="space-y-1 p-3">
                    <p className="truncate text-ui font-medium">{project.name}</p>
                    <p className="text-ui-xs text-muted-foreground">
                      {project.mode === "blender" ? "Blender MCP" : "Three.js"} · {project.versions}{" "}
                      {tr("versions")}
                      {project.running ? " · " + tr("Building…") : ""}
                    </p>
                  </div>
                </button>
              ))}
          </div>
        </div>
      )}
      {settings && (
        <ModelRuntimeDialog
          intent={settings}
          initial={environment.data}
          onClose={() => setSettings(null)}
          onChanged={(value) => queryClient.setQueryData([...model3dKey, "environment"], value)}
        />
      )}
    </>
  );
}

function ProjectWorkspace({
  project,
  narrow,
  desktop,
  onBack,
  onError,
  onSettings,
  onBlenderSelected,
}: {
  project: Model3DProject;
  narrow: boolean;
  desktop: boolean;
  onBack: () => void;
  onError: (e: unknown) => void;
  onSettings: () => void;
  onBlenderSelected: () => void;
}) {
  const tr = useAhaTranslation(),
    command = useModel3DCommand();
  const [selected, setSelected] = useState<string | null>(project.previewVersionId),
    [object, setObject] = useState<string | null>(null),
    [leftTab, setLeftTab] = useState<"objects" | "versions">("versions"),
    [phase, setPhase] = useState<"generate" | "inspect" | "export">("generate"),
    [tool, setTool] = useState<"assistant" | "properties">("assistant"),
    [drawer, setDrawer] = useState(false),
    [source, setSource] = useState<{ name: string; build: Model3DBuild } | null>(null),
    [busy, setBusy] = useState(false),
    [exportPath, setExportPath] = useState<string | null>(null);
  const lastVersion = project.versions.at(-1)?.id ?? null;
  useEffect(() => {
    setSelected(project.previewVersionId ?? lastVersion);
  }, [project.previewVersionId, lastVersion]);
  const selectVersion = (id: string) => {
    setSelected(id);
    setObject(null);
    void act({ operation: "select-version", versionId: id });
  };
  const version = project.versions.find((v) => v.id === selected) ?? project.versions.at(-1),
    activeJob = project.jobs.find((j) => running(j.status)),
    lastJob = project.jobs.at(-1);
  const act = async (input: Omit<Model3DCommand, "projectId" | "revision">) => {
    setBusy(true);
    try {
      const latest = await model3dApi().get({ id: project.id });
      const result = await command({ ...input, projectId: project.id, revision: latest.revision });
      if (result.exportPath) setExportPath(result.exportPath);
      return result;
    } catch (error) {
      onError(error);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const submit = (build: Model3DBuild) =>
    act({ operation: "submit", build, requestId: crypto.randomUUID() });
  const showSource = (v: Model3DVersion) => {
    const build = resolveProceduralBuild(project, v);
    setSource({ name: v.name, build });
  };
  const setFlow = (value: typeof phase) => {
    setPhase(value);
    if (value === "generate") setTool("assistant");
    if (value === "inspect") setTool("properties");
  };
  const tools = (
    <div className="flex min-h-0 flex-1 flex-col">
      {phase !== "export" && (
        <div
          className="flex gap-1 border-b border-border p-2"
          role="tablist"
          aria-label={tr("Model tools")}
        >
          {(["assistant", "properties"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={tool === value ? "secondary" : "ghost"}
              role="tab"
              aria-selected={tool === value}
              onClick={() => setTool(value)}
            >
              {tr(value === "assistant" ? "AI assistant" : "Properties")}
            </Button>
          ))}
        </div>
      )}
      <div
        className={
          phase !== "export" && tool === "assistant" ? "flex min-h-0 flex-1 flex-col" : "hidden"
        }
      >
        <Suspense fallback={<p className="p-4 text-ui-sm">{tr("Loading…")}</p>}>
          <ModelChat project={project} onError={onError} />
        </Suspense>
      </div>
      {phase !== "export" && tool === "properties" && (
        <ModelProperties
          key={version?.id ?? "empty"}
          project={project}
          version={version}
          disabled={busy || !!activeJob || !desktop || project.archived}
          onSubmit={submit}
          onTexture={() => void act({ operation: "texture" })}
          onUpdate={(input) => void act({ operation: "update", ...input })}
          onSource={() => version && showSource(version)}
        />
      )}
      {phase === "export" && (
        <ExportPanel
          project={project}
          version={version}
          disabled={busy || !desktop}
          path={exportPath}
          onExport={(input) => void act({ operation: "export", ...input })}
          onAdopt={() => version && void act({ operation: "adopt", versionId: version.id })}
        />
      )}
    </div>
  );
  return (
    <>
      <RouteSurfaceHeader rowClassName="gap-2">
        <Button
          className="no-drag"
          size="icon-sm"
          variant="ghost"
          aria-label={tr("Back to projects")}
          onClick={onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-ui font-medium" title={project.name}>
          {project.name}
        </h1>
        <div className="no-drag flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={onSettings}>
            {tr("Runtime")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !desktop || !!activeJob || project.archived}
            onClick={() => void act({ operation: "import" })}
          >
            {tr("Import model")}
          </Button>
          {narrow && (
            <Button size="sm" onClick={() => setDrawer(true)}>
              {tr("Tools")}
            </Button>
          )}
        </div>
      </RouteSurfaceHeader>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-1" role="tablist" aria-label={tr("3D workflow")}>
          {(["generate", "inspect", "export"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={phase === value ? "secondary" : "ghost"}
              role="tab"
              aria-selected={phase === value}
              onClick={() => setFlow(value)}
            >
              {tr(value === "generate" ? "Generate" : value === "inspect" ? "Inspect" : "Export")}
            </Button>
          ))}
        </div>
        <div className="ms-auto min-w-36 max-w-48">
          <OptionSelect
            label={tr("Modeling route")}
            value={project.mode}
            disabled={busy || !!activeJob || project.archived}
            onValueChange={(mode) => {
              if (mode === project.mode) return;
              void act({
                operation: "update",
                mode: mode === "blender" ? "blender" : "threejs",
              }).then((result) => {
                if (result?.project?.mode === "blender") onBlenderSelected();
              });
            }}
          >
            <option value="threejs">Three.js</option>
            <option value="blender">Blender MCP</option>
          </OptionSelect>
        </div>
        {version && (
          <Button
            size="sm"
            disabled={busy || project.adoptedVersionId === version.id || project.archived}
            onClick={() => void act({ operation: "adopt", versionId: version.id })}
          >
            {tr(project.adoptedVersionId === version.id ? "Adopted" : "Adopt this version")}
          </Button>
        )}
      </div>
      {project.archived && (
        <div
          role="status"
          className="flex items-center justify-between border-b border-border px-4 py-2 text-ui-sm"
        >
          {tr("This project is archived.")}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void act({ operation: "archive", archived: false })}
          >
            {tr("Restore")}
          </Button>
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1">
        <aside
          className="hidden w-48 shrink-0 flex-col border-e border-border xl:flex"
          aria-label={tr("Model objects and versions")}
        >
          <div className="flex gap-1 p-2" role="tablist" aria-label={tr("Project browser")}>
            {(["objects", "versions"] as const).map((value) => (
              <Button
                key={value}
                size="xs"
                role="tab"
                aria-selected={leftTab === value}
                variant={leftTab === value ? "secondary" : "ghost"}
                onClick={() => setLeftTab(value)}
              >
                {tr(value === "objects" ? "Objects" : "Versions")}
              </Button>
            ))}
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-auto p-2">
            {leftTab === "versions"
              ? project.versions.toReversed().map((v) => (
                  <Button
                    key={v.id}
                    className="h-auto w-full flex-col items-start gap-1 whitespace-normal py-2 text-start"
                    size="sm"
                    variant={version?.id === v.id ? "secondary" : "ghost"}
                    aria-pressed={version?.id === v.id}
                    onClick={() => selectVersion(v.id)}
                  >
                    <span>
                      {v.name} · {v.build.mode === "blender" ? "Blender" : "Three.js"}
                    </span>
                    <span className="text-ui-xs text-muted-foreground">
                      {tr(project.adoptedVersionId === v.id ? "Adopted" : "Candidate")} ·{" "}
                      {v.report.triangles.toLocaleString()}
                    </span>
                  </Button>
                ))
              : version?.report.objects.map((part) => (
                  <Button
                    key={part.id}
                    className="w-full justify-start truncate"
                    size="sm"
                    variant={object === part.id ? "secondary" : "ghost"}
                    aria-pressed={object === part.id}
                    onClick={() => setObject(part.id)}
                  >
                    <span
                      className="truncate"
                      style={{ paddingInlineStart: `${Math.min(part.depth ?? 0, 12) * 0.75}rem` }}
                    >
                      {part.name}
                    </span>
                  </Button>
                ))}
            {!version && (
              <p className="p-2 text-ui-xs text-muted-foreground">
                {tr("Build or import a model to begin.")}
              </p>
            )}
          </div>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy || !!activeJob}
            onClick={() =>
              void (async () => {
                if (
                  await confirmDialog({
                    title: tr(project.archived ? "Restore project?" : "Archive project?"),
                    description: tr("Models, source files and versions will be retained."),
                    confirmLabel: tr(project.archived ? "Restore" : "Archive"),
                  })
                )
                  await act({ operation: "archive", archived: !project.archived });
              })()
            }
          >
            {tr(project.archived ? "Restore project" : "Archive project")}
          </Button>
        </aside>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={tr("3D model preview")}>
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-ui-xs text-muted-foreground">
            <div className="min-w-36 flex-1 xl:hidden">
              <OptionSelect
                label={tr("Preview version")}
                value={version?.id ?? "empty"}
                onValueChange={selectVersion}
              >
                {project.versions.length ? (
                  project.versions.toReversed().map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name} · {tr(project.adoptedVersionId === v.id ? "Adopted" : "Candidate")}
                    </option>
                  ))
                ) : (
                  <option value="empty">{tr("No versions")}</option>
                )}
              </OptionSelect>
            </div>
            <span>
              {version
                ? version.name +
                  " · " +
                  tr(project.adoptedVersionId === version.id ? "Adopted" : "Candidate")
                : tr("No model yet")}
            </span>
            <span className="ms-auto">
              {version
                ? version.report.triangles.toLocaleString() +
                  " " +
                  tr("triangles") +
                  " · " +
                  mb(version.report.bytes)
                : "—"}
            </span>
          </div>
          {version ? (
            <Suspense
              fallback={
                <div role="status" className="p-5 text-ui-sm">
                  {tr("Loading model…")}
                </div>
              }
            >
              <ModelViewer
                url={modelAssetUrl(project.id, version.id)}
                selectedId={object}
                onSelect={setObject}
              />
            </Suspense>
          ) : (
            <div className="flex min-h-40 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <SkillCubeIcon className="size-12 text-muted-foreground" />
              <h2 className="text-ui-lg font-medium">{tr("Your next game prop starts here")}</h2>
              <p className="max-w-md text-ui-sm text-muted-foreground">
                {tr(
                  "Choose Three.js or Blender, start a conversation, and describe the shape, size and style. Import an existing GLB to continue working.",
                )}
              </p>
              {narrow && (
                <Button onClick={() => setDrawer(true)}>{tr("Open modeling tools")}</Button>
              )}
            </div>
          )}
          {version && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-3 py-2 text-ui-xs text-muted-foreground">
              <span>{version.report.dimensions.map((n) => n.toFixed(3)).join(" × ")} m</span>
              <span>
                {version.report.vertices.toLocaleString()} {tr("vertices")}
              </span>
              <span>
                {version.report.materials.length} {tr("materials")}
              </span>
              {object && (
                <span className="truncate">
                  {version.report.objects.find((p) => p.id === object)?.name}
                </span>
              )}
            </div>
          )}
        </main>
        {!narrow && (
          <aside
            className="flex w-[25rem] max-w-[45%] shrink-0 flex-col border-s border-border"
            aria-label={tr("Model tools")}
          >
            {tools}
          </aside>
        )}
      </div>
      <footer
        className="max-h-36 shrink-0 overflow-auto border-t border-border px-3 py-2 text-ui-xs"
        aria-live="polite"
      >
        {activeJob ? (
          <div className="flex items-center gap-2">
            <span className="flex-1">
              {tr(activeJob.status === "validating" ? "Validating GLB…" : "Building model…")} ·{" "}
              {activeJob.build.mode === "blender" ? "Blender MCP" : "Three.js"}
            </span>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void act({ operation: "cancel", jobId: activeJob.id })}
            >
              {tr("Cancel task")}
            </Button>
          </div>
        ) : lastJob?.error ? (
          <div role="alert" className="flex flex-wrap items-start gap-2">
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-destructive">
              {tr(lastJob.status)}: {lastJob.error}
            </span>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setSource({ name: tr("Retained task source"), build: lastJob.build })}
            >
              {tr("View source")}
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={!desktop || busy || project.archived}
              onClick={() => void submit(lastJob.build)}
            >
              {tr("Retry build")}
            </Button>
          </div>
        ) : (
          <span className="text-muted-foreground">
            {tr(
              version
                ? "Preview and export use the same validated GLB. Adopt a candidate when ready."
                : "Models are saved locally. No model has been generated yet.",
            )}
          </span>
        )}
      </footer>
      {narrow && (
        <Sheet open={drawer} onOpenChange={setDrawer}>
          <SheetPopup className="flex w-[min(100vw,30rem)] flex-col">
            <SheetTitle>{tr("3D Workshop tools")}</SheetTitle>
            {tools}
          </SheetPopup>
        </Sheet>
      )}
      <Dialog
        open={!!source}
        onOpenChange={(open) => {
          if (!open) setSource(null);
        }}
      >
        <DialogPopup className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>
              {tr("Model source")} · {source?.name}
            </DialogTitle>
            <DialogDescription>
              {tr(
                "Source is retained with each version. Viewing or copying it does not execute it.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void navigator.clipboard.writeText(source?.build.source ?? "").catch(onError)
              }
            >
              {tr("Copy source")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                if (!source) return;
                const blob = new Blob([source.build.source], { type: "text/plain" }),
                  url = URL.createObjectURL(blob),
                  a = document.createElement("a");
                a.href = url;
                a.download = source.build.mode === "blender" ? "model.py" : "model.js";
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            >
              {tr("Save source")}
            </Button>
          </div>
          <pre
            tabIndex={0}
            className="mt-3 max-h-[60vh] overflow-auto rounded-md bg-muted/40 p-3 font-mono text-ui-xs"
          >
            {source?.build.source || tr("Imported model: no modeling source.")}
          </pre>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function resolveProceduralBuild(project: Model3DProject, version: Model3DVersion): Model3DBuild {
  const trail: Model3DVersion[] = [];
  let current: Model3DVersion | undefined = version;
  while (current && trail.length < project.versions.length + 1) {
    trail.unshift(current);
    if (current.build.source || current.build.mode !== "threejs") break;
    current = project.versions.find((v) => v.id === current!.build.parentVersionId);
  }
  const base = trail[0]?.build ?? version.build;
  const edits = new Map<string, Model3DMaterialEdit>();
  for (const entry of trail)
    for (const edit of entry.build.materialEdits)
      edits.set(edit.materialId, { ...edits.get(edit.materialId), ...edit });
  return {
    ...base,
    parameters: version.build.parameters,
    parameterDefinitions: version.build.parameterDefinitions,
    materialEdits: [...edits.values()],
    parentVersionId: version.id,
  };
}

function ModelProperties({
  project,
  version,
  disabled,
  onSubmit,
  onTexture,
  onUpdate,
  onSource,
}: {
  project: Model3DProject;
  version: Model3DVersion | undefined;
  disabled: boolean;
  onSubmit: (build: Model3DBuild) => unknown;
  onTexture: () => void;
  onUpdate: (input: { name?: string; triangleBudget?: number; textureBudget?: number }) => void;
  onSource: () => void;
}) {
  const tr = useAhaTranslation();
  const [params, setParams] = useState({ ...version?.build.parameters }),
    [materialId, setMaterialId] = useState(version?.report.materials[0]?.id ?? ""),
    [edit, setEdit] = useState<Model3DMaterialEdit | null>(null);
  const material = version?.report.materials.find((m) => m.id === materialId);
  const updateEdit = (patch: Partial<Model3DMaterialEdit>) =>
    setEdit((value) => ({ materialId, ...value, ...patch }));
  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-auto p-4 text-ui-sm">
      <section className="space-y-3">
        <h2 className="font-medium">{tr("Project settings")}</h2>
        <label className="block space-y-1">
          <span>{tr("Project name")}</span>
          <Input
            defaultValue={project.name}
            key={project.name}
            maxLength={200}
            onBlur={(event) => {
              if (event.target.value !== project.name) onUpdate({ name: event.target.value });
            }}
          />
        </label>
        <label className="block space-y-1">
          <span>{tr("Triangle budget")}</span>
          <Input
            type="number"
            min={1}
            max={1000000}
            defaultValue={project.triangleBudget}
            key={project.triangleBudget}
            onBlur={(event) => {
              if (Number(event.target.value) !== project.triangleBudget)
                onUpdate({ triangleBudget: Number(event.target.value) });
            }}
          />
        </label>
        <OptionSelect
          label={tr("Texture budget")}
          value={String(project.textureBudget)}
          onValueChange={(value) => onUpdate({ textureBudget: Number(value) })}
        >
          {[256, 512, 1024, 2048, 4096].map((value) => (
            <option key={value} value={String(value)}>
              {value} px
            </option>
          ))}
        </OptionSelect>
        <p className="text-ui-xs text-muted-foreground">
          {tr(
            "Meters · Y up · bottom-center pivot. Budgets produce warnings; capacity limits remain fixed.",
          )}
        </p>
      </section>
      {version && (
        <>
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-medium">{tr("Parameters")}</h2>
              <Button size="xs" variant="ghost" onClick={onSource}>
                {tr("View source")}
              </Button>
            </div>
            {!version.build.parameterDefinitions.length && (
              <p className="text-ui-xs text-muted-foreground">
                {tr(
                  "This version has no editable parameters. Ask AI to add them or modify the model.",
                )}
              </p>
            )}
            {version.build.parameterDefinitions.map((parameter) => (
              <label key={parameter.key} className="block space-y-1">
                <span>{parameter.label}</span>
                {parameter.type === "boolean" ? (
                  <Checkbox
                    checked={params[parameter.key] === true}
                    onCheckedChange={(value) =>
                      setParams({ ...params, [parameter.key]: value === true })
                    }
                  />
                ) : (
                  <Input
                    type={
                      parameter.type === "number"
                        ? "number"
                        : parameter.type === "color"
                          ? "color"
                          : "text"
                    }
                    min={parameter.min}
                    max={parameter.max}
                    step={parameter.step ?? "any"}
                    value={String(params[parameter.key] ?? "")}
                    onChange={(event) =>
                      setParams({
                        ...params,
                        [parameter.key]:
                          parameter.type === "number"
                            ? Number(event.target.value)
                            : event.target.value,
                      })
                    }
                  />
                )}
              </label>
            ))}
            {!!version.build.parameterDefinitions.length && (
              <Button
                size="sm"
                disabled={disabled || version.build.mode !== "threejs"}
                onClick={() =>
                  void onSubmit({
                    ...resolveProceduralBuild(project, version),
                    parameters: params,
                    prompt: "Parameter adjustment",
                  })
                }
              >
                {tr("Build parameter candidate")}
              </Button>
            )}
          </section>
          <section className="space-y-3">
            <h2 className="font-medium">{tr("PBR materials")}</h2>
            <OptionSelect
              label={tr("Selected material")}
              value={materialId}
              onValueChange={(value) => {
                setMaterialId(value);
                setEdit(null);
              }}
            >
              {version.report.materials.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </OptionSelect>
            {material && (
              <>
                <label className="block space-y-1">
                  <span>{tr("Base color")}</span>
                  <Input
                    type="color"
                    value={edit?.color ?? material.color}
                    onChange={(event) => updateEdit({ color: event.target.value })}
                  />
                </label>
                {(["roughness", "metalness", "opacity"] as const).map((key) => (
                  <label key={key} className="block space-y-1">
                    <span>
                      {tr(
                        key === "roughness"
                          ? "Roughness"
                          : key === "metalness"
                            ? "Metalness"
                            : "Opacity",
                      )}
                    </span>
                    <Input
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={edit?.[key] ?? Number(material[key].toFixed(4))}
                      onChange={(event) => updateEdit({ [key]: Number(event.target.value) })}
                    />
                  </label>
                ))}
                {(["baseColor", "normal", "roughnessMap", "metalnessMap"] as const).map((key) => (
                  <div key={key} className="space-y-1">
                    <span>
                      {tr(
                        key === "baseColor"
                          ? "Base Color texture"
                          : key === "normal"
                            ? "Normal texture"
                            : key === "roughnessMap"
                              ? "Roughness texture"
                              : "Metalness texture",
                      )}
                    </span>
                    <OptionSelect
                      label={tr(key + " texture binding")}
                      value={edit?.[key] === null ? "__none__" : (edit?.[key] ?? "__keep__")}
                      onValueChange={(value) => {
                        if (value === "__keep__") {
                          setEdit((old) => {
                            if (!old) return null;
                            const next = { ...old };
                            delete next[key];
                            return next;
                          });
                        } else updateEdit({ [key]: value === "__none__" ? null : value });
                      }}
                    >
                      <option value="__keep__">{tr("Keep current binding")}</option>
                      <option value="__none__">{tr("No texture")}</option>
                      {project.textures.map((texture) => (
                        <option key={texture.id} value={texture.id}>
                          {texture.name} · {texture.width}×{texture.height}
                        </option>
                      ))}
                    </OptionSelect>
                  </div>
                ))}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={disabled || !edit}
                    onClick={() => {
                      if (edit)
                        void onSubmit({
                          ...version.build,
                          source: "",
                          parentVersionId: version.id,
                          prompt: "PBR material adjustment",
                          materialEdits: [edit],
                        });
                    }}
                  >
                    {tr("Build material candidate")}
                  </Button>
                  <Button size="sm" variant="outline" disabled={disabled} onClick={onTexture}>
                    {tr("Import texture")}
                  </Button>
                </div>
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function ExportPanel({
  project,
  version,
  disabled,
  path,
  onExport,
  onAdopt,
}: {
  project: Model3DProject;
  version: Model3DVersion | undefined;
  disabled: boolean;
  path: string | null;
  onExport: (input: {
    versionId: string;
    target: "generic" | "godot";
    includeSource: boolean;
  }) => void;
  onAdopt: () => void;
}) {
  const tr = useAhaTranslation(),
    [target, setTarget] = useState<"generic" | "godot">("generic"),
    [includeSource, setIncludeSource] = useState(true),
    [acceptBudget, setAcceptBudget] = useState(false);
  const adopted = project.versions.find((v) => v.id === project.adoptedVersionId),
    overBudget =
      !!adopted &&
      (adopted.report.triangles > project.triangleBudget ||
        adopted.report.textures.some((t) => Math.max(t.width, t.height) > project.textureBudget));
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4 text-ui-sm">
      <h2 className="font-medium">{tr("Asset export")}</h2>
      {adopted ? (
        <>
          <p>
            {tr("Export version")}: <strong>{adopted.name}</strong> · {tr("Adopted")}
          </p>
          {version?.id !== adopted.id && (
            <p className="text-ui-xs text-muted-foreground">
              {tr("You are previewing another version. Export still uses the adopted version.")}
            </p>
          )}
          <ValidationReport version={adopted} />
          <OptionSelect
            label={tr("Export preset")}
            value={target}
            onValueChange={(value) => setTarget(value === "godot" ? "godot" : "generic")}
          >
            <option value="generic">{tr("Generic GLB")}</option>
            <option value="godot">Godot · GLB</option>
          </OptionSelect>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={includeSource}
              onCheckedChange={(value) => setIncludeSource(value === true)}
            />
            {tr("Include modeling source / .blend")}
          </label>
          {overBudget && (
            <label className="flex items-start gap-2 text-ui-xs">
              <Checkbox
                checked={acceptBudget}
                onCheckedChange={(value) => setAcceptBudget(value === true)}
              />
              {tr("This model exceeds the suggested budget. Export this version anyway.")}
            </label>
          )}
          <Button
            disabled={disabled || adopted.report.errors.length > 0 || (overBudget && !acceptBudget)}
            onClick={() => onExport({ versionId: adopted.id, target, includeSource })}
          >
            {tr("Export asset package")}
          </Button>
          <Button
            variant="outline"
            disabled={disabled || !window.desktopBridge?.resourceLibrary}
            onClick={() =>
              collectResources([
                {
                  name: project.name + ".glb",
                  assetId: adopted.hash,
                  url: modelAssetUrl(project.id, adopted.id),
                  origin: { kind: "model3d", projectId: project.id, versionId: adopted.id },
                },
              ])
            }
          >
            {tr("Save to resource center")}
          </Button>
          {path && (
            <p role="status" className="break-all text-ui-xs">
              {tr("Export saved")}: {path}
            </p>
          )}
          <p className="text-ui-xs text-muted-foreground">
            {tr(
              "Includes model.glb, thumbnail, asset manifest and validation report. LOD and collision are not provided. Godot imports GLB directly.",
            )}
          </p>
        </>
      ) : (
        <>
          <p className="text-muted-foreground">
            {tr("Adopt a validated candidate before exporting.")}
          </p>
          {version && (
            <Button onClick={onAdopt} disabled={disabled}>
              {tr("Adopt this version")}
            </Button>
          )}
        </>
      )}
      {version && version.id !== adopted?.id && (
        <>
          <h3 className="font-medium">{tr("Preview validation")}</h3>
          <ValidationReport version={version} />
        </>
      )}
    </div>
  );
}
function ValidationReport({ version }: { version: Model3DVersion }) {
  const tr = useAhaTranslation(),
    r = version.report;
  return (
    <section className="space-y-2 text-ui-xs" aria-label={tr("Model validation report")}>
      <p>
        {tr("glTF Validator")}: {r.validatorErrors === 0 ? tr("Passed") : r.validatorErrors}
      </p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
        <dt>{tr("Triangles")}</dt>
        <dd>{r.triangles.toLocaleString()}</dd>
        <dt>{tr("Vertices")}</dt>
        <dd>{r.vertices.toLocaleString()}</dd>
        <dt>{tr("Dimensions")}</dt>
        <dd>{r.dimensions.map((n) => n.toFixed(3)).join(" × ")} m</dd>
        <dt>{tr("Materials")}</dt>
        <dd>{r.materials.length}</dd>
        <dt>{tr("File size")}</dt>
        <dd>{mb(r.bytes)}</dd>
      </dl>
      {r.textures.map((t, i) => (
        <p key={i}>
          {t.name}: {t.width} × {t.height}
        </p>
      ))}
      {r.warnings.map((warning, i) => (
        <p key={i} className="text-muted-foreground">
          {tr("Warning")}: {warning}
        </p>
      ))}
      {r.errors.map((error, i) => (
        <p key={i} className="text-destructive">
          {error}
        </p>
      ))}
    </section>
  );
}
