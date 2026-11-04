import { lazy, Suspense, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { Gen3DCommand, Gen3DProject, Gen3DVersion, ImageJob } from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { useAppSettings } from "~/appSettings";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { ArrowLeftIcon, Gen3DIcon, PlusIcon } from "~/lib/icons";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Sheet, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { confirmDialog } from "../ui/confirm-dialog";
import { RouteSurfaceHeader } from "../RouteSurface";
import { collectResources } from "../resources/resourceLibrary";
import { DrawingModelPicker } from "../drawing/DrawingPickers";
import { drawingApi, useImageProviders } from "../drawing/useDrawing";
import { ensureGen3DThread } from "./Gen3DChat";
import {
  gen3dApi,
  gen3dAssetUrl,
  gen3dKey,
  useGen3D,
  useGen3DCommand,
  useGen3DEvents,
} from "./useGen3D";

const Gen3DChat = lazy(() =>
  import("./Gen3DChat").then((module) => ({ default: module.Gen3DChat })),
);
const ModelViewer = lazy(() => import("../model3d/ModelViewer"));
const running = (status: string) => ["queued", "running", "validating"].includes(status);
const VIEWS = ["front", "side", "back"] as const;
const VIEW_LABELS = { front: "Front", side: "Side", back: "Back" } as const;
const STOP_REASONS: Record<string, string> = {
  "deviation-below-threshold": "Generation finished: the largest deviation is below the threshold.",
  "no-improvement": "Generation finished: the score stopped improving.",
  "rounds-used": "Generation finished: all authorized rounds were used.",
  user: "Generation stopped.",
  replaced: "Generation was replaced by a new authorization.",
  restart: "Generation was interrupted by a restart. Start it again when ready.",
  "conversation-removed": "Generation stopped because the conversation was removed.",
};
const sheetPrompt = (subject: string) =>
  `Orthographic turnaround reference sheet of a single 3D game asset for modeling. Exactly three views side by side from left to right: FRONT view, RIGHT SIDE view, BACK view. Same object, identical scale and height in all three views, all standing on one shared horizontal ground line, evenly spaced with clear gaps between views. True orthographic projection, no perspective. Clean stylized game-art look, simple shapes, flat even lighting, solid colors, pure white background, no cast shadows, no text, no labels, no arrows, no grid, no frame. Subject: ${subject}`;

export default function Gen3DWorkbench({ projectId }: { projectId?: string }) {
  useGen3DEvents();
  const tr = useAhaTranslation(),
    navigate = useNavigate(),
    command = useGen3DCommand(),
    narrow = useMediaQuery("(max-width: 900px)");
  const [query, setQuery] = useState(""),
    [archived, setArchived] = useState(false),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const list = useQuery({ queryKey: [...gen3dKey, "list"], queryFn: () => gen3dApi().list() });
  const detail = useGen3D(projectId ?? null);
  const environment = useQuery({
    queryKey: [...gen3dKey, "environment"],
    queryFn: async () => (await gen3dApi().command({ operation: "environment" })).environment!,
  });
  const showError = (cause: unknown) =>
    setError(cause instanceof Error ? cause.message : String(cause));
  const select = (id?: string) => {
    setError(null);
    void navigate({ to: "/gen3d", search: id ? { projectId: id } : {} });
  };
  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await command({ operation: "create", name: tr("Untitled 3D asset") });
      if (result.project) select(result.project.id);
    } catch (cause) {
      showError(cause);
    } finally {
      setBusy(false);
    }
  };
  const visible =
    list.data?.filter(
      (p) => p.archived === archived && p.name.toLowerCase().includes(query.toLowerCase()),
    ) ?? [];
  return (
    <>
      {!projectId && (
        <RouteSurfaceHeader>
          <Gen3DIcon className="size-4" />
          <h1 className="text-ui font-medium">{tr("3D Generation")}</h1>
          <div className="no-drag ms-auto flex items-center gap-2">
            <Button size="sm" disabled={busy} onClick={() => void create()}>
              <PlusIcon />
              {tr("New 3D asset")}
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
            "Building 3D assets requires the Aha desktop app. Saved models remain available for preview.",
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
          />
        ) : (
          <div className="p-5 text-ui-sm" role="status">
            {tr(detail.error ? "3D project unavailable" : "Loading…")}
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
              aria-label={tr("Search 3D assets")}
              placeholder={tr("Search 3D assets")}
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
          {!list.isLoading && !visible.length && (
            <div className="mx-auto flex max-w-lg flex-col items-center gap-4 py-16 text-center">
              <Gen3DIcon className="size-10 text-muted-foreground" />
              <h2 className="text-ui-lg font-medium">
                {tr(archived ? "No archived assets" : "Generate your first 3D asset")}
              </h2>
              <p className="text-ui-sm text-muted-foreground">
                {tr(
                  "Start from a three-view reference. AI models the asset, compares every build with the blueprint and iterates until the silhouettes match.",
                )}
              </p>
              {!archived && (
                <Button disabled={busy} onClick={() => void create()}>
                  {tr("New 3D asset")}
                </Button>
              )}
            </div>
          )}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4">
            {visible.map((project) => (
              <button
                key={project.id}
                type="button"
                className="overflow-hidden rounded-lg border border-border text-start outline-none hover:bg-accent/40 focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => select(project.id)}
              >
                <div className="relative flex aspect-[4/3] items-center justify-center bg-muted/30">
                  {project.previewVersionId ? (
                    <img
                      className="h-full w-full object-contain"
                      alt=""
                      loading="lazy"
                      src={gen3dAssetUrl(
                        project.id,
                        "versions",
                        project.previewVersionId,
                        "thumbnail.png",
                      )}
                    />
                  ) : (
                    <Gen3DIcon className="size-10 text-muted-foreground" />
                  )}
                  {(project.running || project.error || project.stage === "adopted") && (
                    <Badge
                      className="absolute start-2 top-2"
                      variant={project.error ? "error" : project.running ? "info" : "success"}
                    >
                      {tr(
                        project.error ? "Unavailable" : project.running ? "Generating" : "Adopted",
                      )}
                    </Badge>
                  )}
                </div>
                <div className="space-y-1 p-3">
                  <p className="truncate text-ui font-medium">{project.name}</p>
                  <p className="truncate text-ui-xs text-muted-foreground">
                    {project.versions
                      ? [
                          project.score !== null ? `${project.score} ${tr("points")}` : null,
                          project.triangles !== null
                            ? `${project.triangles.toLocaleString()} ${tr("triangles")}`
                            : null,
                          `${project.versions} ${tr("versions")}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")
                      : tr(project.stage === "blueprint" ? "Reference ready" : "No reference yet")}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </div>
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
}: {
  project: Gen3DProject;
  narrow: boolean;
  desktop: boolean;
  onBack: () => void;
  onError: (e: unknown) => void;
}) {
  const tr = useAhaTranslation(),
    command = useGen3DCommand(),
    { settings } = useAppSettings();
  const [selected, setSelected] = useState<string | null>(project.previewVersionId),
    [tool, setTool] = useState<"generate" | "export">("generate"),
    [panel, setPanel] = useState<"properties" | "assistant">("properties"),
    [view, setView] = useState<"model" | "compare">("model"),
    [drawer, setDrawer] = useState(false),
    [sheetOpen, setSheetOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [exportPath, setExportPath] = useState<string | null>(null);
  const lastVersion = project.versions.at(-1)?.id ?? null;
  useEffect(
    () => setSelected(project.previewVersionId ?? lastVersion),
    [project.previewVersionId, lastVersion],
  );
  const version = project.versions.find((v) => v.id === selected) ?? project.versions.at(-1),
    activeJob = project.jobs.find((j) => running(j.status)),
    lastJob = project.jobs.at(-1),
    activeRun = project.runs.find((r) => r.status === "active"),
    lastRun = project.runs.at(-1);
  const act = async (input: Omit<Gen3DCommand, "projectId" | "revision">) => {
    setBusy(true);
    try {
      const latest = await gen3dApi().get({ id: project.id });
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
  const selectVersion = (id: string) => {
    setSelected(id);
    void act({ operation: "select-version", versionId: id });
  };
  const startRun = async (rounds: number) => {
    setBusy(true);
    try {
      const threadId = await ensureGen3DThread(
        project.id,
        command,
        settings,
        tr("Chat workspace is not ready. Try again after connecting."),
      );
      const latest = await gen3dApi().get({ id: project.id });
      await command({
        operation: "start-run",
        projectId: project.id,
        revision: latest.revision,
        maxRounds: rounds,
      });
      // The run only authorizes rounds; the user still sends the message that starts them.
      useComposerDraftStore
        .getState()
        .setPrompt(
          threadId,
          tr(
            "Model this asset against the confirmed blueprint. Iterate up to {rounds} rounds and fix the largest deviations first.",
          ).replace("{rounds}", String(rounds)),
        );
      setPanel("assistant");
      if (narrow) setDrawer(true);
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  };
  const locked = busy || !!activeJob || !!activeRun || project.archived;
  const tools = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="flex gap-1 border-b border-border p-2"
        role="tablist"
        aria-label={tr("Panels")}
      >
        {(["properties", "assistant"] as const).map((value) => (
          <Button
            key={value}
            size="sm"
            variant={panel === value ? "secondary" : "ghost"}
            role="tab"
            aria-selected={panel === value}
            onClick={() => setPanel(value)}
          >
            {tr(value === "assistant" ? "AI assistant" : "Properties")}
          </Button>
        ))}
      </div>
      <div className={panel === "assistant" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <Suspense fallback={<p className="p-4 text-ui-sm">{tr("Loading…")}</p>}>
          <Gen3DChat project={project} onError={onError} />
        </Suspense>
      </div>
      {panel === "properties" && tool === "generate" && (
        <GeneratePanel
          key={project.id}
          project={project}
          disabled={locked || !desktop}
          busy={busy}
          onUpdate={(input) => void act({ operation: "update", ...input })}
          onStart={(rounds) => void startRun(rounds)}
          onStop={() => activeRun && void act({ operation: "stop-run", runId: activeRun.id })}
        />
      )}
      {panel === "properties" && tool === "export" && (
        <ExportPanel
          project={project}
          version={version}
          disabled={busy || !desktop}
          path={exportPath}
          onExport={(versionId) => void act({ operation: "export", versionId })}
          onAdopt={() => version && void act({ operation: "adopt", versionId: version.id })}
        />
      )}
    </div>
  );
  const browser = (
    <ReferencePanel
      project={project}
      version={version}
      locked={locked}
      desktop={desktop}
      onAct={act}
      onGenerateSheet={() => setSheetOpen(true)}
      onSelectVersion={selectVersion}
    />
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
        {narrow && (
          <div className="no-drag flex items-center gap-1">
            <Button size="sm" onClick={() => setDrawer(true)}>
              {tr("Tools")}
            </Button>
          </div>
        )}
      </RouteSurfaceHeader>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div
          className="flex items-center gap-1"
          role="tablist"
          aria-label={tr("3D generation tools")}
        >
          {(["generate", "export"] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={tool === value ? "secondary" : "ghost"}
              role="tab"
              aria-selected={tool === value}
              onClick={() => {
                setTool(value);
                setPanel("properties");
              }}
            >
              {tr(value === "generate" ? "Generate" : "Export")}
            </Button>
          ))}
        </div>
        {version && (
          <Button
            className="ms-auto"
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
        {!narrow && (
          <aside
            className="flex w-64 shrink-0 flex-col border-e border-border"
            aria-label={tr("References and versions")}
          >
            {browser}
          </aside>
        )}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={tr("3D model preview")}>
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-ui-xs text-muted-foreground">
            <span className="min-w-0 truncate">
              {version
                ? [
                    version.name,
                    version.round !== null
                      ? tr("round {n}").replace("{n}", String(version.round))
                      : null,
                    tr(project.adoptedVersionId === version.id ? "Adopted" : "Candidate"),
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : tr("No model yet")}
            </span>
            {version?.score && (
              <span>
                {version.score.score} {tr("points")} · {tr("largest deviation")}{" "}
                {version.score.maxRegionPct}%
              </span>
            )}
            <div
              className="ms-auto flex items-center gap-1"
              role="group"
              aria-label={tr("Preview mode")}
            >
              {(["model", "compare"] as const).map((value) => (
                <Button
                  key={value}
                  size="xs"
                  variant={view === value ? "secondary" : "ghost"}
                  aria-pressed={view === value}
                  disabled={value === "compare" && !version?.score}
                  onClick={() => setView(value)}
                >
                  {tr(value === "model" ? "Model" : "Comparison")}
                </Button>
              ))}
            </div>
          </div>
          {version && view === "compare" && version.score ? (
            <CompareView project={project} version={version} />
          ) : version ? (
            <Suspense
              fallback={
                <div role="status" className="p-5 text-ui-sm">
                  {tr("Loading model…")}
                </div>
              }
            >
              <ModelViewer url={gen3dAssetUrl(project.id, "versions", version.id, "model.glb")} />
            </Suspense>
          ) : (
            <div className="flex min-h-40 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <Gen3DIcon className="size-12 text-muted-foreground" />
              <h2 className="text-ui-lg font-medium">
                {tr("Your next asset starts from a blueprint")}
              </h2>
              <p className="max-w-md text-ui-sm text-muted-foreground">
                {tr(
                  "Add or generate a three-view reference, confirm its blueprint and real height, then start generation. Each round is kept as a candidate.",
                )}
              </p>
              {narrow && <Button onClick={() => setDrawer(true)}>{tr("Open tools")}</Button>}
            </div>
          )}
          {version && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-3 py-2 text-ui-xs text-muted-foreground">
              <span>{version.report.dimensions.map((n) => n.toFixed(3)).join(" × ")} m</span>
              <span>
                {version.report.triangles.toLocaleString()} {tr("triangles")}
              </span>
              {version.topology.nonManifoldEdges > 0 && (
                <span className="text-warning">
                  {version.topology.nonManifoldEdges} {tr("non-manifold edges")}
                </span>
              )}
            </div>
          )}
        </main>
        {!narrow && (
          <aside
            className="flex w-[25rem] max-w-[45%] shrink-0 flex-col border-s border-border"
            aria-label={tr("Tools")}
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
              {tr(activeJob.status === "validating" ? "Checking and scoring…" : "Building model…")}
              {activeRun
                ? ` · ${tr("round {n} of {total}").replace("{n}", String(activeRun.usedRounds)).replace("{total}", String(activeRun.maxRounds))}`
                : ""}
            </span>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void act({ operation: "cancel", jobId: activeJob.id })}
            >
              {tr("Cancel task")}
            </Button>
          </div>
        ) : activeRun ? (
          <div className="flex items-center gap-2">
            <span className="flex-1">
              {tr("Generation authorized · {n} of {total} rounds used. Waiting for the assistant.")
                .replace("{n}", String(activeRun.usedRounds))
                .replace("{total}", String(activeRun.maxRounds))}
            </span>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void act({ operation: "stop-run", runId: activeRun.id })}
            >
              {tr("Stop")}
            </Button>
          </div>
        ) : lastJob?.error ? (
          <div role="alert" className="flex flex-wrap items-start gap-2">
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-destructive">
              {tr(lastJob.status)}: {lastJob.error}
            </span>
            <Button
              size="xs"
              variant="outline"
              disabled={!desktop || busy || project.archived}
              onClick={() =>
                void act({
                  operation: "submit",
                  build: lastJob.build,
                  requestId: crypto.randomUUID(),
                })
              }
            >
              {tr("Retry build")}
            </Button>
          </div>
        ) : (
          <span className="text-muted-foreground">
            {lastRun?.stopReason && lastRun.status !== "active"
              ? tr(STOP_REASONS[lastRun.stopReason] ?? "Generation stopped.")
              : tr(
                  version
                    ? "New results are kept as candidates. Adopt one when ready."
                    : "Models are saved locally.",
                )}
          </span>
        )}
      </footer>
      {narrow && (
        <Sheet open={drawer} onOpenChange={setDrawer}>
          <SheetPopup className="flex w-[min(100vw,30rem)] flex-col">
            <SheetHeader className="flex-row items-center justify-between border-b border-border p-3">
              <SheetTitle className="text-ui-lg">{tr("3D generation tools")}</SheetTitle>
            </SheetHeader>
            <div className="max-h-[45%] overflow-auto border-b border-border">{browser}</div>
            {tools}
          </SheetPopup>
        </Sheet>
      )}
      {sheetOpen && (
        <SheetDialog
          project={project}
          onClose={() => setSheetOpen(false)}
          onImported={() => setSheetOpen(false)}
          onError={onError}
        />
      )}
    </>
  );
}

function ReferencePanel({
  project,
  version,
  locked,
  desktop,
  onAct,
  onGenerateSheet,
  onSelectVersion,
}: {
  project: Gen3DProject;
  version: Gen3DVersion | undefined;
  locked: boolean;
  desktop: boolean;
  onAct: (input: Omit<Gen3DCommand, "projectId" | "revision">) => Promise<unknown>;
  onGenerateSheet: () => void;
  onSelectVersion: (id: string) => void;
}) {
  const tr = useAhaTranslation();
  const blueprint = project.blueprint;
  const [reference, setReference] = useState<string | null>(
    blueprint?.referenceId ?? project.references.at(-1)?.id ?? null,
  );
  const [height, setHeight] = useState(blueprint ? String(blueprint.targetHeight) : "");
  useEffect(() => {
    if (!reference && project.references.length) setReference(project.references.at(-1)!.id);
  }, [reference, project.references]);
  const heightValue = Number(height);
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <section
        className="space-y-3 border-b border-border p-3"
        aria-label={tr("Reference and blueprint")}
      >
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-ui-sm font-medium">{tr("Reference and blueprint")}</h2>
        </div>
        {project.references.length > 0 ? (
          <div
            className="grid grid-cols-3 gap-1.5"
            role="listbox"
            aria-label={tr("Reference images")}
          >
            {project.references.map((r) => (
              <button
                key={r.id}
                type="button"
                role="option"
                aria-selected={reference === r.id}
                title={r.name}
                className={
                  "aspect-[3/2] overflow-hidden rounded-md border bg-muted/30 outline-none focus-visible:ring-1 focus-visible:ring-ring " +
                  (reference === r.id ? "border-info" : "border-border")
                }
                onClick={() => setReference(r.id)}
              >
                <img
                  className="h-full w-full object-contain"
                  alt={r.name}
                  src={gen3dAssetUrl(project.id, "references", r.id)}
                />
              </button>
            ))}
          </div>
        ) : (
          <p className="text-ui-xs text-muted-foreground">
            {tr(
              "Use one image with front, side and back views side by side on a plain background.",
            )}
          </p>
        )}
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="xs"
            variant="outline"
            disabled={locked || !desktop}
            onClick={() => void onAct({ operation: "add-reference" })}
          >
            {tr("Upload reference")}
          </Button>
          <Button size="xs" variant="outline" disabled={locked} onClick={onGenerateSheet}>
            {tr("Generate three views")}
          </Button>
        </div>
        {reference && (
          <div className="flex items-end gap-2">
            <label className="min-w-0 flex-1 space-y-1">
              <span className="block text-ui-xs text-muted-foreground">
                {tr("Real height (m)")}
              </span>
              <Input
                inputMode="decimal"
                value={height}
                placeholder="0.6"
                aria-label={tr("Real height (m)")}
                onChange={(event) => setHeight(event.target.value)}
              />
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={locked || !(heightValue > 0)}
              onClick={() =>
                void onAct({
                  operation: "extract-blueprint",
                  referenceId: reference,
                  targetHeight: heightValue,
                })
              }
            >
              {tr(blueprint ? "Re-extract" : "Extract blueprint")}
            </Button>
          </div>
        )}
        {blueprint && (
          <div className="space-y-2">
            <div className="grid grid-cols-3 gap-1.5">
              {VIEWS.map((v) => (
                <figure key={v} className="m-0 space-y-1">
                  <img
                    className="aspect-square w-full rounded-md bg-muted/30"
                    alt={tr("{view} blueprint").replace("{view}", tr(VIEW_LABELS[v]))}
                    src={gen3dAssetUrl(project.id, "blueprint", v, undefined, blueprint.createdAt)}
                  />
                  <figcaption className="text-center text-ui-xs text-muted-foreground">
                    {tr(VIEW_LABELS[v])}
                  </figcaption>
                </figure>
              ))}
            </div>
            <div className="flex items-center gap-2 text-ui-xs">
              <span className="flex-1 text-muted-foreground">
                {blueprint.targetHeight} m ·{" "}
                {tr(
                  blueprint.confirmed
                    ? "Confirmed"
                    : "Check the three silhouettes before confirming",
                )}
              </span>
              {!blueprint.confirmed && (
                <Button
                  size="xs"
                  disabled={locked}
                  onClick={() => void onAct({ operation: "confirm-blueprint" })}
                >
                  {tr("Confirm")}
                </Button>
              )}
            </div>
          </div>
        )}
      </section>
      <section className="space-y-1 p-2" aria-label={tr("Versions")}>
        <h2 className="px-1 pb-1 text-ui-sm font-medium">{tr("Versions")}</h2>
        {project.versions.toReversed().map((v) => (
          <Button
            key={v.id}
            className="h-auto w-full flex-col items-start gap-1 whitespace-normal py-2 text-start"
            size="sm"
            variant={version?.id === v.id ? "secondary" : "ghost"}
            aria-pressed={version?.id === v.id}
            onClick={() => onSelectVersion(v.id)}
          >
            <span className="flex w-full items-center gap-2">
              <span className="flex-1">
                {v.name}
                {v.round !== null ? " · " + tr("round {n}").replace("{n}", String(v.round)) : ""}
              </span>
              {v.score && <span className="text-ui-xs tabular-nums">{v.score.score}</span>}
            </span>
            <span className="text-ui-xs text-muted-foreground">
              {tr(project.adoptedVersionId === v.id ? "Adopted" : "Candidate")} ·{" "}
              {v.report.triangles.toLocaleString()}
              {v.score ? ` · ${tr("largest deviation")} ${v.score.maxRegionPct}%` : ""}
            </span>
          </Button>
        ))}
        {!project.versions.length && (
          <p className="p-1 text-ui-xs text-muted-foreground">{tr("No versions yet.")}</p>
        )}
        <Button
          size="xs"
          variant="ghost"
          disabled={locked && !project.archived}
          onClick={() =>
            void (async () => {
              if (
                await confirmDialog({
                  title: tr(project.archived ? "Restore project?" : "Archive project?"),
                  description: tr("Models, references and versions will be retained."),
                  confirmLabel: tr(project.archived ? "Restore" : "Archive"),
                })
              )
                await onAct({ operation: "archive", archived: !project.archived });
            })()
          }
        >
          {tr(project.archived ? "Restore project" : "Archive project")}
        </Button>
      </section>
    </div>
  );
}

function CompareView({ project, version }: { project: Gen3DProject; version: Gen3DVersion }) {
  const tr = useAhaTranslation();
  const score = version.score!;
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
      <div className="flex flex-wrap items-center gap-4 text-ui-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-[#fb923c]" aria-hidden="true" />
          {tr("Model extra")}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-[#60a5fa]" aria-hidden="true" />
          {tr("Model missing")}
        </span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
        {VIEWS.map((v) => (
          <figure key={v} className="m-0 space-y-2 rounded-lg bg-muted/30 p-2">
            <img
              className="aspect-square w-full"
              alt={tr("{view} comparison").replace("{view}", tr(VIEW_LABELS[v]))}
              src={gen3dAssetUrl(project.id, "versions", version.id, `diff-${v}.png`)}
            />
            <figcaption className="flex items-center gap-2 text-ui-xs">
              <span className="flex-1 font-medium">{tr(VIEW_LABELS[v])}</span>
              <span className="tabular-nums text-muted-foreground">
                IoU {score.views[v].iou.toFixed(3)}
                {score.views[v].mirrored ? " · " + tr("mirrored") : ""}
              </span>
            </figcaption>
          </figure>
        ))}
      </div>
      <section className="space-y-1.5" aria-label={tr("Largest deviations")}>
        <h3 className="text-ui-sm font-medium">{tr("Largest deviations")}</h3>
        {score.regions.length ? (
          <ul className="space-y-1">
            {score.regions.map((r, i) => (
              <li
                key={i}
                className="flex items-center gap-2 rounded-md bg-muted/30 px-2 py-1.5 text-ui-xs"
              >
                <span
                  className={
                    "size-2.5 rounded-sm " + (r.kind === "extra" ? "bg-[#fb923c]" : "bg-[#60a5fa]")
                  }
                  aria-hidden="true"
                />
                <span className="flex-1">
                  {tr(VIEW_LABELS[r.view])} · {tr(r.where)} ·{" "}
                  {tr(r.kind === "extra" ? "extra" : "missing")}
                </span>
                <span className="tabular-nums">{r.pct}%</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ui-xs text-muted-foreground">{tr("No deviating regions.")}</p>
        )}
        <p className="text-ui-xs text-muted-foreground">
          {tr(
            "The score only covers silhouettes and proportions. Check style and detail in the model view.",
          )}
        </p>
      </section>
    </div>
  );
}

function GeneratePanel({
  project,
  disabled,
  busy,
  onUpdate,
  onStart,
  onStop,
}: {
  project: Gen3DProject;
  disabled: boolean;
  busy: boolean;
  onUpdate: (input: { description?: string; triangleBudget?: number }) => void;
  onStart: (rounds: number) => void;
  onStop: () => void;
}) {
  const tr = useAhaTranslation();
  const [description, setDescription] = useState(project.description),
    [budget, setBudget] = useState(String(project.triangleBudget)),
    [rounds, setRounds] = useState("4");
  const activeRun = project.runs.find((r) => r.status === "active");
  const roundsValue = Number(rounds);
  return (
    <div className="min-h-0 flex-1 space-y-5 overflow-auto p-4 text-ui-sm">
      <label className="block space-y-1.5">
        <span className="text-ui-xs text-muted-foreground">{tr("Asset description")}</span>
        <Textarea
          rows={3}
          value={description}
          placeholder={tr("Shape, style, materials and the game it is for.")}
          onChange={(event) => setDescription(event.target.value)}
          onBlur={() => description !== project.description && onUpdate({ description })}
        />
      </label>
      <label className="block space-y-1.5">
        <span className="text-ui-xs text-muted-foreground">{tr("Triangle budget")}</span>
        <Input
          inputMode="numeric"
          value={budget}
          onChange={(event) => setBudget(event.target.value)}
          onBlur={() => {
            const value = Number(budget);
            if (Number.isSafeInteger(value) && value !== project.triangleBudget)
              onUpdate({ triangleBudget: value });
          }}
        />
      </label>
      <section className="space-y-3" aria-label={tr("Automatic iteration")}>
        <h3 className="font-medium">{tr("Automatic iteration")}</h3>
        {activeRun ? (
          <>
            <p>
              {tr("{n} of {total} rounds used.")
                .replace("{n}", String(activeRun.usedRounds))
                .replace("{total}", String(activeRun.maxRounds))}
            </p>
            <Button variant="outline" disabled={busy} onClick={onStop}>
              {tr("Stop generation")}
            </Button>
          </>
        ) : (
          <>
            <label className="block space-y-1.5">
              <span className="text-ui-xs text-muted-foreground">{tr("Maximum rounds")}</span>
              <Input
                inputMode="numeric"
                value={rounds}
                onChange={(event) => setRounds(event.target.value)}
              />
            </label>
            <Button
              className="w-full"
              disabled={
                disabled ||
                !project.blueprint?.confirmed ||
                !(Number.isSafeInteger(roundsValue) && roundsValue >= 1 && roundsValue <= 10)
              }
              onClick={() => onStart(roundsValue)}
            >
              {tr("Start generation")}
            </Button>
            {!project.blueprint?.confirmed && (
              <p className="text-ui-xs text-muted-foreground">{tr("Confirm a blueprint first.")}</p>
            )}
          </>
        )}
        <p className="rounded-md bg-muted/40 p-3 text-ui-xs leading-relaxed text-muted-foreground">
          {tr(
            "Starting authorizes the assistant to build up to this many rounds on its own, using only conversation model turns. It stops when the largest deviation is below 2% or the score stops improving, and never resumes after a restart. Send the prepared message in the AI assistant to begin.",
          )}
        </p>
      </section>
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
  project: Gen3DProject;
  version: Gen3DVersion | undefined;
  disabled: boolean;
  path: string | null;
  onExport: (versionId: string) => void;
  onAdopt: () => void;
}) {
  const tr = useAhaTranslation(),
    [acceptBudget, setAcceptBudget] = useState(false);
  const adopted = project.versions.find((v) => v.id === project.adoptedVersionId),
    overBudget = !!adopted && adopted.report.triangles > project.triangleBudget;
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
          <VersionReport version={adopted} />
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
            disabled={disabled || (overBudget && !acceptBudget)}
            onClick={() => onExport(adopted.id)}
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
                  url: gen3dAssetUrl(project.id, "versions", adopted.id, "model.glb"),
                  origin: { kind: "gen3d", projectId: project.id, versionId: adopted.id },
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
              "Includes model.glb, thumbnail, 3/4 render, source, asset manifest and validation report with the blueprint score. UV, LOD and collision are not provided yet.",
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
          <VersionReport version={version} />
        </>
      )}
    </div>
  );
}

function VersionReport({ version }: { version: Gen3DVersion }) {
  const tr = useAhaTranslation();
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ui-xs">
      <dt className="text-muted-foreground">{tr("Triangles")}</dt>
      <dd>{version.report.triangles.toLocaleString()}</dd>
      <dt className="text-muted-foreground">{tr("Size")}</dt>
      <dd>{version.report.dimensions.map((n) => n.toFixed(3)).join(" × ")} m</dd>
      <dt className="text-muted-foreground">{tr("Open / non-manifold edges")}</dt>
      <dd>
        {version.topology.boundaryEdges} / {version.topology.nonManifoldEdges}
      </dd>
      {version.score && (
        <>
          <dt className="text-muted-foreground">{tr("Blueprint score")}</dt>
          <dd>
            {version.score.score} · {tr("largest deviation")} {version.score.maxRegionPct}%
          </dd>
        </>
      )}
      <dt className="text-muted-foreground">glTF Validator</dt>
      <dd>
        {version.report.validatorErrors} {tr("errors")}
      </dd>
      {version.report.warnings.length > 0 && (
        <>
          <dt className="text-muted-foreground">{tr("Warnings")}</dt>
          <dd className="space-y-0.5">
            {version.report.warnings.slice(0, 6).map((w, i) => (
              <span key={i} className="block break-words">
                {w}
              </span>
            ))}
          </dd>
        </>
      )}
    </dl>
  );
}

/** Generates a three-view sheet through the user's drawing channel, then imports it as a reference. */
function SheetDialog({
  project,
  onClose,
  onImported,
  onError,
}: {
  project: Gen3DProject;
  onClose: () => void;
  onImported: () => void;
  onError: (e: unknown) => void;
}) {
  const tr = useAhaTranslation(),
    navigate = useNavigate(),
    command = useGen3DCommand(),
    providers = useImageProviders();
  const enabled = providers.data?.filter((p) => p.enabled && p.models.length) ?? [];
  const [subject, setSubject] = useState(project.description || project.name),
    [choice, setChoice] = useState<{ providerId: string; model: string } | null>(null),
    [job, setJob] = useState<ImageJob | null>(null),
    [failure, setFailure] = useState<string | null>(null);
  const current =
    choice ?? (enabled[0] ? { providerId: enabled[0].id, model: enabled[0].models[0]!.id } : null);
  useEffect(() => {
    if (!job || ["succeeded", "partial", "failed", "cancelled"].includes(job.status)) return;
    const timer = setInterval(() => {
      void drawingApi()
        .getJob({ id: job.id })
        .then(setJob)
        .catch((error: unknown) =>
          setFailure(error instanceof Error ? error.message : String(error)),
        );
    }, 2000);
    return () => clearInterval(timer);
  }, [job]);
  useEffect(() => {
    if (!job) return;
    if (["failed", "cancelled"].includes(job.status))
      setFailure(
        (typeof job.error === "string" ? job.error : job.error?.message) ??
          tr("Image generation failed."),
      );
    const asset = job.outputs[0];
    if (!asset || !["succeeded", "partial"].includes(job.status)) return;
    void (async () => {
      try {
        const latest = await gen3dApi().get({ id: project.id });
        await command({
          operation: "import-reference-asset",
          projectId: project.id,
          revision: latest.revision,
          imageAssetId: asset.id,
          imageJobId: job.id,
        });
        onImported();
      } catch (error) {
        onError(error);
      }
    })();
    // The import runs once per finished job.
  }, [job?.status]);
  const generating = !!job && !failure && !["succeeded", "partial"].includes(job.status);
  const start = async () => {
    if (!current) return;
    setFailure(null);
    try {
      setJob(
        await drawingApi().createJob({
          clientRequestId: crypto.randomUUID(),
          providerId: current.providerId,
          model: current.model,
          prompt: sheetPrompt(subject.trim()),
          parameters: { n: 1, size: "1536x1024", quality: "high", outputFormat: "png" },
          inputAssetIds: [],
          inputReferences: [],
          maskAssetId: null,
          sourceJobId: null,
        }),
      );
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !generating && onClose()}>
      <DialogPopup showCloseButton={!generating}>
        <DialogHeader className="pe-10">
          <DialogTitle>{tr("Generate three views")}</DialogTitle>
          <DialogDescription>
            {tr(
              "Creates one 1536×1024 image with front, side and back views using your drawing channel. It is recorded in Drawing and may be billed by the provider.",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4 pt-2 text-ui-sm">
          <label className="block space-y-1.5">
            <span className="text-ui-xs text-muted-foreground">{tr("Asset to draw")}</span>
            <Textarea
              rows={3}
              value={subject}
              disabled={generating}
              onChange={(event) => setSubject(event.target.value)}
            />
          </label>
          {providers.data && !enabled.length ? (
            <p role="status" className="text-ui-xs text-muted-foreground">
              {tr(
                "No drawing channel is configured. Upload a three-view image instead, or add a channel in Drawing.",
              )}
            </p>
          ) : (
            current && (
              <div className="flex items-center gap-2">
                <span className="text-ui-xs text-muted-foreground">{tr("Channel and model")}</span>
                <DrawingModelPicker
                  providers={enabled}
                  providerId={current.providerId}
                  model={current.model}
                  onChange={(providerId, model) => setChoice({ providerId, model })}
                  onSettings={() => void navigate({ to: "/drawing", search: {} })}
                />
              </div>
            )
          )}
          {generating && (
            <p role="status" aria-live="polite" className="text-ui-xs">
              {tr("Generating… this usually takes under a minute.")}
            </p>
          )}
          {failure && (
            <p role="alert" className="break-words text-ui-xs text-destructive">
              {failure}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={generating} onClick={onClose}>
            {tr("Cancel")}
          </Button>
          <Button disabled={!current || !subject.trim() || generating} onClick={() => void start()}>
            {tr(failure ? "Try again" : "Generate")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
