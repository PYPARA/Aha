import { normalizeImageSize } from "./imageSize";
import type { SpritePlanConfiguration, SpritePlanAction } from "./spriteAnimation";
import {
  spriteWorkflowTasks,
  spriteOutputSize,
  spriteSegmentLayout,
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
    let planned = c.layout;
    try {
      if (!planned && actions[0])
        planned = spriteSegmentLayout(c, actions[0], 0, Math.min(8, actions[0].frameCount));
    } catch {
      /* Draft errors are reported by spritePlanIssues. */
    }
    return {
      actions,
      columns: planned?.columns ?? Math.min(4, Math.max(1, ...actions.map((a) => a.frameCount))),
      rows: planned?.rows ?? 1,
      frames,
      empty: planned ? planned.cells.filter((cell) => !cell.actionId).length : 0,
      jobs: c.segment ? 1 : actions.reduce((n, a) => n + Math.ceil(a.frameCount / 8), 0),
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
    const layout =
      c.layout &&
      (c.parameters.size === `${c.layout.width}x${c.layout.height}` || c.parameters.size === "auto")
        ? c.layout
        : spriteSegmentLayout(c, action, segment.frameStart, segment.frameCount);
    return [
      {
        ...c,
        layout,
        parameters: {
          ...c.parameters,
          n: 1,
          size:
            c.sizing?.mode === "model" || (!c.sizing && c.sizeSource === "auto")
              ? "auto"
              : `${layout.width}x${layout.height}`,
        },
      },
    ];
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
        layout = task.layout!,
        cell = layout.cells[0]!;
      return {
        width: layout.width,
        height: layout.height,
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
  const l = spritePlanLayout(c);
  const creative = spritePlanForRevision(c).prompt;
  if (c.workflowVersion === 2 && c.kind === "animation") {
    const task = c.segment ? c : spriteWorkflowTasks(c)[0];
    if (!task?.segment || !task.layout) return creative;
    const a = task.actions[0]!,
      segment = task.segment,
      layout = task.layout;
    const pivot = c.canonical;
    return `${creative}\nCreate one coherent animation segment of the SAME character shown in Reference 1. Preserve its face, proportions, style, palette, materials, clothing and props.\n${task.references.map((r, i) => `Reference ${i + 1}: ${i === 0 ? "authoritative approved character identity" : r.purpose || r.role}.`).join("\n")}\nThe LAST reference is a layout-only construction guide. Never draw its lines, boxes, guide colors or ground marks.\nAction "${a.name}": ${a.description}. Generate exactly ${segment.frameCount} poses: global frames ${segment.frameStart + 1}–${segment.frameStart + segment.frameCount} of ${segment.totalFrames}. ${segment.index ? "The preceding references include the previous segment ending; continue its cadence without repeating those frames." : "Begin the action at its initial phase."} ${a.loop ? "This is part of one smooth loop; the final global frame must transition back to the first." : "Show the action progressing from its beginning to its end."}\nUse ${layout.rows} physical rows and ${layout.columns} columns, read left to right then top to bottom.\n${layout.cells.map((cell, i) => `Slot ${i + 1}: ${cell.frameIndex === null ? "empty background only" : `global frame ${cell.frameIndex + 1}`}, region (${cell.x},${cell.y},${cell.width},${cell.height}).`).join("\n")}\nKeep a fixed camera, one shared body scale and the reference ground coordinate in every slot${pivot ? ` (baseline ${Math.round((pivot.pivotY / pivot.renderSpec.logicalHeight) * 100)}% of slot height)` : ""}. Preserve intentional vertical motion, crouching and jumping; never independently recenter or refit poses. Keep complete limbs and props inside the safe area.\n${c.renderSpec?.mode === "pixel" ? "Pixel-art style with crisp, deliberate pixels and no blur or antialiasing." : "Preserve clean illustration contours and materials."}\n${c.background === "chroma" ? `Perfectly flat ${c.chromaKey} background, including empty slots; never use the key color on the character.` : "Transparent background including empty slots."} No labels, visible grids, text, scene, floor shadows or detached effects.`;
  }
  return `${creative}\nRequested whole image size: ${c.parameters.size ?? "auto"}.\n${c.references.map((r, i) => `Reference ${i + 1}: ${r.purpose || r.role}${r.actionId ? ` for action ${c.actions.find((a) => a.id === r.actionId)?.name}` : " for all actions"}. ${i === 0 ? "Authoritative identity: preserve face, palette, proportions, materials, clothing and props." : "Use only for its stated purpose; preserve the main character identity."}`).join("\n")}\n${c.kind === "character" ? "Create one complete static sprite image of the requested subject." : `Create ONE sprite sheet with exactly ${l.rows} equal-height rows and ${l.columns} equal-width columns. Fill the entire sheet with these cells, with no additional blank columns or outer margins. Place exactly ONE complete pose in each valid cell. Read top to bottom, then left to right. The LAST reference is layout only; never reproduce its grid.\n${l.actions.map((a, i) => `Row ${i + 1}: action "${a.name}": ${a.description}. Exactly ${a.frameCount} consecutive frames in the first ${a.frameCount} cells; leave the remaining ${l.columns - a.frameCount} cells completely empty. ${a.loop ? "Complete a smooth looping cycle." : "Show the action from beginning to end."}`).join("\n")}\nKeep every whole-body pose in its cell with 10% safe padding. Use a fixed camera, shared scale and ground coordinate. Preserve intentional vertical movement.`}\n${c.background === "chroma" ? `Perfectly flat ${c.chromaKey} background, including unused cells; avoid this color on the character.` : "Transparent background, including unused cells."} No labels, borders, text, scene, floor shadows, detached effects or visible grid.`;
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
    if (task.workflowVersion === 2 && task.references.length + (task.segment?.index ? 3 : 1) > 16)
      issues.push(
        "Too many references for this action segment. Reserve space for the layout and previous frames.",
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
/** The same bounded layout guide is shown in the card and sent to Drawing. */
export function spriteLayoutGuideSvg(
  columns: number,
  rows = 1,
  size?: string,
  frameWidth = 1,
  frameHeight = 1,
  counts?: readonly number[],
) {
  const dimensions = size?.match(/^(\d+)x(\d+)$/);
  const ratio = dimensions
    ? Number(dimensions[2]) / Number(dimensions[1])
    : (rows * frameHeight) / (columns * frameWidth);
  const width = Math.max(1, Math.min(1536, Math.floor(2048 / ratio))),
    height = Math.max(1, Math.round(width * ratio));
  const padding = Math.min(8, width / columns / 10, height / rows / 10);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/>${Array.from({ length: columns * rows }, (_, i) => `<rect x="${((i % columns) * width) / columns + padding}" y="${(Math.floor(i / columns) * height) / rows + padding}" width="${width / columns - 2 * padding}" height="${height / rows - 2 * padding}" fill="${counts && i % columns >= counts[Math.floor(i / columns)]! ? "#d1d5db" : "#ffffff"}" stroke="#999"/>`).join("")}</svg>`;
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
