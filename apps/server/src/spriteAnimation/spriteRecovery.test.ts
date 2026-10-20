import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Schema } from "effect";
import {
  SpriteState,
  type SpriteContext,
  type SpriteRun,
  type ImageAsset,
} from "@synara/contracts";
import { SpriteEngine } from "./spriteEngine";
import type { ImageGenerationEngine } from "../imageGeneration/imageGenerationEngine";
import { recoverSpriteState, spriteImportOrigin } from "./spriteRecovery";
const roots: string[] = [];
afterEach(() => Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))));
const context: SpriteContext = {
  projectId: "project",
  threadId: null,
  name: "Test",
  providerId: "",
  model: "",
  referenceAssetId: null,
  action: "idle",
  frameCount: 8,
  fps: 12,
  width: 256,
  height: 256,
  background: "transparent",
  chromaKey: "#00ff00",
};
const asset: ImageAsset = {
  id: "source-1",
  name: "sheet.png",
  mimeType: "image/png",
  url: "/sheet.png",
  thumbnailUrl: "/sheet.png",
  width: 1024,
  height: 512,
  bytes: 100,
  createdAt: "2026-10-20",
};
const imported: SpriteRun = {
  id: "imported",
  context,
  input: { requestId: "source:source-1", kind: "animation", prompt: "Imported source slicing" },
  jobId: null,
  imageStatus: "imported",
  status: "ready",
  source: asset,
  frames: [],
  candidates: [],
  warnings: [],
  error: null,
  createdAt: "2026-10-20",
};
it("only migrates verified local imports, retaining the original identity for diagnostics", () => {
  const result = recoverSpriteState("project", { context, runs: [imported] }, new Set([asset.id]));
  expect(result.diagnostics).toEqual([]);
  expect(result.migrated).toBe(true);
  const run = result.state.runs[0]!;
  expect(run.input.requestId).toMatch(/^import-[a-f0-9]{64}$/);
  expect(run.importOrigin?.legacyRequestId).toBe(imported.input.requestId);
  expect(
    recoverSpriteState(
      "project",
      { context, runs: [{ ...imported, jobId: "job" }] },
      new Set([asset.id]),
    ).state.runs,
  ).toEqual([]);
  expect(
    recoverSpriteState("project", { context, runs: [imported] }, new Set()).diagnostics,
  ).toHaveLength(1);
});
it("backs up before migration, validates persisted state and survives a cold restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aha-sprite-recover-"));
  roots.push(root);
  const raw = JSON.stringify({ context, runs: [imported] });
  await writeFile(path.join(root, "project.json"), raw);
  const images = {
    spriteAssetIds: new Set<string>(),
    spriteRecoveryProjects: new Set<string>(),
    getAsset: async () => asset,
  };
  const create = () =>
    new SpriteEngine(root, images as unknown as ImageGenerationEngine, async () => {});
  const engine = create();
  await engine.initialize();
  const first = await engine.command({ operation: "get", projectId: "project" });
  expect(first.runs).toHaveLength(1);
  expect(first.recovery?.readOnly).toBe(false);
  const backups = (await readdir(root)).filter((p) => p.endsWith(".bak"));
  expect(backups).toHaveLength(1);
  expect(await readFile(path.join(root, backups[0]!), "utf8")).toBe(raw);
  Schema.decodeUnknownSync(SpriteState)(
    JSON.parse(await readFile(path.join(root, "project.json"), "utf8")),
  );
  const restart = create();
  await restart.initialize();
  expect(
    (await restart.command({ operation: "get", projectId: "project" })).runs[0]!.input.requestId,
  ).toBe(first.runs[0]!.input.requestId);
});
it("keeps readable siblings, protects unknown references and forbids overwriting partial state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aha-sprite-partial-"));
  roots.push(root);
  const valid = { ...imported, id: "valid", input: { ...imported.input, requestId: "valid" } };
  const raw = JSON.stringify({
    context,
    runs: [valid, { ...imported, source: { ...asset, id: "unknown" } }],
  });
  await writeFile(path.join(root, "project.json"), raw);
  const images = {
    spriteAssetIds: new Set<string>(),
    spriteRecoveryProjects: new Set<string>(),
    getAsset: vi.fn(async () => asset),
  };
  const engine = new SpriteEngine(root, images as unknown as ImageGenerationEngine, async () => {});
  await engine.initialize();
  await engine.tick();
  const state = await engine.command({ operation: "get", projectId: "project" });
  expect(state.runs.map((r) => r.id)).toEqual(["valid"]);
  expect(state.recovery?.readOnly).toBe(true);
  expect(images.spriteAssetIds.has("unknown")).toBe(true);
  expect(images.spriteRecoveryProjects.has("project")).toBe(true);
  await expect(
    engine.command({ operation: "sync", projectId: "project", context }),
  ).rejects.toThrow("partially recovered");
  expect(await readFile(path.join(root, "project.json"), "utf8")).toBe(raw);
  await writeFile(path.join(root, "project.json"), JSON.stringify({ context, runs: [valid] }));
  expect(
    (await engine.command({ operation: "get", projectId: "project", reload: true })).runs,
  ).toHaveLength(1);
  expect(images.spriteRecoveryProjects.size).toBe(0);
});
it("scopes import identity to project, stable target and branch, not crop parameters", () => {
  const base = spriteImportOrigin("project", asset.id, { context });
  expect(spriteImportOrigin("project", asset.id, { context })).toEqual(base);
  expect(spriteImportOrigin("other", asset.id, { context }).requestId).not.toBe(base.requestId);
  expect(
    spriteImportOrigin("project", asset.id, { context, importBranchId: "fork" }).requestId,
  ).not.toBe(base.requestId);
  expect(
    spriteImportOrigin("project", asset.id, {
      context: { ...context, selection: { phase: "actions", actionId: "walk" } },
    }).requestId,
  ).not.toBe(base.requestId);
});

it("preserves the last valid cached results if an explicit reload encounters an unreadable file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aha-sprite-stale-"));
  roots.push(root);
  const valid = { ...imported, input: { ...imported.input, requestId: "valid" } };
  await writeFile(path.join(root, "project.json"), JSON.stringify({ context, runs: [valid] }));
  const images = {
    spriteAssetIds: new Set<string>(),
    spriteRecoveryProjects: new Set<string>(),
    getAsset: async () => asset,
  };
  const engine = new SpriteEngine(root, images as unknown as ImageGenerationEngine, async () => {});
  await engine.initialize();
  await writeFile(path.join(root, "project.json"), "{broken");
  const result = await engine.command({ operation: "get", projectId: "project", reload: true });
  expect(result.recovery).toMatchObject({ status: "failed", readOnly: true });
  expect(result.runs[0]!.id).toBe("imported");
  expect(await readFile(path.join(root, "project.json"), "utf8")).toBe("{broken");
});
