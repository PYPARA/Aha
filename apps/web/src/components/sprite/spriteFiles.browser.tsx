import { describe, expect, it, vi } from "vitest";
import { unzipSync, strFromU8, zipSync, strToU8 } from "fflate";
import {
  decodeSpriteSource,
  exportSpriteAssets,
  exportSpriteProject,
  importSpriteProject,
  renderSpriteFrame,
  renderSpriteAtlasPreview,
} from "./spriteFiles";
import { newSpriteProject, sliceFrames } from "./spriteModel";
import {
  snapshotSpriteActions,
  spriteExportFileList,
  spriteExportFingerprint,
} from "./spriteWorkbenchModel";
import {
  saveSpriteProject,
  listSpriteProjects,
  getSpriteProject,
  deleteSpriteProject,
} from "./spriteStorage";
vi.mock("../drawing/useDrawing", () => ({
  drawingApi: () => ({ spriteCommand: async () => ({ context: null, runs: [] }) }),
}));
async function fixture() {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 16;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "red";
  ctx.fillRect(4, 8, 6, 6);
  ctx.fillStyle = "blue";
  ctx.fillRect(20, 2, 6, 6);
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
  const source = await decodeSpriteSource(blob, "test.png");
  const p = newSpriteProject();
  p.version = 1;
  p.renderSpec = undefined;
  p.width = 16;
  p.height = 16;
  p.sources = [source];
  p.threadIds = ["private-thread", "second-private-thread"];
  p.activeThreadId = "private-thread";
  p.providerId = "private-provider";
  p.actions[0]!.frames = sliceFrames(source, {
    mode: "grid",
    columns: 2,
    rows: 1,
    width: 16,
    height: 16,
    margin: 0,
    gap: 0,
  });
  return p;
}
describe("portable sprite exports in a real browser", () => {
  it("preserves v2 logical masters and approved geometry through an archive and integer rescaling", async () => {
    const logical = document.createElement("canvas");
    logical.width = 8;
    logical.height = 8;
    logical.getContext("2d")!.fillStyle = "red";
    logical.getContext("2d")!.fillRect(2, 2, 3, 4);
    const blob = await new Promise<Blob>((r) => logical.toBlob((b) => r(b!), "image/png"));
    const rendered = document.createElement("canvas");
    rendered.width = 32;
    rendered.height = 32;
    rendered.getContext("2d")!.imageSmoothingEnabled = false;
    rendered.getContext("2d")!.drawImage(logical, 0, 0, 32, 32);
    const frameBlob = await new Promise<Blob>((r) => rendered.toBlob((b) => r(b!), "image/png"));
    const p = newSpriteProject();
    p.renderSpec = { mode: "pixel", logicalWidth: 8, logicalHeight: 8, outputScale: 4 };
    p.width = 32;
    p.height = 32;
    const master = {
      ...(await decodeSpriteSource(blob, "master.png")),
      usage: "generated-master" as const,
    };
    const frame = {
      ...(await decodeSpriteSource(frameBlob, "frame.png")),
      masterSourceId: master.id,
      usage: "generated-frame" as const,
    };
    p.sources = [master, frame];
    p.actions[0]!.fps = 24;
    p.actions[0]!.loop = false;
    p.actions[0]!.frames = [
      {
        id: "frame",
        sourceId: frame.id,
        x: 0,
        y: 0,
        width: 32,
        height: 32,
        offsetX: 0,
        offsetY: 0,
      },
    ];
    const asset = {
      id: "canonical",
      name: "fox.png",
      mimeType: "image/png" as const,
      url: "/canonical",
      thumbnailUrl: "/canonical",
      bytes: frameBlob.size,
      width: 32,
      height: 32,
      createdAt: new Date().toISOString(),
    };
    p.canonical = {
      revision: "revision",
      source: asset,
      asset,
      renderSpec: p.renderSpec,
      registration: { scale: 1, offsetX: 0, offsetY: 0 },
      pivotX: 4,
      pivotY: 7,
      confirmedAt: asset.createdAt,
    };
    p.canonicalVersions = [{ ...p.canonical, revision: "previous" }, p.canonical];
    const actionId = p.actions[0]!.id;
    p.provenance = [
      {
        runId: "run",
        prompt: "jump",
        action: "jump",
        model: "model",
        providerId: "provider",
        localActionId: actionId,
        taskSnapshots: [
          {
            runId: "run",
            canonicalRevision: p.canonical.revision,
            renderSpec: p.renderSpec,
            segment: { actionId, frameStart: 0, frameCount: 1, totalFrames: 1, index: 0, count: 1 },
            layout: {
              width: 1024,
              height: 1024,
              columns: 1,
              rows: 1,
              cells: [{ actionId, frameIndex: 0, x: 0, y: 0, width: 1024, height: 1024 }],
            },
            sourceAssetId: "original",
            processingVersionId: "processing",
          },
        ],
      },
    ];
    const restored = await importSpriteProject(new File([await exportSpriteProject(p)], "v2.zip"));
    expect(restored.canonical).toEqual(p.canonical);
    expect(restored.canonicalVersions).toEqual(p.canonicalVersions);
    expect(restored.provenance).toEqual(p.provenance);
    expect(restored.sources[1]!.masterSourceId).toBe(master.id);
    expect(restored.renderSpec).toEqual(p.renderSpec);
    await saveSpriteProject(restored);
    const reopened = await getSpriteProject(restored.id);
    expect(reopened.sources[1]!.masterSourceId).toBe(master.id);
    expect(reopened.canonicalVersions).toEqual(p.canonicalVersions);
    expect(reopened.provenance).toEqual(p.provenance);
    restored.renderSpec = { ...restored.renderSpec!, outputScale: 8 };
    restored.width = 64;
    restored.height = 64;
    const output = await renderSpriteFrame(restored, restored.actions[0]!.frames[0]!);
    const pixels = output.getContext("2d")!.getImageData(0, 0, 64, 64).data;
    const trimmed = await renderSpriteFrame(restored, {
      ...restored.actions[0]!.frames[0]!,
      x: 4,
      y: 4,
      width: 24,
      height: 24,
    });
    expect(trimmed.getContext("2d")!.getImageData(0, 0, 64, 64).data).toEqual(pixels);
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++)
        expect(Array.from(pixels.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4))).toEqual(
          Array.from(
            pixels.slice(
              (Math.floor(y / 8) * 8 * 64 + Math.floor(x / 8) * 8) * 4,
              (Math.floor(y / 8) * 8 * 64 + Math.floor(x / 8) * 8) * 4 + 4,
            ),
          ),
        );
    const preview = await renderSpriteAtlasPreview(
      restored,
      [restored.actions[0]!.id],
      "combined",
      8,
      0,
    );
    expect(preview!.getContext("2d")!.getImageData(0, 0, 64, 64).data).toEqual(pixels);
    const files = unzipSync(
      new Uint8Array(
        await (
          await exportSpriteAssets(restored, [restored.actions[0]!.id], "combined", 8, 0)
        ).arrayBuffer(),
      ),
    );
    const metadata = JSON.parse(strFromU8(files["animation.json"]!));
    expect(metadata).toMatchObject({
      version: 2,
      width: 64,
      height: 64,
      pivot: { x: 32, y: 56 },
      actions: [{ fps: 24, loop: false }],
    });
    expect(metadata.actions[0].source.taskSnapshots).toEqual(p.provenance[0]!.taskSnapshots);
    await deleteSpriteProject(restored.id);
  });
  it("round trips editable projects without remote bindings and restores IndexedDB blobs", async () => {
    const p = await fixture();
    p.actions[0]!.frames[0]!.durationMs = 240;
    p.actionVersions = snapshotSpriteActions(p, [p.actions[0]!.id]);
    p.lastExport = {
      createdAt: new Date().toISOString(),
      actionIds: [p.actions[0]!.id],
      fingerprint: await spriteExportFingerprint(p, [p.actions[0]!.id]),
      mode: "combined",
      columns: 2,
      gap: 2,
      files: ["atlas.png", "animation.json"],
    };
    const blob = await exportSpriteProject(p);
    const restored = await importSpriteProject(new File([blob], "sprite.zip"));
    expect(restored.id).not.toBe(p.id);
    expect(restored.threadIds).toEqual([]);
    expect(restored.activeThreadId).toBeNull();
    expect(restored.providerId).toBe("");
    expect(restored.actions).toEqual(p.actions);
    expect(restored.actionVersions).toEqual(p.actionVersions);
    expect(restored.lastExport).toEqual(p.lastExport);
    expect(new Uint8Array(await restored.sources[0]!.blob.arrayBuffer())).toEqual(
      new Uint8Array(await p.sources[0]!.blob.arrayBuffer()),
    );
    await saveSpriteProject(restored);
    expect((await getSpriteProject(restored.id)).sources[0]!.blob.size).toBe(
      p.sources[0]!.blob.size,
    );
    await deleteSpriteProject(restored.id);
  });
  it("exports atlas rectangles and sequence pixels with matching alpha and motion", async () => {
    const p = await fixture();
    p.actions[0]!.frames[1]!.durationMs = 230;
    for (const mode of ["combined", "atlas", "sequence"] as const) {
      const blob = await exportSpriteAssets(p, [p.actions[0]!.id], mode, 2, 2);
      const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
      expect(Object.keys(files).toSorted()).toEqual(
        spriteExportFileList(p, [p.actions[0]!.id], mode).toSorted(),
      );
      const metadata = JSON.parse(strFromU8(files["animation.json"]!));
      expect(metadata.actions[0].frames).toHaveLength(2);
      expect(metadata.actions[0].frames[0].durationMs).toBeCloseTo(1000 / 12);
      expect(metadata.actions[0].frames[1].durationMs).toBe(230);
      const filename =
        mode !== "sequence" ? metadata.actions[0].image : metadata.actions[0].frames[1].file;
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(files[filename]!)], { type: "image/png" }),
      );
      const c = document.createElement("canvas");
      c.width = bitmap.width;
      c.height = bitmap.height;
      c.getContext("2d")!.drawImage(bitmap, 0, 0);
      bitmap.close();
      const ctx = c.getContext("2d")!;
      const preview = await renderSpriteAtlasPreview(p, [p.actions[0]!.id], mode, 2, 2);
      if (mode !== "sequence")
        expect(
          preview!.getContext("2d")!.getImageData(0, 0, preview!.width, preview!.height).data,
        ).toEqual(ctx.getImageData(0, 0, c.width, c.height).data);
      const offset = mode !== "sequence" ? 18 : 0;
      expect([...ctx.getImageData(offset + 4, 2, 1, 1).data]).toEqual([0, 0, 255, 255]);
      expect(ctx.getImageData(offset, 0, 1, 1).data[3]).toBe(0);
      if (mode !== "sequence") {
        expect(c.width).toBe(34);
        expect(metadata.actions[0].frames[1].x).toBe(18);
        expect(ctx.getImageData(16, 8, 1, 1).data[3]).toBe(0);
      }
    }
  });
  it("combines unequal actions in separate rows with absolute rectangles and transparent gaps", async () => {
    const p = await fixture();
    const [red, blue] = p.actions[0]!.frames;
    p.actions[0]!.frames = [red!, blue!, red!];
    p.actions.push({
      id: "second",
      name: p.actions[0]!.name,
      fps: 8,
      loop: false,
      frames: [blue!],
    });
    // Caller order must not change sidebar order; duplicate action names are valid.
    const blob = await exportSpriteAssets(p, ["second", p.actions[0]!.id], "combined", 2, 2);
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(files).toSorted()).toEqual(["animation.json", "atlas.png"]);
    const metadata = JSON.parse(strFromU8(files["animation.json"]!));
    expect(metadata).toMatchObject({ version: 1, width: 16, height: 16 });
    expect(metadata.actions.map((a: { image: string }) => a.image)).toEqual([
      "atlas.png",
      "atlas.png",
    ]);
    expect(metadata.actions[0].frames.map((f: { x: number; y: number }) => [f.x, f.y])).toEqual([
      [0, 0],
      [18, 0],
      [0, 18],
    ]);
    expect(metadata.actions[1]).toMatchObject({
      fps: 8,
      loop: false,
      frames: [{ x: 0, y: 36, width: 16, height: 16, durationMs: 125 }],
    });
    const bitmap = await createImageBitmap(
      new Blob([new Uint8Array(files["atlas.png"]!)], { type: "image/png" }),
    );
    expect([bitmap.width, bitmap.height]).toEqual([34, 52]);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    expect([...ctx.getImageData(4, 38, 1, 1).data]).toEqual([0, 0, 255, 255]);
    expect([...ctx.getImageData(4, 26, 1, 1).data]).toEqual([255, 0, 0, 255]);
    for (const [x, y] of [
      [18, 36],
      [16, 8],
      [4, 16],
      [4, 34],
    ])
      expect(ctx.getImageData(x!, y!, 1, 1).data[3]).toBe(0);

    const single = unzipSync(
      new Uint8Array(
        await (await exportSpriteAssets(p, ["second"], "combined", 8, 0)).arrayBuffer(),
      ),
    );
    const image = await createImageBitmap(
      new Blob([new Uint8Array(single["atlas.png"]!)], { type: "image/png" }),
    );
    expect([image.width, image.height]).toEqual([16, 16]);
    image.close();
  });
  it("rejects empty scopes and oversized combined layouts, and cancels before returning a ZIP", async () => {
    const p = await fixture();
    await expect(exportSpriteAssets(p, [], "combined", 8, 0)).rejects.toThrow(
      "No frames to export",
    );
    const ids = [p.actions[0]!.id];
    p.width = 9000;
    await expect(exportSpriteAssets(p, ids, "combined", 2, 0)).rejects.toThrow("output limit");
    p.width = 4000;
    p.height = 9000;
    await expect(exportSpriteAssets(p, ids, "combined", 2, 0)).rejects.toThrow("output limit");
    p.width = p.height = 16;
    const controller = new AbortController();
    await expect(
      exportSpriteAssets(p, ids, "combined", 2, 0, controller.signal, () => controller.abort()),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      exportSpriteAssets(p, ids, "combined", 2, 0, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("rejects unsupported packages, bad frame references and empty export actions", async () => {
    const p = await fixture();
    const files = unzipSync(new Uint8Array(await (await exportSpriteProject(p)).arrayBuffer()));
    const data = JSON.parse(strFromU8(files["project.json"]!));
    data.actions[0].frames[0].sourceId = "missing";
    files["project.json"] = strToU8(JSON.stringify(data));
    await expect(
      importSpriteProject(new File([new Uint8Array(zipSync(files))], "bad.zip")),
    ).rejects.toThrow(/reference/);
    data.version = 99;
    files["project.json"] = strToU8(JSON.stringify(data));
    await expect(
      importSpriteProject(new File([new Uint8Array(zipSync(files))], "future.zip")),
    ).rejects.toThrow(/Unsupported/);
    p.actions[0]!.frames = [];
    await expect(exportSpriteAssets(p, [p.actions[0]!.id], "atlas", 2, 0)).rejects.toThrow(
      /no frames/,
    );
  });
});

it("replaces decoded source images without drawing a released ImageBitmap", async () => {
  const { render } = await import("vitest-browser-react");
  const { SpritePreview } = await import("./SpritePreview");
  const p = await fixture();
  const view = await render(<SpritePreview project={p} frame={p.actions[0]!.frames[0]!} />);
  await expect
    .poll(
      () => document.querySelector("canvas")?.getContext("2d")?.getImageData(4, 8, 1, 1).data[3],
    )
    .toBe(255);
  const next = { ...p, sources: [...p.sources] };
  await view.rerender(<SpritePreview project={next} frame={next.actions[0]!.frames[1]!} />);
  await expect
    .poll(
      () => document.querySelector("canvas")?.getContext("2d")?.getImageData(4, 2, 1, 1).data[2],
    )
    .toBe(255);
  await view.unmount();
});

it("starts a new library without reading the old browser database", async () => {
  const oldId = "old-sprite-ignored";
  const old = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("aha-sprites-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("projects", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.addEventListener("error", () => reject(request.error));
  });
  const tx = old.transaction("projects", "readwrite");
  tx.objectStore("projects").put({ ...newSpriteProject(), id: oldId, name: "Old project" });
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.addEventListener("error", () => reject(tx.error));
  });
  old.close();
  expect((await listSpriteProjects()).projects.some((p) => p.id === oldId)).toBe(false);
  const p = await fixture();
  await saveSpriteProject(p);
  const summary = (await listSpriteProjects()).projects.find((s) => s.id === p.id)!;
  expect(summary.name).toBe(p.name);
  expect(summary).not.toHaveProperty("sources");
  const { readSpriteThumbnail } = await import("./spriteStorage");
  expect((await readSpriteThumbnail(p.id))?.type).toBe("image/png");
  await deleteSpriteProject(p.id);
  await expect(saveSpriteProject(p)).rejects.toThrow("deleted");
});

