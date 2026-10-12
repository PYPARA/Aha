import { describe, expect, it } from "vitest";
import {
  normalizeDrawingParameters,
  updateDrawingParameters,
  drawingParameterLabel,
} from "./drawingParameters";
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
  it("distinguishes omitted historical values from automatic values", () => {
    expect(drawingParameterLabel(undefined, (v) => v)).toBe("Not specified");
    expect(drawingParameterLabel("auto", (v) => v)).toBe("Auto");
  });
});
