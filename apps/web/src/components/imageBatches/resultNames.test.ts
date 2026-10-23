import { describe, expect, it } from "vitest";
import type { ImageBatchResult } from "@synara/contracts";
import { resultFileNames } from "./resultNames";

const result = (
  id: string,
  patch: Partial<ImageBatchResult> & { mimeType?: string } = {},
): ImageBatchResult => {
  const { mimeType = "image/png", ...rest } = patch;
  return {
    id,
    batchId: "batch",
    executionId: "execution",
    attemptId: "attempt-1",
    taskId: "task",
    taskName: "焰 · 先锋",
    position: 0,
    asset: {
      id: "a".repeat(64),
      name: "image",
      mimeType: mimeType as "image/png",
      url: "/asset",
      thumbnailUrl: "/asset?variant=thumbnail",
      width: 1,
      height: 1,
      bytes: 1,
      createdAt: "2026-10-23T00:00:00.000Z",
    },
    prompt: "prompt",
    model: "model",
    parameters: { n: 1 },
    createdAt: "2026-10-23T00:00:00.000Z",
    adopted: false,
    ...rest,
  } as ImageBatchResult;
};

describe("result delivery names", () => {
  it("gives the adopted candidate the exact name and numbers the rest", () => {
    const names = resultFileNames([
      result("one", { output: "heroes/ember.png", position: 0 }),
      result("two", { output: "heroes/ember.png", position: 1, adopted: true }),
      result("three", { output: "heroes/ember.png", position: 2 }),
    ]);
    expect(names.get("two")).toEqual({ name: "ember.png", folder: "heroes" });
    expect(names.get("one")).toEqual({ name: "ember-2.png", folder: "heroes" });
    expect(names.get("three")).toEqual({ name: "ember-3.png", folder: "heroes" });
  });
  it("numbers every candidate from 1 when none is adopted", () => {
    const names = resultFileNames([
      result("one", { output: "icon.png" }),
      result("two", { output: "icon.png", position: 1 }),
    ]);
    expect([...names.values()]).toEqual([{ name: "icon-1.png" }, { name: "icon-2.png" }]);
  });
  it("follows the actual image type and keeps legacy names without an output path", () => {
    const names = resultFileNames([
      result("jpeg", { output: "bg/far.png", mimeType: "image/jpeg", taskId: "bg", adopted: true }),
      result("jpg", {
        output: "bg/near.JPG",
        mimeType: "image/jpeg",
        taskId: "near",
        adopted: true,
      }),
      result("plain", { taskId: "plain" }),
    ]);
    expect(names.get("jpeg")).toEqual({ name: "far.jpg", folder: "bg" });
    expect(names.get("jpg")).toEqual({ name: "near.JPG", folder: "bg" });
    expect(names.get("plain")).toEqual({ name: "焰 · 先锋_attempt-_1.png" });
  });
});
describe("result size check", () => {
  it("reports the requested size only when the saved image differs", async () => {
    const { resultSizeMismatch } = await import("./resultNames");
    const r = result("one", { parameters: { n: 1, size: "1024x1536" } });
    expect(resultSizeMismatch({ ...r, asset: { ...r.asset, width: 832, height: 1248 } })).toBe(
      "1024×1536",
    );
    expect(resultSizeMismatch({ ...r, asset: { ...r.asset, width: 1024, height: 1536 } })).toBe(
      null,
    );
    expect(resultSizeMismatch(result("auto", { parameters: { n: 1, size: "auto" } }))).toBe(null);
  });
});
