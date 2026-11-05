import {
  IMAGE_GIF_FRAME_COUNT,
  IMAGE_GIF_FRAME_DURATION_MS,
  type ImageGenerationParameters,
} from "@synara/contracts";
import { normalizeImageSize } from "./imageSize";

/** A field set to undefined is cleared (e.g. complexity back to automatic). */
export type DrawingParameterPatch = {
  [K in keyof ImageGenerationParameters]?: ImageGenerationParameters[K] | undefined;
};

export const defaultDrawingParameters = {
  size: "auto",
  quality: "auto",
  n: 1,
  outputFormat: "png",
  background: "auto",
} satisfies ImageGenerationParameters;

/** Frame settings exist only while GIF is selected; other formats never carry them. */
function withFrameSettings(parameters: ImageGenerationParameters): ImageGenerationParameters {
  const { frameCount, frameDurationMs, ...rest } = parameters;
  if (parameters.outputFormat !== "gif") return rest;
  return {
    ...rest,
    frameCount: frameCount ?? IMAGE_GIF_FRAME_COUNT.default,
    frameDurationMs: frameDurationMs ?? IMAGE_GIF_FRAME_DURATION_MS.default,
  };
}

export function normalizeDrawingParameters(p: ImageGenerationParameters = { n: 1 }) {
  let outputFormat = p.outputFormat ?? defaultDrawingParameters.outputFormat,
    background = p.background ?? defaultDrawingParameters.background;
  if (background === "transparent" && outputFormat === "jpeg") outputFormat = "png";
  const parameters = withFrameSettings({
    ...p,
    size: p.size ?? defaultDrawingParameters.size,
    quality: p.quality ?? defaultDrawingParameters.quality,
    outputFormat,
    background,
  });
  const keys = new Set([...Object.keys(p), ...Object.keys(parameters)]);
  const adjusted = [...keys].some(
    (key) => p[key as keyof typeof p] !== parameters[key as keyof typeof parameters],
  );
  return { parameters, adjusted };
}

/** Merges a parameter patch; fields patched to undefined are removed. */
export function applyDrawingParameterPatch<T extends Partial<ImageGenerationParameters>>(
  base: T,
  patch: DrawingParameterPatch,
): T {
  const merged: Record<string, unknown> = { ...base, ...patch };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return merged as T;
}
export function updateDrawingParameters(
  p: ImageGenerationParameters,
  patch: DrawingParameterPatch,
) {
  const next = applyDrawingParameterPatch(p, patch) as {
    -readonly [K in keyof ImageGenerationParameters]: ImageGenerationParameters[K];
  };
  let notice: string | null = null;
  if (next.background === "transparent" && next.outputFormat === "jpeg") {
    if (patch.outputFormat === "jpeg") {
      next.background = "opaque";
      notice = "JPEG does not support transparency. Background changed to opaque.";
    } else {
      next.outputFormat = "png";
      notice = "Output format changed to PNG for transparent background.";
    }
  }
  // GIF sizes are per frame and may sit below the still-image pixel minimum.
  if (
    p.outputFormat === "gif" &&
    next.outputFormat !== "gif" &&
    next.size &&
    next.size !== "auto"
  ) {
    const still = normalizeImageSize(next.size);
    if (still !== next.size) {
      next.size = still;
      notice = "Frame size was enlarged to fit still-image limits.";
    }
  }
  return { parameters: normalizeDrawingParameters(next).parameters, notice };
}

/** Shortcuts within the official 2–64 frames and 20–2000 ms; any value in range can be typed. */
export const drawingFrameCountOptions = [2, 4, 6, 8, 9, 12, 16, 24, 32, 48, 64] as const;
export const drawingFrameDurationOptions = [
  20, 40, 60, 80, 100, 120, 150, 200, 300, 500, 1000, 2000,
] as const;

export const drawingParameterLabels: Record<string, string> = {
  auto: "Auto",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
  opaque: "Opaque",
  transparent: "Transparent",
};
export function drawingParameterLabel(value: string | undefined, tr: (text: string) => string) {
  return value === undefined ? tr("Not specified") : tr(drawingParameterLabels[value] ?? value);
}
export function drawingFormatLabel(format: ImageGenerationParameters["outputFormat"]) {
  return format === "webp" ? "WebP" : format === "gif" ? "GIF" : format?.toUpperCase();
}
