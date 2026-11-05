import { describe, expect, it } from "vitest";
import {
  normalizeDrawingParameters,
  updateDrawingParameters,
  drawingParameterLabel,
  drawingFrameCountOptions,
  drawingFrameDurationOptions,
} from "./drawingParameters";
import { calculateImageSize, IMAGE_FRAME_MIN_PIXELS, normalizeImageSize } from "./imageSize";
import { gifSheetNotice } from "./DrawingSizePicker";
describe("drawing parameter intent", () => {
  it("fills missing legacy fields without changing explicit sizes or the source snapshot", () => {
    const old = { n: 3, size: "1234x567", quality: "max" as const };
    expect(normalizeDrawingParameters(old)).toEqual({
      parameters: { ...old, outputFormat: "png", background: "auto" },
      adjusted: true,
    });
    expect(old).toEqual({ n: 3, size: "1234x567", quality: "max" });
    expect(normalizeDrawingParameters().parameters).toEqual({
      size: "auto",
      quality: "auto",
      n: 1,
      outputFormat: "png",
      background: "auto",
    });
    expect(normalizeDrawingParameters(normalizeDrawingParameters().parameters).adjusted).toBe(
      false,
    );
  });
  it("honors the latest explicit choice for incompatible background and format", () => {
    const jpeg = { ...normalizeDrawingParameters().parameters, outputFormat: "jpeg" as const };
    const transparent = updateDrawingParameters(jpeg, { background: "transparent" });
    expect(transparent.parameters).toMatchObject({
      background: "transparent",
      outputFormat: "png",
    });
    expect(transparent.notice).toBeTruthy();
    expect(
      updateDrawingParameters(transparent.parameters, { outputFormat: "jpeg" }).parameters,
    ).toMatchObject({ background: "opaque", outputFormat: "jpeg" });
    expect(
      updateDrawingParameters({ ...jpeg, outputFormat: "webp" }, { background: "transparent" }),
    ).toMatchObject({
      parameters: { background: "transparent", outputFormat: "webp" },
      notice: null,
    });
    expect(
      normalizeDrawingParameters({ ...jpeg, background: "transparent" }).parameters.outputFormat,
    ).toBe("png");
  });
  it("adds GIF frame defaults only while GIF is selected and allows transparent GIF", () => {
    const base = normalizeDrawingParameters().parameters;
    const gif = updateDrawingParameters(base, { outputFormat: "gif" });
    expect(gif.parameters).toMatchObject({
      outputFormat: "gif",
      frameCount: 9,
      frameDurationMs: 200,
    });
    expect(gif.notice).toBeNull();
    const back = updateDrawingParameters(
      { ...gif.parameters, frameCount: 16 },
      { outputFormat: "webp" },
    );
    expect(back.parameters).not.toHaveProperty("frameCount");
    expect(back.parameters).not.toHaveProperty("frameDurationMs");
    const transparent = updateDrawingParameters(
      { ...base, background: "transparent" },
      { outputFormat: "gif" },
    );
    expect(transparent.parameters).toMatchObject({
      outputFormat: "gif",
      background: "transparent",
      frameCount: 9,
    });
    expect(transparent.notice).toBeNull();
    expect(
      updateDrawingParameters(gif.parameters, { background: "transparent" }).parameters,
    ).toMatchObject({ outputFormat: "gif", background: "transparent" });
    expect(normalizeDrawingParameters(gif.parameters).adjusted).toBe(false);
    expect(normalizeDrawingParameters({ ...base, frameCount: 9 }).adjusted).toBe(true);
  });
  it("clears complexity back to automatic and keeps GIF frame sizes below the still minimum", () => {
    const base = normalizeDrawingParameters().parameters;
    const low = updateDrawingParameters(base, { complexity: "low" }).parameters;
    expect(low.complexity).toBe("low");
    expect(updateDrawingParameters(low, { complexity: undefined }).parameters).not.toHaveProperty(
      "complexity",
    );
    const gif = updateDrawingParameters(base, { outputFormat: "gif", size: "512x512" });
    expect(gif.parameters.size).toBe("512x512");
    const still = updateDrawingParameters(gif.parameters, { outputFormat: "png" });
    expect(still.parameters.size).toBe("816x816");
    expect(still.notice).toMatch(/still-image/);
    expect(drawingFrameCountOptions.at(-1)).toBe(64);
    expect(drawingFrameDurationOptions[0]).toBe(20);
    expect(drawingFrameDurationOptions.at(-1)).toBe(2000);
  });
  it("sizes GIF frames by the frame rules and warns about the combined sheet", () => {
    expect(normalizeImageSize("512x512")).toBe("816x816");
    expect(normalizeImageSize("512x512", { minPixels: IMAGE_FRAME_MIN_PIXELS })).toBe("512x512");
    expect(normalizeImageSize("500x300", { minPixels: IMAGE_FRAME_MIN_PIXELS })).toBe("496x304");
    expect(calculateImageSize("512", "16:9", { minPixels: IMAGE_FRAME_MIN_PIXELS })).toBe(
      "640x352",
    );
    expect(calculateImageSize("1K", "1:1")).toBe("1024x1024");
    expect(gifSheetNotice("256x256", 4)).toMatch(/below the minimum/);
    expect(gifSheetNotice("512x512", 4)).toBeNull();
    expect(gifSheetNotice("1024x1024", 9)).toMatch(/exceed/);
    expect(gifSheetNotice("auto", 9)).toBeNull();
  });
  it("distinguishes omitted historical values from automatic values", () => {
    expect(drawingParameterLabel(undefined, (v) => v)).toBe("Not specified");
    expect(drawingParameterLabel("auto", (v) => v)).toBe("Auto");
  });
});