it("reports desktop save errors without falling back to browser storage", async () => {
  const p = await fixture();
  const original = window.desktopBridge;
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      ...original,
      spriteLibrary: {
        request: async () => {
          throw new Error("Disk unavailable");
        },
      },
    },
  });
  try {
    await expect(saveSpriteProject(p)).rejects.toThrow("Disk unavailable");
  } finally {
    Object.defineProperty(window, "desktopBridge", { configurable: true, value: original });
  }
  expect((await listSpriteProjects()).projects.some((s) => s.id === p.id)).toBe(false);
});

it("normalizes single-chat projects only in the current browser library", async () => {
  const p = await fixture();
  await saveSpriteProject(p);
  const { threadIds: _ids, activeThreadId: _active, ...legacy } = p;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("aha-sprite-library-v2", 2);
    request.onsuccess = () => resolve(request.result);
    request.addEventListener("error", () => reject(request.error));
  });
  const tx = db.transaction("projects", "readwrite");
  tx.objectStore("projects").put({ ...legacy, threadId: "old-current-chat" }, p.id);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.addEventListener("error", () => reject(tx.error));
  });
  db.close();
  const restored = await getSpriteProject(p.id);
  expect(restored).toMatchObject({
    threadIds: ["old-current-chat"],
    activeThreadId: "old-current-chat",
  });
  expect(restored).not.toHaveProperty("threadId");
  await saveSpriteProject({
    ...restored,
    threadIds: ["old-current-chat", "second-chat"],
    activeThreadId: "second-chat",
  });
  expect(await getSpriteProject(p.id)).toMatchObject({
    threadIds: ["old-current-chat", "second-chat"],
    activeThreadId: "second-chat",
  });
  await deleteSpriteProject(p.id);
});

