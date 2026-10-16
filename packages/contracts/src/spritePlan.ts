import { normalizeImageSize } from "./imageSize";
import type { SpritePlanConfiguration, SpritePlanAction } from "./spriteAnimation";

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
  const actions = spritePlanActions(c);
  return (
    c.kind === "character" || c.mode === "combined" ? [actions] : actions.map((a) => [a])
  ).map((group) => spriteTaskConfiguration(c, group));
}
export function spriteRecommendedSize(c: SpritePlanConfiguration): string {
  const l = spritePlanLayout(c);
  return normalizeImageSize(
    `${l.columns * c.width}x${(c.mode === "separate" ? 1 : l.rows) * c.height}`,
  );
}
export function spriteSizeSummary(c: SpritePlanConfiguration) {
  const l = spritePlanLayout(c),
    match = c.parameters.size?.match(/^(\d+)x(\d+)$/);
  return match
    ? {
        width: Number(match[1]),
        height: Number(match[2]),
        cellWidth: Number(match[1]) / l.columns,
        cellHeight: Number(match[2]) / (c.mode === "separate" ? 1 : l.rows),
        scale: Math.max(
          c.width / (Number(match[1]) / l.columns),
          c.height / (Number(match[2]) / (c.mode === "separate" ? 1 : l.rows)),
        ),
      }
    : null;
}
export function spritePlanPrompt(c: SpritePlanConfiguration): string {
  const l = spritePlanLayout(c);
  const creative = spritePlanForRevision(c).prompt;
  return `${creative}\nRequested whole image size: ${c.parameters.size ?? "auto"}.\n${c.references.map((r, i) => `Reference ${i + 1}: ${r.purpose || r.role}${r.actionId ? ` for action ${c.actions.find((a) => a.id === r.actionId)?.name}` : " for all actions"}. ${i === 0 ? "Authoritative identity: preserve face, palette, proportions, materials, clothing and props." : "Use only for its stated purpose; preserve the main character identity."}`).join("\n")}\n${c.kind === "character" ? "Create one complete static sprite image of the requested subject." : `Create ONE sprite sheet with exactly ${l.rows} equal-height rows and ${l.columns} equal-width columns. Fill the entire sheet with these cells, with no additional blank columns or outer margins. Place exactly ONE complete pose in each valid cell. Read top to bottom, then left to right. The LAST reference is layout only; never reproduce its grid.\n${l.actions.map((a, i) => `Row ${i + 1}: action "${a.name}": ${a.description}. Exactly ${a.frameCount} consecutive frames in the first ${a.frameCount} cells; leave the remaining ${l.columns - a.frameCount} cells completely empty. ${a.loop ? "Complete a smooth looping cycle." : "Show the action from beginning to end."}`).join("\n")}\nKeep every whole-body pose in its cell with 10% safe padding. Use a fixed camera, shared scale and ground coordinate. Preserve intentional vertical movement.`}\n${c.background === "chroma" ? `Perfectly flat ${c.chromaKey} background, including unused cells; avoid this color on the character.` : "Transparent background, including unused cells."} No labels, borders, text, scene, floor shadows, detached effects or visible grid.`;
}
export function spritePlanIssues(c: SpritePlanConfiguration): string[] {
  const l = spritePlanLayout(c),
    issues: string[] = [];
  if (!spritePlanForRevision(c).prompt.trim()) issues.push("Enter generation requirements.");
  issues.push(...spritePromptConflicts(c));
  if (!c.providerId || !c.model) issues.push("Select a Drawing model.");
  if (!l.actions.length) issues.push("Select at least one action.");
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
  for (const task of spritePlanTasks(c)) {
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
