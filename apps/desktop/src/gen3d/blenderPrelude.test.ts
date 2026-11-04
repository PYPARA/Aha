import { describe, expect, it } from "vitest";
import { GEN3D_BLENDER_PRELUDE, mapBlenderError } from "./blenderPrelude";
import { BLENDER_SOURCE_CHECK } from "../model3d/blender";

const preludeLines = GEN3D_BLENDER_PRELUDE.split("\n").length - 1;

describe("gen3d Blender prelude", () => {
  it("avoids every name the workshop source policy rejects", () => {
    const denied = BLENDER_SOURCE_CHECK.match(/denied = \{([^}]+)\}/)![1]!
      .split(",")
      .map((name) => name.trim().replace(/^'|'$/g, ""));
    const words = GEN3D_BLENDER_PRELUDE.match(/[A-Za-z_][A-Za-z0-9_]*/g)!;
    expect(words.filter((w) => denied.includes(w) || /^(export_|import_|__)/.test(w))).toEqual([]);
  });

  it("maps policy and runtime line numbers into the AI source", () => {
    expect(
      mapBlenderError(
        `ValueError: Aha modeling source cannot read/write model files (line ${preludeLines + 3}).`,
      ),
    ).toContain("(line 3 of your source)");
    expect(
      mapBlenderError(`File "<string>", line ${preludeLines + 2 + 5}, in <module>\nboom`),
    ).toContain("line 5 of your source");
    expect(
      mapBlenderError(
        `"traceback": "  File \\"<string>\\", line ${preludeLines + 2 + 3}, in <module>"`,
      ),
    ).toContain("line 3 of your source");
    // Lines inside Aha's own code are left alone.
    expect(mapBlenderError('File "<string>", line 4, in <module>')).toContain("line 4,");
  });
});
