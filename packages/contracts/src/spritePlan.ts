import { normalizeImageSize } from "./imageSize";
import type { SpritePlanConfiguration, SpritePlanAction } from "./spriteAnimation";
import {
  spriteWorkflowTasks,
  spriteOutputSize,
  spriteGifTask,
  spriteGenerationReference,
} from "./spriteWorkflow";

/** Merge legacy creative fields without losing or duplicating the original text. */
export function spritePlanForRevision(c: SpritePlanConfiguration): SpritePlanConfiguration {
  if (!c.creative && c.prompt.trim()) {
    const { needsReview: _review, ...rest } = c;
    return rest;
  }
  const parts = [c.creative?.character, c.creative?.style, c.creative?.view, c.prompt]
    .filter((v): v is string => !!v?.trim())
    .map((v) => v.trim());
  const prompt =
    [...new Set(parts)]
      .filter((part, i, all) => !all.some((other, j) => j !== i && other.includes(part)))
      .join("\n\n") ||
    c.legacyPrompt ||
    "";
  const { creative: _creative, needsReview: _review, ...rest } = c;
  return { ...rest, prompt };
}
export function spritePromptConflicts(c: SpritePlanConfiguration): string[] {
  const text = spritePlanForRevision(c).prompt;
  const expression =
    c.background === "transparent"
      ? /(?:纯色|纯绿|绿色|绿幕|红色|蓝色|白色|黑色)\s*(?:#[0-9a-f]{6})?\s*背景|背景[^。\n]{0,20}#[0-9a-f]{6}|(?:solid\s+)?(?:green|red|blue|white|black|chroma key) background/gi
      : /透明背景|transparent background/gi;
  const matches = [...text.matchAll(expression)].filter(
    (match) =>
      !/(?:no|not|avoid|without|不要|禁止|不使用|无)\s*$/i.test(
        text.slice(Math.max(0, match.index - 12), match.index),
      ),
  );
  return [...new Set(matches.map((m) => m[0]))].map(
    (fragment) => `Background conflicts with the selected setting: “${fragment}”`,
  );
}
export function spritePlanActions(c: SpritePlanConfiguration): readonly SpritePlanAction[] {
  return c.kind === "character"
    ? [
        {
          id: "character",
          name: "Static image",
          description: "Static sprite reference",
          enabled: true,
          frameCount: 1,
          fps: 12,
          loop: false,
        },
      ]
    : c.actions.filter((a) => a.enabled);
}
export function spritePlanLayout(c: SpritePlanConfiguration) {
  const actions = spritePlanActions(c);
  if (c.workflowVersion === 2 && c.kind === "animation") {
    const frames = actions.reduce((n, a) => n + a.frameCount, 0);
    let tasks: SpritePlanConfiguration[] = [];
    try {
      tasks = spritePlanTasks(c);
    } catch {
      /* Draft errors are reported by spritePlanIssues. */
    }
    return {
      actions,
      columns: tasks[0]?.layout?.columns ?? Math.max(1, actions[0]?.frameCount ?? 1),
      rows: 1,
      frames,
      empty: 0,
      jobs: tasks.length || (c.segment ? 1 : actions.length),
    };
  }
  const columns = Math.max(1, ...actions.map((a) => a.frameCount));
  const frames = actions.reduce((n, a) => n + a.frameCount, 0);
  return {
    actions,
    columns,
    rows: actions.length,
    frames,
    empty: columns * actions.length - frames,
    jobs: c.kind === "character" || c.mode === "combined" ? 1 : actions.length,
  };
}
export function spriteTaskConfiguration(
  c: SpritePlanConfiguration,
  actions: readonly SpritePlanAction[],
): SpritePlanConfiguration {
  return {
    ...c,
    actions: [...actions],
    references: c.references.filter((r) => !r.actionId || actions.some((a) => a.id === r.actionId)),
  };
}
export function spritePlanTasks(c: SpritePlanConfiguration): SpritePlanConfiguration[] {
  if (c.workflowVersion === 2 && c.kind === "animation") {
    if (!c.segment) return spriteWorkflowTasks(c);
    const actions = c.actions.filter((a) => a.enabled),
      segment = c.segment,
      action = actions[0];
    if (
      actions.length !== 1 ||
      !action ||
      action.id !== segment.actionId ||
      action.frameCount !== segment.frameCount
    )
      throw new Error("Keep this segment's frame range or regenerate the complete action.");
    return [spriteGifTask(c, action, segment)];
  }
  const actions = spritePlanActions(c);
  return (
    c.kind === "character" || c.mode === "combined" ? [actions] : actions.map((a) => [a])
  ).map((group) => spriteTaskConfiguration(c, group));
}
export function spriteRecommendedSize(c: SpritePlanConfiguration): string {
  if (c.workflowVersion === 2 && c.kind === "animation")
    return spritePlanTasks(c)[0]?.parameters.size ?? "1024x1024";
  const l = spritePlanLayout(c);
  return normalizeImageSize(
    `${l.columns * c.width}x${(c.mode === "separate" ? 1 : l.rows) * c.height}`,
  );
}
export function spriteSizeSummary(c: SpritePlanConfiguration) {
  if (c.workflowVersion === 2 && c.kind === "animation") {
    try {
      const task = spritePlanTasks(c)[0]!,
        cell = task.layout!.cells[0]!;
      // GIF requests are sized per frame.
      return {
        width: cell.width,
        height: cell.height,
        cellWidth: cell.width,
        cellHeight: cell.height,
        scale: Math.min(c.width / cell.width, c.height / cell.height),
      };
    } catch {
      return null;
    }
  }
  const l = spritePlanLayout(c),
    match = c.parameters.size?.match(/^(\d+)x(\d+)$/);
  return match
    ? {
        width: Number(match[1]),
        height: Number(match[2]),
        cellWidth: Number(match[1]) / l.columns,
        cellHeight: Number(match[2]) / (c.mode === "separate" ? 1 : l.rows),
        scale: Math.min(
          c.width / (Number(match[1]) / l.columns),
          c.height / (Number(match[2]) / (c.mode === "separate" ? 1 : l.rows)),
        ),
      }
    : null;
}
export function spritePlanPrompt(c: SpritePlanConfiguration): string {
  const creative = spritePlanForRevision(c).prompt;
  if (c.kind === "animation") {
    if (c.workflowVersion !== 2) return creative;
    const task = c.segment ? c : spriteWorkflowTasks(c)[0];
    if (!task?.segment) return creative;
    const a = task.actions[0]!,
      segment = task.segment,
      pivot = c.canonical,
      references = task.references.length;
    return [
      creative,
      `Create one animated GIF of the SAME character shown in Reference 1. Preserve its face, proportions, style, palette, materials, clothing and props.`,
      ...task.references.map(
        (r, i) =>
          `Reference ${i + 1}: ${i === 0 ? "authoritative approved character identity" : r.purpose || r.role}.`,
      ),
      segment.index
        ? `References ${references + 1}–${references + 2}: the last two frames of the previous segment. Continue its motion and cadence without repeating them.`
        : "",
      `Action "${a.name}": ${a.description}. Animate exactly ${segment.frameCount} frames: global frames ${segment.frameStart + 1}–${segment.frameStart + segment.frameCount} of ${segment.totalFrames}. ${segment.index ? "" : "Begin the action at its initial phase. "}${a.loop ? "This is part of one smooth loop; the final global frame must transition back to the first." : "Show the action progressing from its beginning to its end."}`,
      `Every frame uses the same fixed camera, the same body scale and the same ground line${pivot ? ` (feet at ${Math.round((pivot.pivotY / pivot.renderSpec.logicalHeight) * 100)}% of the frame height)` : ""}. Preserve intentional travel, crouching and jumping; never recenter or refit individual frames. Keep complete limbs and props inside every frame with a small margin.`,
      c.renderSpec?.mode === "pixel"
        ? "Pixel-art style with crisp, deliberate pixels and no blur or antialiasing."
        : "Preserve clean illustration contours and materials.",
      c.background === "chroma"
        ? `Perfectly flat ${c.chromaKey} background in every frame; never use the key color on the character.`
        : "Transparent background in every frame.",
      "No labels, text, borders, grids, scene, floor shadows or detached effects.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return `${creative}\nRequested image size: ${c.parameters.size ?? "auto"}.\n${c.references.map((r, i) => `Reference ${i + 1}: ${r.purpose || r.role}. ${i === 0 ? "Authoritative identity: preserve face, palette, proportions, materials, clothing and props." : "Use only for its stated purpose; preserve the main character identity."}`).join("\n")}\nCreate one complete static sprite image of the requested subject.\n${c.background === "chroma" ? `Perfectly flat ${c.chromaKey} background; avoid this color on the character.` : "Transparent background."} No labels, borders, text, scene, floor shadows or detached effects.`;
}
export function spritePlanIssues(c: SpritePlanConfiguration): string[] {
  const l = spritePlanLayout(c),
    issues: string[] = [];
  if (!spritePlanForRevision(c).prompt.trim()) issues.push("Enter generation requirements.");
  issues.push(...spritePromptConflicts(c));
  if (!c.providerId || !c.model) issues.push("Select a Drawing model.");
  if (!l.actions.length) issues.push("Select at least one action.");
  if (c.workflowVersion === 2) {
    try {
      if (!c.renderSpec) throw new Error("Choose a sprite rendering mode.");
      const size = spriteOutputSize(c.renderSpec);
      if (size.width !== c.width || size.height !== c.height)
        issues.push("Output dimensions do not match the render specification.");
      if (c.kind === "animation" && !c.canonical)
        issues.push("Confirm the character reference before generating actions.");
      if (
        c.kind === "animation" &&
        c.canonical &&
        c.renderSpec &&
        (c.canonical.renderSpec.mode !== c.renderSpec.mode ||
          c.canonical.renderSpec.logicalWidth !== c.renderSpec.logicalWidth ||
          c.canonical.renderSpec.logicalHeight !== c.renderSpec.logicalHeight)
      )
        issues.push("Character reference changed. Prepare a new plan.");
      if (
        c.kind === "animation" &&
        c.canonical &&
        c.references[0]?.asset.id !== spriteGenerationReference(c.canonical).id
      )
        issues.push("The approved character must be the first reference.");
    } catch (e) {
      issues.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (c.kind === "animation" && c.workflowVersion !== 2)
    issues.push(
      "Sprite sheets are no longer generated. Confirm a character reference to generate actions as GIFs.",
    );
  if (c.kind === "animation" && l.actions.some((a) => a.frameCount < 2))
    issues.push("Each action needs at least 2 frames for GIF generation.");
  if (c.kind === "animation" && !c.references.length)
    issues.push("Add a reference image before generating animation.");
  if (new Set(c.actions.map((a) => a.id)).size !== c.actions.length)
    issues.push("Action IDs must be unique.");
  if (l.actions.some((a) => !a.name.trim())) issues.push("Enter an action name.");
  if (c.references.some((r) => r.actionId && !c.actions.some((a) => a.id === r.actionId)))
    issues.push("A reference points to an unavailable action.");
  if (new Set(c.references.map((r) => r.asset.id)).size !== c.references.length)
    issues.push("Choose each reference image only once.");
  if (l.columns * l.rows > 1024) issues.push("The layout exceeds 1024 cells.");
  if (c.width * c.height * l.frames > 64_000_000)
    issues.push("Generated frames exceed 64 megapixels.");
  if (c.parameters.n !== 1) issues.push("Each sprite task must generate one image.");
  if (
    c.background === "transparent" &&
    c.kind === "character" &&
    !["png", "webp"].includes(c.parameters.outputFormat ?? "png")
  )
    issues.push("Transparent backgrounds require PNG or WebP.");
  if (c.references.some((r) => r.actionId && r.role !== "pose"))
    issues.push("Only pose references may target an action.");
  let tasks: SpritePlanConfiguration[] = [];
  try {
    tasks = spritePlanTasks(c);
  } catch (e) {
    issues.push(e instanceof Error ? e.message : String(e));
  }
  for (const task of tasks) {
    if (task.workflowVersion === 2 && task.references.length + (task.segment?.index ? 2 : 0) > 16)
      issues.push(
        "Too many references for this action segment. Reserve space for the previous frames.",
      );
    if (spritePlanPrompt(task).length > 32000) {
      issues.push("Generation requirements exceed the prompt limit.");
      break;
    }
    if (
      task.references.some((r) => r.asset.bytes > 20 * 1024 * 1024) ||
      task.references.reduce((n, r) => n + r.asset.bytes, 0) > 79 * 1024 * 1024
    ) {
      issues.push("Reference images exceed the task size limit.");
      break;
    }
  }
  return issues;
}
export function compileSpritePlan(c: SpritePlanConfiguration) {
  return spritePlanTasks(c).map((task) => {
    const layout = spritePlanLayout(task);
    return {
      prompt: spritePlanPrompt(task),
      rows: layout.rows,
      columns: layout.columns,
      actionIds: layout.actions.map((a) => a.id),
      referenceAssetIds: task.references.map((r) => r.asset.id),
    };
  });
}