it("keeps internal generated frames and their provenance through offline project packages", async () => {
  const p = await fixture();
  p.sources[0]!.usage = "generated-frame";
  p.sources[0]!.assetId = "frame-asset";
  p.sources[0]!.origin = { runId: "run", candidateId: "candidate", processingVersionId: "v2" };
  p.adoptedCandidateIds = ["run:candidate:walk"];
  p.provenance = [
    {
      runId: "run",
      candidateId: "candidate",
      actionId: "walk",
      localActionId: p.actions[0]!.id,
      processingVersionId: "v2",
      prompt: "walk",
      action: "walk",
      providerId: "provider",
      model: "image",
    },
  ];
  const blob = await exportSpriteProject(p),
    restored = await importSpriteProject(new File([blob], "frames.zip"));
  expect(restored.sources[0]).toMatchObject({
    usage: "generated-frame",
    assetId: "frame-asset",
    origin: { runId: "run", candidateId: "candidate", processingVersionId: "v2" },
  });
  expect(restored.adoptedCandidateIds).toEqual(["run:candidate:walk"]);
  expect(restored.provenance[0]).toMatchObject({
    localActionId: p.actions[0]!.id,
    processingVersionId: "v2",
  });
  await saveSpriteProject(restored);
  const reopened = await getSpriteProject(restored.id);
  expect(reopened.sources.filter((s) => s.usage !== "generated-frame")).toHaveLength(0);
  expect(reopened.actions[0]!.frames).toHaveLength(2);
  await deleteSpriteProject(restored.id);
});

