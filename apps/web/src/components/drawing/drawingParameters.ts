import type { ImageGenerationParameters } from "@synara/contracts";

export const defaultDrawingParameters = {
  size: "auto",
  quality: "auto",
  n: 1,
  outputFormat: "png",
  background: "auto",
} satisfies ImageGenerationParameters;

export function normalizeDrawingParameters(p: ImageGenerationParameters = { n: 1 }) {
  const parameters = {
    ...p,
    size: p.size ?? defaultDrawingParameters.size,
    quality: p.quality ?? defaultDrawingParameters.quality,
    outputFormat: p.outputFormat ?? defaultDrawingParameters.outputFormat,
    background: p.background ?? defaultDrawingParameters.background,
  };
  if (parameters.background === "transparent" && parameters.outputFormat === "jpeg")
    parameters.outputFormat = "png";
  const adjusted = Object.entries(parameters).some(
    ([key, value]) => p[key as keyof typeof p] !== value,
  );
  return { parameters, adjusted };
}

export function updateDrawingParameters(
  p: ImageGenerationParameters,
  patch: Partial<ImageGenerationParameters>,
) {
  const next = { ...p, ...patch };
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
  return { parameters: normalizeDrawingParameters(next).parameters, notice };
}

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
