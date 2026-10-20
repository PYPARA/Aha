import { Alert } from "../ui/alert";
import { SpriteSizingEditor } from "./SpriteSizingEditor";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import {
  SpritePlanConfiguration,
  spritePlanLayout,
  spriteRecommendedSize,
  spriteSizeSummary,
  spritePlanForRevision,
  spritePlanIssues,
  spritePlanPrompt,
  spritePlanTasks,
  spritePlanTarget,
  spriteGenerationReference,
  spriteLayoutGuideSvg,
  spriteTaskGuideSvg,
  type SpriteGenerationPlan,
  type SpritePlanReference,
  type SpriteState,
  type ImageAsset,
} from "@synara/contracts";
import { OptionSelect } from "../ui/option-select";
import { Input } from "../ui/input";
import { Checkbox } from "../ui/checkbox";
import { Textarea } from "../ui/textarea";
import { Dialog, DialogPopup, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { DrawingModelPicker } from "../drawing/DrawingPickers";
import { DrawingSizePicker } from "../drawing/DrawingSizePicker";
import { drawingApi, imageUrl, uploadDrawingImage, useImageProviders } from "../drawing/useDrawing";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { CentralIcon } from "~/lib/central-icons";
import { PlusIcon, ArrowUpIcon, ArrowDownIcon, XIcon } from "~/lib/icons";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import {
  reviseSpritePlan,
  focusSpritePlan,
  SPRITE_PLAN_FOCUS,
  focusedSpritePlan,
  type SpriteDraftConflict,
} from "./spritePlanNavigation";
import { getSpriteProject } from "./spriteStorage";
import type { SpriteSource } from "./spriteModel";
import { SpriteRetryButton } from "./SpriteRetryButton";
import { uuid } from "./spriteModel";
import { decodeSpriteImages } from "./spriteImageInput";
import { SpriteNumberField } from "./SpriteNumberField";

export interface SpritePlanPointer {
  projectId: string;
  planId: string;
  threadId: string;
}
const field = "min-w-0";

export function SpritePlanCard({ projectId, planId, threadId }: SpritePlanPointer) {
  const tr = useAhaTranslation(),
    navigate = useNavigate(),
    providers = useImageProviders();
  const client = useQueryClient();
  const [collapsed, setCollapsed] = useState<boolean | null>(() => {
    const saved = localStorage.getItem(`aha-sprite-plan-collapsed:${planId}`);
    return saved === null ? true : saved === "true";
  });
  const sectionRef = useRef<HTMLElement>(null);
  const [conflict, setConflict] = useState<SpriteDraftConflict | null>(null);
  const expand = useCallback(() => {
    setCollapsed(false);
    localStorage.setItem(`aha-sprite-plan-collapsed:${planId}`, "false");
  }, [planId]);
  useEffect(() => {
    const focus = (e?: Event) => {
      const id = e ? (e as CustomEvent<string>).detail : focusedSpritePlan();
      if (id !== planId) return;
      expand();
      requestAnimationFrame(() =>
        sectionRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }),
      );
      sessionStorage.removeItem("aha-sprite-plan-focus");
    };
    focus();
    window.addEventListener(SPRITE_PLAN_FOCUS, focus);
    return () => window.removeEventListener(SPRITE_PLAN_FOCUS, focus);
  }, [planId, expand]);
  const [referencePicker, setReferencePicker] = useState(false);
  const [projectSources, setProjectSources] = useState<SpriteSource[]>([]);
  useEffect(() => {
    if (!referencePicker) return;
    let active = true;
    void getSpriteProject(projectId)
      .then((p) => {
        if (active) setProjectSources(p.sources);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [referencePicker, projectId]);
  const replaceReference = useRef<string | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const [expandedImage, setExpandedImage] = useState<ImageAsset | null>(null);
  const query = useQuery({
    queryKey: ["sprite-plan", projectId],
    queryFn: () => drawingApi().spriteCommand({ operation: "get", projectId }),
    refetchInterval: 2500,
  });
  const refetch = query.refetch;
  const plan = query.data?.plans?.find((p) => p.id === planId && p.threadId === threadId);
  const [draft, setDraft] = useState<SpriteGenerationPlan | null>(null);
  const [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const restoredDraft = useRef(false);
  useEffect(() => {
    if (!plan || dirtyRef.current) return;
    if (!restoredDraft.current) {
      restoredDraft.current = true;
      try {
        const buffer = JSON.parse(
          localStorage.getItem(`aha-sprite-plan-buffer:${projectId}:${planId}`) ?? "null",
        );
        if (buffer && plan.status === "draft") {
          const configuration = Schema.decodeUnknownSync(SpritePlanConfiguration)(
            buffer.configuration,
          );
          setDraft({ ...plan, configuration });
          setDirty(true);
          if (buffer.version !== plan.version)
            setError(
              "Plan changed. Your local edits are retained. Reload to use the saved version.",
            );
          return;
        }
      } catch {
        /* Ignore corrupt local buffers, keep the server plan. */
      }
    }
    setDraft((current) =>
      !current || current.id !== plan.id || plan.version >= current.version ? plan : current,
    );
  }, [plan, projectId, planId]);
  useEffect(() => {
    if (dirty && draft?.status === "draft")
      localStorage.setItem(
        `aha-sprite-plan-buffer:${projectId}:${planId}`,
        JSON.stringify({ version: draft.version, configuration: draft.configuration }),
      );
  }, [dirty, draft, projectId, planId]);
  useEffect(
    () =>
      drawingApi().onEvent((e) => {
        if (e.type === "sprite-changed" && e.projectId === projectId) void refetch();
      }),
    [projectId, refetch],
  );
  const accept = useCallback(
    (state: SpriteState) => {
      localStorage.removeItem(`aha-sprite-plan-buffer:${projectId}:${planId}`);
      client.setQueryData(["sprite-plan", projectId], state);
      const updated = state.plans?.find((p) => p.id === planId);
      if (updated) {
        if (updated.status === "confirmed") {
          setCollapsed(true);
          localStorage.setItem(`aha-sprite-plan-collapsed:${planId}`, "true");
        }
        setDraft(updated);
        setDirty(false);
      }
      void refetch();
    },
    [client, projectId, planId, refetch],
  );
  const save = useCallback(async () => {
    const current = draftRef.current;
    if (!current) return;
    const configuration = Schema.decodeUnknownSync(SpritePlanConfiguration)(current.configuration);
    const state = await drawingApi().spriteCommand({
      operation: "update-plan",
      projectId,
      planId,
      version: current.version,
      configuration,
    });
    accept(state);
  }, [projectId, planId, accept]);
  const perform = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      setError("");
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        await refetch();
      } finally {
        setBusy(false);
      }
    },
    [refetch],
  );
  // Debounce field edits, retaining the visible version for optimistic concurrency.
  useEffect(() => {
    if (!dirty || busy || error || query.isError || query.data?.recovery?.readOnly) return;
    try {
      Schema.decodeUnknownSync(SpritePlanConfiguration)(draft?.configuration);
    } catch {
      return;
    }
    const timer = setTimeout(() => void perform(save), 650);
    return () => clearTimeout(timer);
  }, [draft, dirty, busy, error, perform, save, query.isError, query.data?.recovery?.readOnly]);
  if (!draft)
    return (
      <div
        className="shrink-0 rounded-xl border p-4 text-ui-sm text-muted-foreground"
        role="status"
      >
        {query.isError ? tr("Could not load generation plan.") : tr("Loading generation plan…")}
      </div>
    );
  const c = spritePlanForRevision(draft.configuration),
    layout = spritePlanLayout(c),
    editable =
      draft.status === "draft" && !busy && !query.isError && !query.data?.recovery?.readOnly;
  let issues = spritePlanIssues(c);
  try {
    Schema.decodeUnknownSync(SpritePlanConfiguration)(c);
  } catch {
    issues = [...issues, "Check action frames, FPS and canvas dimensions."];
  }
  const patch = (next: Partial<typeof c>) => {
    if (!editable) return;
    let configuration = { ...c, ...next, sizePolicy: undefined };
    if (configuration.kind === "animation" && configuration.sizeSource === "recommended")
      try {
        configuration = {
          ...configuration,
          parameters: { ...configuration.parameters, size: spriteRecommendedSize(configuration) },
        };
      } catch {
        /* Keep the draft visible while capability input is incomplete. */
      }
    setDraft({ ...draft, configuration });
    setDirty(true);
    setError("");
  };
  const actionPatch = (id: string, value: Partial<(typeof c.actions)[number]>) =>
    patch({ actions: c.actions.map((a) => (a.id === id ? { ...a, ...value } : a)) });
  let taskConfigurations: (typeof c)[] = [];
  try {
    taskConfigurations = spritePlanTasks(c);
  } catch {
    /* Validation is shown on the card. */
  }
  const modifyPlan = () =>
    void perform(async () => {
      try {
        const current = query.data?.plans?.find(
          (p) =>
            p.status === "draft" &&
            (p.targetKey ?? spritePlanTarget(p.configuration)) === spritePlanTarget(c),
        );
        if (current) {
          focusSpritePlan(current.id);
          return;
        }
        const next = await reviseSpritePlan({
          operation: "clone-plan",
          projectId,
          planId,
        });
        if (next.resultPlanId) focusSpritePlan(next.resultPlanId);
        await refetch();
      } catch (e) {
        if ((e as SpriteDraftConflict).currentPlan) setConflict(e as SpriteDraftConflict);
        else throw e;
      }
    });
  const runs = query.data?.runs.filter((r) => r.planId === planId) ?? [];
  const pool = new Map<string, SpritePlanReference>();
  for (const r of query.data?.selectedReferences ?? [])
    if (r.threadId === threadId) pool.set(r.reference.asset.id, r.reference);
  for (const r of query.data?.referencePool ?? [])
    if (r.threadId === threadId) pool.set(r.reference.asset.id, r.reference);
  for (const p of query.data?.plans ?? [])
    if (p.threadId === threadId)
      for (const r of p.configuration.references) pool.set(r.asset.id, r);
  for (const r of query.data?.runs ?? [])
    for (const a of r.candidates?.flatMap((c) => [c.source, ...c.frames]) ?? [
      ...(r.source ? [r.source] : []),
      ...r.frames,
    ])
      pool.set(a.id, {
        referenceId: `candidate:${r.id}:${a.id}`,
        asset: a,
        role: "reference",
        source: "candidate",
        derivedFrom:
          r.candidates?.find((c) => c.frames.some((f) => f.id === a.id))?.source.id ??
          (r.frames.some((f) => f.id === a.id) ? r.source?.id : undefined),
        actionId: null,
      });
  const addReferences = async (references: SpritePlanReference[]) => {
    await drawingApi().spriteCommand({
      operation: "import-references",
      projectId,
      threadId,
      references,
    });
    const current = draftRef.current;
    if (!current || current.status !== "draft") throw new Error("This plan is no longer editable.");
    const configuration = spritePlanForRevision(current.configuration);
    const next = new Map(
      configuration.references
        .filter((r) => r.asset.id !== replaceReference.current)
        .map((r) => [r.asset.id, r]),
    );
    for (const r of references) next.set(r.asset.id, r);
    if (next.size > 15) throw new Error("Choose at most 15 reference images.");
    setDraft({ ...current, configuration: { ...configuration, references: [...next.values()] } });
    setDirty(true);
    setError("");
    replaceReference.current = null;
    setReferencePicker(false);
  };
  const addFiles = async (files: File[]) => {
    if (!editable) return;
    try {
      if (files.length + c.references.length - (replaceReference.current ? 1 : 0) > 15)
        throw new Error("Choose at most 15 reference images.");
      const references: SpritePlanReference[] = [];
      const { sources, errors } = await decodeSpriteImages(files);
      for (const file of sources) {
        const asset = await uploadDrawingImage(file.blob, file.name);
        references.push({
          referenceId: `upload:${asset.id}`,
          asset,
          role: "reference",
          actionId: null,
          source: "upload",
        });
      }
      if (references.length) await addReferences(references);
      if (errors.length) setError(errors.join("\n"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const openProject = () => void navigate({ to: "/sprite-animation", search: { projectId } });
  return (
    <section
      ref={sectionRef}
      data-sprite-plan-id={planId}
      data-sprite-plan
      className="font-system-ui my-2 min-w-0 shrink-0 overflow-clip rounded-lg border bg-background"
      aria-label={tr("Sprite generation plan")}
    >
      {(query.isError || query.data?.recovery?.readOnly) && (
        <Alert variant="warning" size="sm" className="rounded-none">
          <p>
            {tr(
              "Task results could not be refreshed. Your last results and local actions are preserved.",
            )}
          </p>
          <Button size="sm" variant="ghost" onClick={() => void refetch()}>
            {tr("Retry reading")}
          </Button>
        </Alert>
      )}
      <header className="flex items-center gap-3 border-b border-[color:var(--color-border-light)] px-4 py-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-background-elevated-secondary)]">
          <CentralIcon name="images-sparkle" className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-ui font-medium">
            {tr(c.kind === "character" ? "Character generation" : "Action generation")}
          </h3>
          <p className="mt-0.5 text-ui-sm text-muted-foreground">
            {tr(
              draft.status === "draft"
                ? "Review the plan before generating."
                : draft.status === "confirmed"
                  ? "Confirmed generation settings"
                  : draft.supersededBy
                    ? "Plan replaced"
                    : "Plan dismissed",
            )}
          </p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          aria-label={tr((collapsed ?? draft.status !== "draft") ? "Expand plan" : "Collapse plan")}
          aria-expanded={!(collapsed ?? draft.status !== "draft")}
          onClick={() => {
            const next = !(collapsed ?? draft.status !== "draft");
            setCollapsed(next);
            localStorage.setItem(`aha-sprite-plan-collapsed:${planId}`, String(next));
          }}
        >
          <DisclosureChevron open={!(collapsed ?? draft.status !== "draft")} />
        </Button>
        <span className="rounded-full bg-muted px-2 py-1 text-ui-xs text-muted-foreground">
          v{draft.version}
        </span>
      </header>
      <div className="px-4 py-2 text-ui-sm text-muted-foreground">
        {c.kind === "character"
          ? tr("Static image · 1 image")
          : `${layout.actions.map((a) => `${a.name} ${a.frameCount}`).join(" · ")} · ${layout.jobs} ${tr("image tasks")}`}
        {` · ${tr(c.background === "transparent" ? "Transparent" : "Chroma background")}`}
        {c.creative?.style && ` · ${c.creative.style}`}
        {(busy || dirty) && <span role="status"> · {tr("Saving…")}</span>}
        {(error || issues.length > 0) && draft.status === "draft" && (
          <span className="text-destructive"> · {tr("Plan needs attention")}</span>
        )}
      </div>
      <div className="space-y-2 px-4 pb-3 text-ui-sm">
        <p className="line-clamp-3 whitespace-pre-wrap">{c.prompt}</p>
        <p className="text-muted-foreground">
          {tr(c.kind === "character" ? "Character image size" : "Whole sprite sheet size")}:{" "}
          {taskConfigurations[0]?.parameters.size ?? c.parameters.size ?? "auto"}
        </p>
        {c.kind === "animation" && (
          <p className="text-muted-foreground">
            {tr("Output frame size")}: {c.width}×{c.height} ·{" "}
            {layout.actions
              .map((a) => `${a.fps} FPS${a.loop ? ` · ${tr("Loop")}` : ""}`)
              .join(" / ")}
          </p>
        )}
        <p className="text-muted-foreground">
          {c.model || tr("Select model")} · {layout.jobs} {tr("image tasks")} · {tr("Cost unknown")}
        </p>
        {c.references.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {c.references.slice(0, 4).map((r) => (
              <button
                key={r.asset.id}
                onClick={() => setExpandedImage(r.asset)}
                aria-label={`${tr("Preview reference")}: ${r.asset.name}`}
              >
                <img
                  src={imageUrl(r.asset, "thumbnail")}
                  alt={r.asset.name}
                  className="size-10 rounded object-contain"
                />
              </button>
            ))}
            <span className="text-muted-foreground">
              {c.references.length} {tr("Reference images")}
            </span>
          </div>
        )}
        {(collapsed ?? true) && draft.status === "draft" && issues.length > 0 && (
          <p role="status" className="text-muted-foreground">
            {issues.map((issue) => tr(issue)).join(" · ")}
          </p>
        )}
        {(collapsed ?? true) && error && (
          <p role="alert" className="text-destructive">
            {tr(error)}
          </p>
        )}
      </div>
      <DisclosureRegion open={!(collapsed ?? draft.status !== "draft")}>
        <div className="space-y-4 p-4">
          {draft.status !== "draft" ? (
            <div className="space-y-3 text-ui-sm">
              <p className="whitespace-pre-wrap">{c.prompt}</p>
              <p>
                {c.model} · {taskConfigurations[0]?.parameters.size ?? c.parameters.size ?? "auto"}{" "}
                · {c.parameters.outputFormat ?? "png"}
              </p>
              <div className="flex flex-wrap gap-2">
                {c.references.map((r) => (
                  <button key={r.asset.id} onClick={() => setExpandedImage(r.asset)}>
                    <img
                      src={imageUrl(r.asset, "thumbnail")}
                      alt={r.asset.name}
                      className="size-16 rounded border object-contain"
                    />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <fieldset disabled={!editable} className="space-y-4 disabled:opacity-80">
              <p className="text-ui-sm text-muted-foreground">
                {tr(
                  "Frame size is the final canvas; image size is the model's whole image. Technical settings inherit the project unless edited.",
                )}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <OptionSelect
                  label={tr("Generation target")}
                  value={c.kind}
                  onValueChange={(value) => patch({ kind: value as typeof c.kind })}
                >
                  <option value="character">{tr("Static image")}</option>
                  <option value="animation">{tr("Animation")}</option>
                </OptionSelect>
                {c.workflowVersion === 2 && (
                  <p className="w-full text-ui-sm">
                    {tr("Staged action generation")} · {tr("Cost unknown")} ·{" "}
                    {tr("Maximum 8 frames per image task")}
                  </p>
                )}
                {c.kind === "animation" && c.workflowVersion !== 2 && (
                  <OptionSelect
                    label={tr("Generation mode")}
                    value={c.mode}
                    onValueChange={(value) => patch({ mode: value as typeof c.mode })}
                  >
                    <option value="combined">{tr("One sheet for all actions")}</option>
                    <option value="separate">{tr("One image per action")}</option>
                  </OptionSelect>
                )}
              </div>
              <label className="block space-y-1.5">
                <span className="text-ui-sm font-medium">{tr("Prompt")}</span>
                <Textarea
                  size="sm"
                  className="w-full text-ui-sm leading-relaxed"
                  rows={3}
                  value={c.prompt}
                  onChange={(e) => patch({ prompt: e.target.value })}
                />
              </label>
              <div className="space-y-2">
                <span className="text-ui-sm font-medium">{tr("Reference images")}</span>
                {c.references.map((r, referenceIndex) => (
                  <div
                    key={r.asset.id}
                    className="flex flex-wrap items-center gap-2 rounded-lg border p-2"
                  >
                    <a
                      href={imageUrl(r.asset)}
                      aria-label={`${tr("Preview reference")} ${r.asset.name}`}
                      onClick={(e) => {
                        e.preventDefault();
                        setExpandedImage(r.asset);
                      }}
                      className="shrink-0 rounded-md bg-muted"
                    >
                      <img
                        src={imageUrl(r.asset, "thumbnail")}
                        alt={r.asset.name}
                        className="size-12 rounded-md object-contain"
                      />
                    </a>
                    <span className="min-w-0 flex-1 truncate text-ui-sm" title={r.asset.name}>
                      {r.asset.name}
                      {r.derivedFrom && (
                        <span className="block text-ui-xs text-muted-foreground">
                          {tr("Processed image")}
                        </span>
                      )}
                    </span>
                    <OptionSelect
                      label={`${tr("Reference purpose")} ${r.asset.name}`}
                      value={r.role}
                      onValueChange={(value) =>
                        patch({
                          references: c.references.map((v) =>
                            v.asset.id === r.asset.id
                              ? { ...v, role: value as typeof r.role, actionId: null }
                              : v,
                          ),
                        })
                      }
                    >
                      {["reference", "character", "style", "pose"].map((v) => (
                        <option key={v} value={v}>
                          {tr(
                            v === "reference"
                              ? "General reference"
                              : v === "character"
                                ? "Subject appearance"
                                : v === "style"
                                  ? "Style reference"
                                  : "Pose reference",
                          )}
                        </option>
                      ))}
                    </OptionSelect>
                    {r.role === "pose" && (
                      <OptionSelect
                        label={tr("Applies to action")}
                        value={r.actionId ?? ""}
                        onValueChange={(value) =>
                          patch({
                            references: c.references.map((v) =>
                              v.asset.id === r.asset.id ? { ...v, actionId: value || null } : v,
                            ),
                          })
                        }
                      >
                        <option value="">{tr("All actions")}</option>
                        {c.actions.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </OptionSelect>
                    )}
                    <span className="text-ui-xs text-muted-foreground">
                      {r.asset.width} × {r.asset.height} · {tr(r.source ?? "candidate")}
                    </span>
                    {[-1, 1].map((direction) => (
                      <Button
                        key={direction}
                        size="icon-sm"
                        variant="ghost"
                        aria-label={tr(direction < 0 ? "Move reference up" : "Move reference down")}
                        disabled={
                          (c.workflowVersion === 2 &&
                            c.kind === "animation" &&
                            (referenceIndex === 0 || referenceIndex + direction === 0)) ||
                          referenceIndex + direction < 0 ||
                          referenceIndex + direction >= c.references.length
                        }
                        onClick={() => {
                          const references = [...c.references];
                          [references[referenceIndex], references[referenceIndex + direction]] = [
                            references[referenceIndex + direction]!,
                            references[referenceIndex]!,
                          ];
                          patch({ references });
                        }}
                      >
                        {direction < 0 ? (
                          <ArrowUpIcon className="size-3" />
                        ) : (
                          <ArrowDownIcon className="size-3" />
                        )}
                      </Button>
                    ))}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={
                        c.workflowVersion === 2 && c.kind === "animation" && referenceIndex === 0
                      }
                      onClick={() => {
                        replaceReference.current = r.asset.id;
                        uploadInput.current?.click();
                      }}
                    >
                      {tr("Replace reference")}
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`${tr("Remove reference")} ${r.asset.name}`}
                      disabled={
                        c.workflowVersion === 2 && c.kind === "animation" && referenceIndex === 0
                      }
                      onClick={() =>
                        patch({ references: c.references.filter((v) => v.asset.id !== r.asset.id) })
                      }
                    >
                      <XIcon className="size-3.5" />
                    </Button>
                  </div>
                ))}
                <div
                  className="rounded-lg border border-dashed p-3 text-ui-sm"
                  data-sprite-reference-drop
                  tabIndex={0}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    void addFiles([...e.dataTransfer.files]);
                  }}
                  onPaste={(e) => {
                    if (e.clipboardData.files.length) {
                      e.preventDefault();
                      void addFiles([...e.clipboardData.files]);
                    }
                  }}
                >
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!editable || c.references.length >= 15}
                      onClick={() => {
                        replaceReference.current = null;
                        uploadInput.current?.click();
                      }}
                    >
                      {tr("Upload reference images")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!editable}
                      onClick={() => setReferencePicker(true)}
                    >
                      {tr("Choose existing images")}
                    </Button>
                  </div>
                  <p className="mt-2 text-muted-foreground">
                    {tr(
                      "Drop or paste images here. The first image defines the subject appearance.",
                    )}
                  </p>
                  <input
                    ref={uploadInput}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      void addFiles([...(e.target.files ?? [])]);
                      e.target.value = "";
                    }}
                  />
                </div>
              </div>
              {c.kind === "animation" && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-ui-sm font-medium">{tr("Actions")}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!!c.segment}
                      onClick={() =>
                        patch({
                          actions: [
                            ...c.actions,
                            {
                              id: uuid(),
                              name: "idle",
                              description: "",
                              enabled: true,
                              frameCount: 8,
                              fps: 12,
                              loop: true,
                            },
                          ],
                        })
                      }
                    >
                      <PlusIcon className="size-3.5" />
                      {tr("Add action")}
                    </Button>
                  </div>
                  {c.actions.map((a, i) => (
                    <div
                      key={a.id}
                      className="space-y-2 rounded-lg border bg-[var(--color-background-elevated-secondary)] p-3"
                    >
                      <div className="flex items-center gap-2">
                        <Checkbox
                          disabled={!editable || !!c.segment}
                          aria-label={`${tr("Enable action")} ${i + 1}`}
                          checked={a.enabled}
                          onCheckedChange={(enabled) => actionPatch(a.id, { enabled })}
                        />
                        <Input
                          size="sm"
                          nativeInput
                          className={`${field} flex-1`}
                          aria-label={`${tr("Action name")} ${i + 1}`}
                          disabled={!!c.segment}
                          value={a.name}
                          onChange={(e) => actionPatch(a.id, { name: e.target.value })}
                        />
                        {[
                          { Icon: ArrowUpIcon, delta: -1, label: "Move earlier" },
                          { Icon: ArrowDownIcon, delta: 1, label: "Move later" },
                        ].map(({ Icon, delta, label }) => (
                          <Button
                            key={label}
                            variant="ghost"
                            size="icon-sm"
                            aria-label={tr(label)}
                            disabled={!editable || i + delta < 0 || i + delta >= c.actions.length}
                            onClick={() => {
                              const actions = [...c.actions];
                              [actions[i], actions[i + delta]] = [actions[i + delta]!, actions[i]!];
                              patch({ actions });
                            }}
                          >
                            <Icon className="size-3.5" />
                          </Button>
                        ))}
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={tr("Delete action")}
                          disabled={!!c.segment}
                          onClick={() =>
                            patch({
                              actions: c.actions.filter((v) => v.id !== a.id),
                              references: c.references.filter((r) => r.actionId !== a.id),
                            })
                          }
                        >
                          <XIcon className="size-3.5" />
                        </Button>
                      </div>
                      <Input
                        size="sm"
                        nativeInput
                        className={`${field} w-full`}
                        aria-label={`${tr("Action description")} ${i + 1}`}
                        placeholder={tr("Describe the motion and direction")}
                        value={a.description}
                        onChange={(e) => actionPatch(a.id, { description: e.target.value })}
                      />
                      <div className="flex flex-wrap items-center gap-3 text-ui-sm">
                        <SpriteNumberField
                          label={`${tr("Frames")} ${i + 1}`}
                          value={a.frameCount}
                          max={32}
                          disabled={!!c.segment}
                          onChange={(frameCount) => actionPatch(a.id, { frameCount })}
                        />
                        <SpriteNumberField
                          label={`FPS ${i + 1}`}
                          value={a.fps}
                          max={60}
                          disabled={(c.segment?.count ?? 1) > 1}
                          onChange={(fps) => actionPatch(a.id, { fps })}
                        />
                        <label className="flex items-center gap-1.5">
                          <Checkbox
                            disabled={!editable || (c.segment?.count ?? 1) > 1}
                            checked={a.loop}
                            onCheckedChange={(loop) => actionPatch(a.id, { loop })}
                          />
                          {tr("Loop")}
                        </label>
                      </div>
                      {c.segment && (
                        <p className="text-ui-sm text-muted-foreground">
                          {tr(
                            "To change frame count or playback settings, regenerate the complete action.",
                          )}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <details className="rounded-lg border">
                <summary className="cursor-pointer px-3 py-2.5 text-ui-sm font-medium">
                  {tr("Drawing settings")}
                </summary>
                <div className="space-y-3 border-t p-3">
                  <div className="flex flex-wrap gap-2">
                    <OptionSelect
                      label={tr("Generated background")}
                      value={c.background}
                      onValueChange={(value) =>
                        patch({
                          background: value as typeof c.background,
                          parameters: {
                            ...c.parameters,
                            outputFormat:
                              c.parameters.outputFormat === "jpeg"
                                ? "png"
                                : c.parameters.outputFormat,
                          },
                        })
                      }
                    >
                      <option value="transparent">{tr("Transparent")}</option>
                      <option value="chroma">{tr("Chroma background")}</option>
                    </OptionSelect>
                    {c.background === "chroma" && (
                      <Input
                        aria-label={tr("Chroma key")}
                        type="color"
                        value={c.chromaKey}
                        onChange={(e) => patch({ chromaKey: e.target.value })}
                        className="size-8 rounded border"
                      />
                    )}
                  </div>
                  <DrawingModelPicker
                    providers={providers.data ?? []}
                    providerId={c.providerId}
                    model={c.model}
                    onChange={(providerId, model) =>
                      patch({
                        providerId,
                        model,
                      })
                    }
                    onSettings={() =>
                      void navigate({ to: "/settings", search: { section: "drawing" } })
                    }
                  />
                  {c.kind === "animation" ? (
                    <SpriteSizingEditor configuration={c} onChange={patch} />
                  ) : (
                    <>
                      <p className="text-ui-sm text-muted-foreground">
                        {tr("Character image size")}
                      </p>
                      <DrawingSizePicker
                        exact
                        value={c.parameters.size}
                        onChange={(size) =>
                          patch({
                            parameters: { ...c.parameters, size },
                            sizeSource: !size || size === "auto" ? "auto" : "user",
                          })
                        }
                      />
                    </>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <OptionSelect
                      label={tr("Quality")}
                      value={c.parameters.quality ?? "auto"}
                      onValueChange={(value) =>
                        patch({
                          parameters: {
                            ...c.parameters,
                            quality: value as typeof c.parameters.quality,
                          },
                        })
                      }
                    >
                      {["auto", "low", "medium", "high", "xhigh", "max"].map((v) => (
                        <option value={v} key={v}>
                          {tr(v)}
                        </option>
                      ))}
                    </OptionSelect>
                    <OptionSelect
                      label={tr("Format")}
                      value={c.parameters.outputFormat ?? "png"}
                      onValueChange={(value) =>
                        patch({
                          parameters: {
                            ...c.parameters,
                            outputFormat: value as typeof c.parameters.outputFormat,
                          },
                        })
                      }
                    >
                      {(c.background === "transparent"
                        ? ["png", "webp"]
                        : ["png", "webp", "jpeg"]
                      ).map((v) => (
                        <option value={v} key={v}>
                          {v.toUpperCase()}
                        </option>
                      ))}
                    </OptionSelect>
                  </div>
                  <div className="flex flex-wrap gap-3">
                    {c.kind === "animation" &&
                      c.workflowVersion !== 2 &&
                      (["width", "height"] as const).map((key) => (
                        <label key={key} className="flex items-center gap-2 text-ui-sm">
                          {tr(key === "width" ? "Frame width" : "Frame height")}
                          <Input
                            size="sm"
                            nativeInput
                            className={`${field} w-20`}
                            type="number"
                            min={1}
                            max={4096}
                            value={c[key]}
                            onChange={(e) => patch({ [key]: Number(e.target.value) })}
                          />
                        </label>
                      ))}
                  </div>
                  <p className="text-ui-sm text-muted-foreground">
                    {tr(
                      "Image size controls the whole sheet. Frame size is applied after slicing. Parameter support depends on the Drawing provider.",
                    )}
                  </p>
                </div>
              </details>
            </fieldset>
          )}
          <div className="rounded-lg bg-[var(--color-background-elevated-secondary)] p-3">
            {c.kind === "animation" && (
              <div className="mb-3 space-y-1 text-ui-sm">
                <p>
                  {tr("Requested sheet size")}:{" "}
                  {taskConfigurations[0]?.parameters.size ?? c.parameters.size ?? "auto"} ·{" "}
                  {tr(
                    c.sizeSource === "recommended"
                      ? "Workbench recommendation"
                      : c.sizeSource === "auto"
                        ? "Automatic"
                        : "User specified",
                  )}
                </p>
                <p>
                  {tr("Expected cell size")}:{" "}
                  {spriteSizeSummary(c)
                    ? `${spriteSizeSummary(c)!.cellWidth.toFixed(1)} × ${spriteSizeSummary(c)!.cellHeight.toFixed(1)}`
                    : tr("Determined by the returned image")}
                </p>
                <p>
                  {tr("Output frame size")}: {c.width} × {c.height}
                </p>
                {c.renderSpec && (
                  <p>
                    {tr("Logical pixels")}: {c.renderSpec.logicalWidth} ×{" "}
                    {c.renderSpec.logicalHeight} · {tr("Output scale")}: {c.renderSpec.outputScale}×
                  </p>
                )}
                {c.canonical && (
                  <p>
                    {tr("Character reference")}: {spriteGenerationReference(c.canonical).name} ·{" "}
                    {new Date(c.canonical.confirmedAt).toLocaleString()}
                  </p>
                )}
                {(spriteSizeSummary(c)?.scale ?? 0) > 1 && (
                  <p className="text-orange-600">
                    {tr("Frames will be enlarged")}: {spriteSizeSummary(c)!.scale.toFixed(2)}×
                  </p>
                )}
                {(layout.actions.length > 4 || (spriteSizeSummary(c)?.scale ?? 0) > 1) && (
                  <p className="text-muted-foreground">
                    {tr(
                      "Dense sheets are harder to align. Consider separate generation if layout quality is insufficient.",
                    )}
                  </p>
                )}
                <p className="text-muted-foreground">
                  {tr(
                    "Image dimensions and layout guides cannot guarantee frame count or alignment. Provider size support may vary.",
                  )}
                </p>
              </div>
            )}
            <p className="text-ui-sm font-medium">
              {c.kind === "character" ? (
                tr("Static image · 1 image")
              ) : (
                <>
                  {layout.jobs} {tr("image tasks")} · {layout.actions.length} {tr("actions")} ·{" "}
                  {layout.frames} {tr("frames")}
                </>
              )}
            </p>
            {c.kind === "animation" && c.mode === "combined" && (
              <>
                <p className="mt-1 text-ui-sm text-muted-foreground">
                  {layout.rows} {tr("rows")} × {layout.columns} {tr("columns")} · {layout.empty}{" "}
                  {tr("empty cells")}
                </p>
                <div
                  className="mt-3 max-h-40 space-y-1 overflow-auto"
                  aria-label={tr("Sheet layout")}
                >
                  {layout.actions.map((a) => (
                    <div key={a.id} className="flex items-center gap-2">
                      <span className="w-16 shrink-0 truncate text-ui-xs text-muted-foreground">
                        {a.name}
                      </span>
                      <div
                        className="grid flex-1 gap-0.5"
                        style={{ gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))` }}
                      >
                        {Array.from({ length: layout.columns }, (_, i) => (
                          <span
                            key={i}
                            className={`h-3 rounded-sm ${i < a.frameCount ? "bg-primary/30" : "border border-dashed border-muted-foreground/30"}`}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          <details>
            <summary className="cursor-pointer text-ui-sm text-muted-foreground">
              {tr("Full generation inputs")}
            </summary>
            {taskConfigurations.map((task, i) => {
              const taskLayout = spritePlanLayout(task);
              return (
                <div
                  key={`${taskLayout.actions.map((a) => a.id).join(":")}:${task.segment?.index ?? 0}`}
                  className="mt-3 space-y-2 rounded-lg border p-3"
                >
                  <p className="text-ui-sm font-medium">
                    {tr("Image task")} {i + 1} · {taskLayout.actions.map((a) => a.name).join(" · ")}
                  </p>
                  {task.segment && (
                    <p className="text-ui-sm">
                      {tr("Segment")} {task.segment.index + 1}/{task.segment.count} ·{" "}
                      {tr(
                        task.segment.index ? "Waits for previous segment" : "Can run in parallel",
                      )}{" "}
                      · {tr("Frames")} {task.segment.frameStart + 1}–
                      {task.segment.frameStart + task.segment.frameCount}/{task.segment.totalFrames}
                    </p>
                  )}
                  <p className="text-ui-xs text-muted-foreground">
                    {task.parameters.size ?? "auto"} · {task.parameters.quality ?? "auto"} ·{" "}
                    {task.parameters.outputFormat ?? "png"} ·{" "}
                    {tr(task.background === "transparent" ? "Transparent" : "Chroma background")}
                  </p>
                  <ol className="space-y-1 text-ui-sm">
                    {task.references.map((reference, index) => (
                      <li key={reference.asset.id} className="flex items-center gap-2">
                        <img
                          src={imageUrl(reference.asset, "thumbnail")}
                          alt=""
                          className="size-8 object-contain"
                        />
                        <span>
                          {index + 1}. {reference.asset.name} ·{" "}
                          {reference.purpose ||
                            tr(
                              reference.role === "reference"
                                ? "General reference"
                                : reference.role === "character"
                                  ? "Subject appearance"
                                  : reference.role === "style"
                                    ? "Style reference"
                                    : "Pose reference",
                            )}
                        </span>
                      </li>
                    ))}
                  </ol>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-ui-xs leading-relaxed">
                    {!dirty && draft.compiled?.[i]
                      ? draft.compiled[i]!.prompt
                      : spritePlanPrompt(task)}
                  </pre>
                  {task.kind === "animation" && (
                    <>
                      <p className="text-ui-sm text-muted-foreground">
                        {tr("The system adds a layout guide as the last reference for animation.")}
                      </p>
                      <img
                        className="max-h-40 w-full rounded-lg border bg-white object-contain"
                        alt={tr("System layout guide")}
                        src={`data:image/svg+xml,${encodeURIComponent(
                          task.layout
                            ? spriteTaskGuideSvg(
                                task.layout,
                                task.canonical
                                  ? task.canonical.pivotY / task.canonical.renderSpec.logicalHeight
                                  : 0.9,
                              )
                            : spriteLayoutGuideSvg(
                                taskLayout.columns,
                                taskLayout.rows,
                                task.parameters.size,
                                task.width,
                                task.height,
                                taskLayout.actions.map((a) => a.frameCount),
                              ),
                        )}`}
                      />
                    </>
                  )}
                </div>
              );
            })}
          </details>
          {issues.length > 0 && draft.status === "draft" && (
            <ul className="space-y-1 text-ui-sm text-destructive" role="alert">
              {issues.map((issue) => (
                <li key={issue}>
                  {issue.startsWith("Background conflicts") ? (
                    <>
                      {tr("Prompt background conflicts with Drawing settings")}:{" "}
                      {issue.split("“")[1]?.replace("”", "")}{" "}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          sectionRef.current
                            ?.querySelector<HTMLTextAreaElement>("textarea")
                            ?.focus()
                        }
                      >
                        {tr("Edit prompt")}
                      </Button>
                    </>
                  ) : (
                    tr(issue)
                  )}
                </li>
              ))}
            </ul>
          )}
          {error && (
            <p className="text-ui-sm text-destructive" role="alert">
              {tr(error)}{" "}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  localStorage.removeItem(`aha-sprite-plan-buffer:${projectId}:${planId}`);
                  setDraft(plan ?? draft);
                  setDirty(false);
                  setError("");
                }}
              >
                {tr("Reload plan")}
              </Button>
            </p>
          )}
          {runs.length > 0 && (
            <div className="space-y-2">
              {runs.map((r) => (
                <div key={r.id} className="rounded-lg border p-2 text-ui-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span>
                      {r.configuration?.mode === "combined" &&
                      r.configuration.actions.filter((a) => a.enabled).length > 1
                        ? tr("Combined sprite sheet")
                        : r.context.action}
                    </span>
                    <span role="status" className="text-muted-foreground">
                      {tr(r.status)}
                    </span>
                  </div>
                  {r.error && <p className="mt-1 text-destructive">{r.error}</p>}
                  {r.source &&
                    r.configuration?.parameters.size &&
                    r.configuration.parameters.size !== "auto" &&
                    r.configuration.parameters.size !== `${r.source.width}x${r.source.height}` && (
                      <p role="status" className="mt-2 text-ui-sm text-muted-foreground">
                        {tr("Requested image size")}: {r.configuration.parameters.size} ·{" "}
                        {tr("Actual image size")}: {r.source.width}×{r.source.height}
                      </p>
                    )}
                  {r.source && (
                    <button
                      type="button"
                      className="mt-2 flex w-full items-center gap-3 rounded-lg bg-muted/40 p-2 text-left"
                      onClick={() => setExpandedImage(r.source!)}
                    >
                      <img
                        className="h-16 w-24 rounded-md object-contain"
                        alt={r.source.name}
                        src={imageUrl(r.source, "thumbnail")}
                      />
                      <span className="text-muted-foreground">
                        {tr("View original sheet")} · {r.source.width} × {r.source.height}
                      </span>
                    </button>
                  )}
                  {r.actions?.map((o) => (
                    <p key={o.action.id} className="mt-1 text-muted-foreground">
                      {o.action.name} · {o.frames.length} {tr("frames")}
                      {o.warnings.length ? ` · ${o.warnings.length} ${tr("warnings")}` : ""}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </DisclosureRegion>
      <footer className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-2 border-t bg-background px-4 py-3">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (collapsed) expand();
            else {
              setCollapsed(true);
              localStorage.setItem(`aha-sprite-plan-collapsed:${planId}`, "true");
            }
          }}
        >
          {tr(
            collapsed
              ? draft.status === "draft"
                ? "Modify parameters"
                : "View generation plan"
              : "Done editing",
          )}
        </Button>
        <div className="flex items-center gap-2">
          {draft.status !== "draft" && (
            <Button size="sm" variant="ghost" onClick={openProject}>
              {tr("Open sprite project")}
            </Button>
          )}
          <SpriteRetryButton
            runs={runs}
            allRuns={query.data?.runs ?? []}
            onState={accept}
            onModify={modifyPlan}
          />
          {draft.status === "draft" ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void perform(async () =>
                    accept(
                      await drawingApi().spriteCommand({
                        operation: "dismiss-plan",
                        projectId,
                        planId,
                        version: draft.version,
                      }),
                    ),
                  )
                }
              >
                {tr("Dismiss")}
              </Button>
              <Button
                size="sm"
                disabled={
                  busy ||
                  dirty ||
                  !!issues.length ||
                  !!error ||
                  query.isError ||
                  !!query.data?.recovery?.readOnly
                }
                onClick={() =>
                  void perform(async () =>
                    accept(
                      await drawingApi().spriteConfirm({
                        projectId,
                        planId,
                        threadId,
                        version: draft.version,
                      }),
                    ),
                  )
                }
              >
                {busy || dirty ? tr("Saving…") : `${tr("Start generation")} · ${layout.jobs}`}
              </Button>
            </>
          ) : (
            (draft.status === "confirmed" || draft.status === "dismissed") && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => modifyPlan()}>
                {tr(
                  query.data?.plans?.some((p) => p.threadId === threadId && p.status === "draft")
                    ? "Continue editing plan"
                    : "Modify plan",
                )}
              </Button>
            )
          )}
        </div>
      </footer>
      <Dialog open={referencePicker} onOpenChange={setReferencePicker}>
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{tr("Choose existing images")}</DialogTitle>
          </DialogHeader>
          <div className="grid max-h-96 grid-cols-3 gap-3 overflow-auto p-4">
            {projectSources.map((source) => (
              <button
                key={source.id}
                className="rounded-lg border p-2 text-left text-ui-sm"
                onClick={() =>
                  void (async () => {
                    const asset = await uploadDrawingImage(source.blob, source.name);
                    await addReferences([
                      {
                        referenceId: `project:${asset.id}`,
                        asset,
                        role: "reference",
                        source: "project",
                        actionId: null,
                      },
                    ]);
                  })().catch((e) => setError(String(e)))
                }
              >
                <ProjectReferenceThumbnail source={source} />
                <p className="truncate">{source.name}</p>
                <p>
                  {tr("Project image")} · {source.width} × {source.height}
                </p>
              </button>
            ))}
            {[...pool.values()].map((r) => (
              <button
                key={r.asset.id}
                className="rounded-lg border p-2 text-left text-ui-sm hover:bg-muted"
                disabled={c.references.some((v) => v.asset.id === r.asset.id)}
                onClick={() => void addReferences([r]).catch((e) => setError(String(e)))}
              >
                <img
                  src={imageUrl(r.asset, "thumbnail")}
                  alt={r.asset.name}
                  className="h-24 w-full object-contain"
                />
                <p className="truncate">{r.asset.name}</p>
                <p className="text-muted-foreground">
                  {tr(r.source ?? "candidate")} · {r.asset.width} × {r.asset.height}
                </p>
              </button>
            ))}
          </div>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={!!conflict}
        onOpenChange={(open) => {
          if (!open) setConflict(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{tr("A draft already exists")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-wrap gap-2 p-4">
            <Button
              onClick={() => {
                focusSpritePlan(conflict!.currentPlan!.id);
                setConflict(null);
              }}
            >
              {tr("Continue editing current plan")}
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                void perform(async () => {
                  const current = conflict!.currentPlan!;
                  const next = await drawingApi().spriteCommand({
                    operation: "clone-plan",
                    projectId,
                    planId,
                    replacePlanId: current.id,
                    version: current.version,
                    displayAfter: new Date().toISOString(),
                  });
                  setConflict(null);
                  if (next.resultPlanId) focusSpritePlan(next.resultPlanId);
                  await refetch();
                })
              }
            >
              {tr("Discard current draft and create this plan")}
            </Button>
          </div>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={!!expandedImage}
        onOpenChange={(open) => {
          if (!open) setExpandedImage(null);
        }}
      >
        <DialogPopup className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{expandedImage?.name ?? tr("Reference images")}</DialogTitle>
          </DialogHeader>
          {expandedImage && (
            <img
              className="max-h-[70vh] w-full bg-muted/30 object-contain p-4"
              alt={expandedImage.name}
              src={imageUrl(expandedImage)}
            />
          )}
        </DialogPopup>
      </Dialog>
    </section>
  );
}

function ProjectReferenceThumbnail({ source }: { source: SpriteSource }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const value = URL.createObjectURL(source.blob);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [source.blob]);
  return <img src={url || undefined} alt={source.name} className="h-24 w-full object-contain" />;
}