it("round trips repair geometry, frame instances and timing through the project package and browser storage", async () => {
  const { spriteGridSlice, spriteEditFromSlice, spriteSliceFromEdit } =
    await import("@synara/contracts");
  const p = await fixture(),
    source = p.sources[0]!;
  const action = {
    id: p.actions[0]!.id,
    name: "manual",
    description: "",
    enabled: true,
    frameCount: 2,
    fps: 12,
    loop: true,
  };
  const edit = spriteEditFromSlice(spriteGridSlice(source.width, source.height, [action]));
  const group = edit.actions[0]!;
  const changed = {
    ...edit,
    actions: [
      {
        ...group,
        frames: [{ ...group.frames[1]!, offsetX: 2, durationMs: 175 }, group.frames[0]!],
      },
    ],
  };
  p.sources[0] = { ...source, assetId: "original-source" };
  p.provenance = [
    {
      runId: "run",
      localActionId: p.actions[0]!.id,
      prompt: "manual",
      action: "manual",
      model: "",
      providerId: "",
      processingSnapshots: [
        {
          version: 1,
          runId: "run",
          sourceAssetId: "original-source",
          configuration: spriteSliceFromEdit(changed),
          processingVersionId: "processed",
        },
      ],
    },
  ];
  p.actionVersions = snapshotSpriteActions(p, [p.actions[0]!.id]);
  const restored = await importSpriteProject(
    new File([await exportSpriteProject(p)], "repair.zip"),
  );
  expect(restored.provenance[0]!.processingSnapshots).toEqual(p.provenance[0]!.processingSnapshots);
  expect(restored.actionVersions![0]!.provenance[0]!.processingSnapshots).toEqual(
    p.provenance[0]!.processingSnapshots,
  );
  expect(restored.sources[0]!.assetId).toBe("original-source");
  await saveSpriteProject(restored);
  expect((await getSpriteProject(restored.id)).provenance[0]!.processingSnapshots).toEqual(
    p.provenance[0]!.processingSnapshots,
  );
  await deleteSpriteProject(restored.id);
});
