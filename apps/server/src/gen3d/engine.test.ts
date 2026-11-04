import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";
import type { Gen3DBuild, Model3DValidationReport } from "@synara/contracts";
import { Gen3DEngine } from "./engine";
import type { gen3dHostCall } from "./hostClient";

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aha-gen3d-test-")));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const report: Model3DValidationReport = {
  triangles: 1,
  vertices: 3,
  bytes: 0,
  dimensions: [1, 1, 0],
  objects: [
    { id: "body", name: "Body", triangles: 1 },
    { id: "lid", name: "Lid", triangles: 1 },
  ],
  materials: [],
  textures: [],
  warnings: [],
  errors: [],
  validatorErrors: 0,
};
const build = (source = "function buildModel(){}"): Gen3DBuild => ({
  source,
  prompt: "robot",
  parentVersionId: null,
});
function triangleGlb() {
  const json = JSON.stringify({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
    ],
  });
  const padded = json + " ".repeat((4 - (json.length % 4)) % 4),
    bytes = Buffer.alloc(12 + 8 + padded.length + 8 + 36);
  bytes.writeUInt32LE(0x46546c67, 0);
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(padded.length, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  bytes.write(padded, 20);
  const offset = 20 + padded.length;
  bytes.writeUInt32LE(36, offset);
  bytes.writeUInt32LE(0x004e4942, offset + 4);
  new Float32Array(bytes.buffer, bytes.byteOffset + offset + 8, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  return bytes;
}
/** A white sheet with three dark views side by side. */
async function sheet() {
  const width = 600,
    height = 300,
    rgb = Buffer.alloc(width * height * 3, 255);
  const fill = (x0: number, x1: number, y0: number, y1: number) => {
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) rgb.fill(40, (x + y * width) * 3, (x + y * width) * 3 + 3);
  };
  fill(40, 160, 40, 260);
  fill(260, 330, 40, 260);
  fill(440, 560, 40, 260);
  return sharp(rgb, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}
/** The mock host copies the blueprint as the model silhouette unless told to offset it. */
function makeHost(options: { offset?: number; blenderReady?: boolean } = {}): typeof gen3dHostCall {
  const host = vi.fn(async (method: string, input: Record<string, unknown>) => {
    if (method === "environment")
      return {
        desktop: true,
        error: null,
        blender: options.blenderReady
          ? { ready: true, headless: true, version: "Blender 5.0.0", error: null }
          : { ready: false, headless: false, version: null, error: "Blender was not found." },
      };
    if (method === "view") {
      const file = path.join(
        String(input.projectId),
        "views",
        String(input.versionId),
        String(input.view) + ".png",
      );
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(
        path.join(root, file),
        await sharp({ create: { width: 32, height: 32, channels: 3, background: "#808080" } })
          .png()
          .toBuffer(),
      );
      return { file };
    }
    if (method !== "build") return {};
    const dir = path.join(root, String(input.projectId), "jobs", String(input.jobId));
    await fs.writeFile(path.join(dir, "model.glb"), triangleGlb());
    await fs.writeFile(path.join(dir, "thumbnail.png"), Buffer.from([1]));
    await fs.writeFile(path.join(dir, "render-34.png"), Buffer.from([2]));
    for (const view of ["front", "side", "back"]) {
      const blueprint = path.join(root, String(input.projectId), "blueprint", view + ".png");
      let image = sharp(blueprint);
      if (options.offset)
        image = sharp(
          await image
            .extend({ top: 0, bottom: 0, left: options.offset, right: 0, background: "#0c0c0c" })
            .toBuffer(),
        ).extract({
          left: 0,
          top: 0,
          width: 256,
          height: 256,
        });
      await fs.writeFile(path.join(dir, `sil-${view}.png`), await image.png().toBuffer());
    }
    const frozen = JSON.parse(await fs.readFile(path.join(dir, "input.json"), "utf8"));
    const processed = frozen.build.mode === "process";
    if (processed)
      for (const name of frozen.build.rig ? ["rigged.glb"] : ["lod1.glb", "collision.glb"])
        await fs.writeFile(path.join(dir, name), triangleGlb());
    return {
      report,
      topology: { boundaryEdges: 0, nonManifoldEdges: 0 },
      ...(frozen.build.mode !== undefined && frozen.build.mode !== "threejs"
        ? { blender: "Blender 5.0.0" }
        : {}),
      ...(processed
        ? {
            process: {
              highTriangles: 80000,
              lowTriangles: 5000,
              lods: [{ file: "lod1.glb", triangles: 2500 }],
              collision: { file: "collision.glb", triangles: 250 },
              baked: ["baseColor", "normal"],
              textureSize: 1024,
              seconds: 5,
            },
          }
        : {}),
    };
  });
  return host as unknown as typeof gen3dHostCall;
}
async function settled(engine: Gen3DEngine, id: string) {
  for (let i = 0; i < 200; i++) {
    const p = await engine.get(id);
    if (
      p.jobs.length &&
      p.jobs.every((j) => !["queued", "running", "validating"].includes(j.status))
    )
      return p;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("job did not settle");
}
async function project(engine: Gen3DEngine) {
  let p = (await engine.command({ operation: "create", name: "Robot" })).project!;
  p = (
    await engine.addReferenceBytes(p.id, p.revision, await sheet(), {
      name: "sheet.png",
      origin: "upload",
      imageJobId: null,
    })
  ).project!;
  p = (
    await engine.command({
      operation: "extract-blueprint",
      projectId: p.id,
      revision: p.revision,
      referenceId: p.references[0]!.id,
      targetHeight: 0.6,
    })
  ).project!;
  p = (
    await engine.command({ operation: "confirm-blueprint", projectId: p.id, revision: p.revision })
  ).project!;
  return (
    await engine.command({
      operation: "bind-thread",
      projectId: p.id,
      revision: p.revision,
      threadId: "thread-1",
    })
  ).project!;
}

describe("Gen3DEngine", () => {
  it("extracts a blueprint at the target scale", async () => {
    const engine = new Gen3DEngine(root, makeHost());
    const p = await project(engine);
    expect(p.blueprint).toMatchObject({ targetHeight: 0.6, confirmed: true });
    expect(p.blueprint!.boxes.front).toEqual({ x0: 40, x1: 160, y0: 40, y1: 260 });
    expect(p.blueprint!.pxPerMetre).toBeGreaterThan(300);
    for (const view of ["front", "side", "back"])
      expect((await engine.read(p.id, "blueprint", view)).length).toBeGreaterThan(100);
  });

  it("scores builds against the blueprint and writes diff images", async () => {
    const engine = new Gen3DEngine(root, makeHost({ offset: 0 }));
    let p = await project(engine);
    await engine.command({
      operation: "submit",
      projectId: p.id,
      revision: p.revision,
      build: build(),
      requestId: "r1",
    });
    p = await settled(engine, p.id);
    const version = p.versions[0]!;
    expect(version.score).toMatchObject({ score: 100, maxRegionPct: 0 });
    expect(version.files.map((f) => f.name)).toEqual(
      expect.arrayContaining(["diff-front.png", "score.json", "render-34.png"]),
    );
    expect(
      (await engine.read(p.id, "versions", version.id, "diff-side.png")).length,
    ).toBeGreaterThan(100);
    await expect(engine.read(p.id, "versions", version.id, "../project.json")).rejects.toThrow();
  });

  it("builds on the Blender route and keeps the skeleton with the version", async () => {
    const host = makeHost({ blenderReady: true });
    const engine = new Gen3DEngine(root, host);
    let p = await project(engine);
    const skeleton = [
      { id: "hips", parent: null, position: [0, 0.3, 0] as const, radius: 0.1 },
      { id: "head", parent: "hips", position: [0, 0.55, 0] as const, radius: 0.08 },
    ];
    await engine.command({
      operation: "submit",
      projectId: p.id,
      revision: p.revision,
      build: { ...build("aha_skin()"), mode: "blender", skeleton },
      requestId: "b1",
    });
    p = await settled(engine, p.id);
    const version = p.versions[0]!;
    expect(version.runtime).toMatchObject({ blender: "Blender 5.0.0" });
    expect(version.files.map((f) => f.name)).toContain("skeleton.json");
    const saved = JSON.parse(
      (await engine.read(p.id, "versions", version.id, "skeleton.json")).toString(),
    );
    expect(saved).toMatchObject({ units: "meters", upAxis: "Y", nodes: skeleton });
    // Blender waits for the shared lock and starts a GUI instance, so it gets a longer request.
    const call = vi.mocked(host).mock.calls.find(([method]) => method === "build")!;
    expect(call[3]).toBeGreaterThan(180_000);
  });

  it("rejects Blender builds and broken skeletons before spending a round", async () => {
    const engine = new Gen3DEngine(root, makeHost());
    let p = await project(engine);
    p = (
      await engine.command({
        operation: "start-run",
        projectId: p.id,
        revision: p.revision,
        maxRounds: 2,
      })
    ).project!;
    await expect(
      engine.command({
        operation: "submit",
        projectId: p.id,
        revision: p.revision,
        build: { ...build(), mode: "blender" },
        requestId: "b1",
      }),
    ).rejects.toThrow(/Blender is not ready \(Blender was not found\.\)/);
    await expect(
      engine.command({
        operation: "submit",
        projectId: p.id,
        revision: p.revision,
        build: {
          ...build(),
          skeleton: [{ id: "a", parent: "missing", position: [0, 0, 0], radius: 0.1 }],
        },
        requestId: "b2",
      }),
    ).rejects.toThrow(/missing parent/);
    p = await engine.get(p.id);
    expect(p.runs[0]).toMatchObject({ usedRounds: 0, status: "active" });
    expect(p.jobs).toHaveLength(0);
  });

  it("optimizes a version into a scored candidate with validated LOD and collision files", async () => {
    const host = makeHost({ blenderReady: true });
    const engine = new Gen3DEngine(root, host);
    let p = await project(engine);
    await engine.command({
      operation: "submit",
      projectId: p.id,
      revision: p.revision,
      build: build(),
      requestId: "m",
    });
    p = await settled(engine, p.id);
    const source = p.versions[0]!;
    const process = {
      targetTriangles: 5000,
      textureSize: 1024 as const,
      repair: true,
      bake: true,
      lods: [0.5],
      collision: "convex" as const,
    };
    await engine.command({
      operation: "optimize",
      projectId: p.id,
      revision: p.revision,
      versionId: source.id,
      process,
    });
    p = await settled(engine, p.id);
    const optimized = p.versions[1]!;
    expect(optimized.build).toMatchObject({ mode: "process", parentVersionId: source.id, process });
    expect(optimized.process).toMatchObject({ lowTriangles: 5000, collision: { triangles: 250 } });
    expect(optimized.runtime.blender).toBe("Blender 5.0.0");
    expect(optimized.score).not.toBeNull();
    expect(optimized.files.map((f) => f.name)).toEqual(
      expect.arrayContaining(["lod1.glb", "collision.glb"]),
    );
    const call = vi
      .mocked(host)
      .mock.calls.filter(([method]) => method === "build")
      .at(-1)!;
    expect(call[3]).toBeGreaterThan(600_000);
    // The agent cannot submit optimization builds itself.
    await expect(
      engine.command({
        operation: "submit",
        projectId: p.id,
        revision: p.revision,
        build: { ...build(), mode: "process", process },
        requestId: "x",
      }),
    ).rejects.toThrow(/workbench operations/);
  });

  it("repaints a baked version only from its own view render and a painted mask", async () => {
    const engine = new Gen3DEngine(root, makeHost({ blenderReady: true }));
    let p = await project(engine);
    await engine.command({
      operation: "submit",
      projectId: p.id,
      revision: p.revision,
      build: build(),
      requestId: "r",
    });
    p = await settled(engine, p.id);
    const source = p.versions[0]!;
    await expect(engine.renderView(p.id, source.id, "front")).rejects.toThrow(/baked textures/);
    await engine.command({
      operation: "optimize",
      projectId: p.id,
      revision: p.revision,
      versionId: source.id,
      process: {
        targetTriangles: 5000,
        textureSize: 1024,
        repair: true,
        bake: true,
        lods: [0.5],
        collision: "convex",
      },
    });
    p = await settled(engine, p.id);
    const optimized = p.versions[1]!;
    const view = await engine.renderView(p.id, optimized.id, "front-left");
    const square = (width: number, height = width) =>
      sharp({ create: { width, height, channels: 3, background: "#3366cc" } })
        .png()
        .toBuffer();
    const mask = (paint: boolean) => {
      const rgba = Buffer.alloc(40 * 40 * 4, 255);
      if (paint) for (let i = 0; i < 200; i++) rgba[i * 4 + 3] = 0;
      return sharp(rgba, { raw: { width: 40, height: 40, channels: 4 } })
        .png()
        .toBuffer();
    };
    const input = async (patch: Record<string, unknown> = {}) => ({
      versionId: optimized.id,
      view: "front-left" as const,
      viewImage: view,
      image: await square(1254),
      mask: await mask(true),
      imageJobId: "job-1",
      imageAssetId: "asset-1",
      instruction: "  paint the lid red ",
      feather: 12,
      ...patch,
    });
    const latest = (await engine.get(p.id)).revision;
    await expect(
      engine.repaintBytes(p.id, latest, await input({ viewImage: await square(8) })),
    ).rejects.toThrow(/not made from this version's view render/);
    await expect(engine.repaintBytes(p.id, latest, await input({ view: "back" }))).rejects.toThrow(
      /not made from this version's view render/,
    );
    await expect(
      engine.repaintBytes(p.id, latest, await input({ image: await square(1254, 900) })),
    ).rejects.toThrow(/must be square/);
    await expect(
      engine.repaintBytes(p.id, latest, await input({ mask: await mask(false) })),
    ).rejects.toThrow(/Paint an area/);
    await expect(
      engine.repaintBytes(p.id, latest, await input({ versionId: source.id })),
    ).rejects.toThrow(/not made from this version's view render/);
    await engine.repaintBytes(p.id, latest, await input());
    p = await settled(engine, p.id);
    const repainted = p.versions[2]!;
    expect(repainted.build).toMatchObject({
      mode: "process",
      parentVersionId: optimized.id,
      repaint: { view: "front-left", instruction: "paint the lid red", feather: 12 },
    });
    const dir = path.join(root, p.id, "versions", repainted.id);
    const edited = await sharp(path.join(dir, "repaint-image.png")).metadata();
    expect([edited.width, edited.height]).toEqual([1024, 1024]);
    const stored = await sharp(path.join(dir, "repaint-mask.png"))
      .extractChannel(3)
      .raw()
      .toBuffer();
    expect(stored.length).toBe(1024 * 1024);
    expect(stored.some((v) => v === 0) && stored.some((v) => v === 255)).toBe(true);
    // Repaint is a workbench operation; the agent cannot submit or start it.
    await expect(
      engine.command({
        operation: "submit",
        projectId: p.id,
        revision: p.revision,
        build: { ...build(), repaint: repainted.build.repaint },
        requestId: "y",
      }),
    ).rejects.toThrow(/workbench operations/);
    await expect(
      engine.command({ operation: "repaint", projectId: p.id, revision: p.revision }),
    ).rejects.toThrow(/workbench service/);
  });

  it("keeps seamless textures and checks tiled materials before optimizing", async () => {
    const host = makeHost({ blenderReady: true });
    const engine = new Gen3DEngine(root, host);
    let p = await project(engine);
    await engine.command({
      operation: "submit",
      projectId: p.id,
      revision: p.revision,
      build: build(),
      requestId: "t",
    });
    p = await settled(engine, p.id);
    const noisy = Buffer.alloc(300 * 200 * 3);
    for (let i = 0; i < noisy.length; i++) noisy[i] = (i * 7919) % 251;
    const image = await sharp(noisy, { raw: { width: 300, height: 200, channels: 3 } })
      .png()
      .toBuffer();
    p = (
      await engine.addTextureBytes(p.id, p.revision, image, {
        name: "oak.png",
        prompt: " oak planks ",
        imageJobId: "job-t",
      })
    ).project!;
    const texture = p.textures![0]!;
    expect(texture).toMatchObject({
      width: 200,
      height: 200,
      prompt: "oak planks",
      imageJobId: "job-t",
    });
    const stored = await engine.read(p.id, "textures", texture.id);
    expect((await sharp(stored).metadata()).width).toBe(200);
    // The same image imports once.
    p = (
      await engine.addTextureBytes(p.id, p.revision, image, {
        name: "oak.png",
        prompt: "oak planks",
        imageJobId: "job-t2",
      })
    ).project!;
    expect(p.textures).toHaveLength(1);
    const optimize = (materials: unknown) =>
      engine.command({
        operation: "optimize",
        projectId: p.id,
        revision: p.revision,
        versionId: p.versions[0]!.id,
        process: {
          targetTriangles: 5000,
          textureSize: 1024,
          repair: true,
          bake: true,
          lods: [],
          collision: "none",
          materials: materials as never,
        },
      });
    await expect(optimize([{ materialId: "m", preset: "tiled" }])).rejects.toThrow(
      /need a texture/,
    );
    await expect(
      optimize([
        {
          materialId: "m",
          preset: "wood",
          tile: { textureId: texture.id, metres: 0.3, roughness: 0.7 },
        },
      ]),
    ).rejects.toThrow(/need a texture, other presets none/);
    await expect(
      optimize([
        {
          materialId: "m",
          preset: "tiled",
          tile: { textureId: "missing", metres: 0.3, roughness: 0.7 },
        },
      ]),
    ).rejects.toThrow(/not found/);
    await optimize([
      {
        materialId: "m",
        preset: "tiled",
        tile: { textureId: texture.id, metres: 0.3, roughness: 0.7 },
      },
    ]);
    p = await settled(engine, p.id);
    expect(p.jobs.at(-1)!.status).toBe("succeeded");
    await expect(engine.read(p.id, "textures", "missing")).rejects.toThrow(/not found/);
    await expect(
      engine.command({ operation: "import-texture-asset", projectId: p.id, revision: p.revision }),
    ).rejects.toThrow(/workbench service/);
  });

  it("animates chosen parts with a valid hinge and keeps one part still", async () => {
    const engine = new Gen3DEngine(root, makeHost({ blenderReady: true }));
    let p = await project(engine);
    await engine.command({
      operation: "submit",
      projectId: p.id,
      revision: p.revision,
      build: build(),
      requestId: "a",
    });
    p = await settled(engine, p.id);
    const animate = (animation: Record<string, unknown>) =>
      engine.command({
        operation: "animate",
        projectId: p.id,
        revision: p.revision,
        versionId: p.versions[0]!.id,
        animate: { seconds: 1, ...animation } as never,
      });
    await expect(animate({ parts: ["missing"], motion: "spin" })).rejects.toThrow(/Part not found/);
    await expect(animate({ parts: ["body", "lid"], motion: "spin" })).rejects.toThrow(/stay still/);
    await expect(animate({ parts: ["lid"], motion: "door", edge: "back" })).rejects.toThrow(
      /left or right/,
    );
    await expect(animate({ parts: ["lid"], motion: "lid" })).rejects.toThrow(/hinge edge/);
    await animate({ parts: ["lid"], motion: "lid", edge: "back", angle: 100 });
    p = await settled(engine, p.id);
    expect(p.versions[1]!.build).toMatchObject({
      mode: "process",
      animate: { parts: ["lid"], motion: "lid", edge: "back", angle: 100 },
    });
  });

  it("stylizes within each style's detail range", async () => {
    const engine = new Gen3DEngine(root, makeHost({ blenderReady: true }));
    let p = await project(engine);
    await engine.command({
      operation: "submit",
      projectId: p.id,
      revision: p.revision,
      build: build(),
      requestId: "s",
    });
    p = await settled(engine, p.id);
    const stylize = (style: "voxel" | "bricks" | "lowpoly", detail: number) =>
      engine.command({
        operation: "stylize",
        projectId: p.id,
        revision: p.revision,
        versionId: p.versions[0]!.id,
        stylize: { style, detail },
      });
    await expect(stylize("voxel", 200)).rejects.toThrow(/8–96/);
    await expect(stylize("lowpoly", 20)).rejects.toThrow(/50–20000/);
    await stylize("bricks", 20);
    p = await settled(engine, p.id);
    expect(p.versions[1]!.build).toMatchObject({
      mode: "process",
      parentVersionId: p.versions[0]!.id,
      stylize: { style: "bricks", detail: 20 },
    });
    await expect(
      engine.command({
        operation: "submit",
        projectId: p.id,
        revision: p.revision,
        build: { ...build(), stylize: { style: "voxel", detail: 32 } },
        requestId: "sz",
      }),
    ).rejects.toThrow(/workbench operations/);
  });

  it("rigs from confirmed joints attached to a version built without a skeleton", async () => {
    const engine = new Gen3DEngine(root, makeHost({ blenderReady: true }));
    let p = await project(engine);
    await engine.command({
      operation: "submit",
      projectId: p.id,
      revision: p.revision,
      build: build(),
      requestId: "j",
    });
    p = await settled(engine, p.id);
    const version = p.versions[0]!;
    const [w, h] = version.report.dimensions as [number, number, number];
    const joints = [
      { id: "hips", parent: null, position: [0, h * 0.5, 0] as const, radius: 0.02 },
      { id: "thigh_l", parent: "hips", position: [w * 0.2, h * 0.3, 0] as const, radius: 0.02 },
    ];
    const command = (operation: "set-skeleton" | "propose-skeleton", extra: object) =>
      engine.get(p.id).then((latest) =>
        engine.command({
          operation,
          projectId: p.id,
          revision: latest.revision,
          versionId: version.id,
          ...extra,
        }),
      );
    await expect(
      command("propose-skeleton", {
        skeleton: [{ id: "hips", parent: null, position: [0, h * 3, 0], radius: 0.02 }],
      }),
    ).rejects.toThrow(/outside the model/);
    // An AI proposal is never confirmed, even if it asks to be.
    p = (await command("propose-skeleton", { skeleton: joints, confirmed: true })).project!;
    expect(p.skeletons![0]).toMatchObject({ origin: "ai", confirmed: false });
    const rig = () =>
      engine.get(p.id).then((latest) =>
        engine.command({
          operation: "rig",
          projectId: p.id,
          revision: latest.revision,
          versionId: version.id,
          clips: ["idle"],
        }),
      );
    await expect(rig()).rejects.toThrow(/Confirm joints/);
    p = (
      await command("set-skeleton", { skeleton: joints, confirmed: true, skeletonOrigin: "user" })
    ).project!;
    expect(p.skeletons).toHaveLength(1);
    expect(p.skeletons![0]).toMatchObject({ origin: "user", confirmed: true });
    await rig();
    p = await settled(engine, p.id);
    expect(p.jobs.at(-1)!.status).toBe("succeeded");
    p = (await command("set-skeleton", { skeleton: [] })).project!;
    expect(p.skeletons).toHaveLength(0);
  });

  it("rigs only versions with a skeleton in their history", async () => {
    const engine = new Gen3DEngine(root, makeHost({ blenderReady: true }));
    let p = await project(engine);
    await engine.command({
      operation: "submit",
      projectId: p.id,
      revision: p.revision,
      build: build(),
      requestId: "plain",
    });
    p = await settled(engine, p.id);
    const rig = (versionId: string, clips: unknown) =>
      engine.command({
        operation: "rig",
        projectId: p.id,
        revision: p.revision,
        versionId,
        clips: clips as never,
      });
    await expect(rig(p.versions[0]!.id, ["walk"])).rejects.toThrow(/has no skeleton/);
    const skeleton = [
      { id: "hips", parent: null, position: [0, 0.3, 0] as const, radius: 0.05 },
      { id: "thigh_l", parent: "hips", position: [0.05, 0.15, 0] as const, radius: 0.03 },
    ];
    await engine.command({
      operation: "submit",
      projectId: p.id,
      revision: p.revision,
      build: { ...build(), skeleton },
      requestId: "skeleton",
      turnId: "turn-2",
    });
    p = await settled(engine, p.id);
    const modeled = p.versions[1]!;
    await expect(rig(modeled.id, [])).rejects.toThrow(/at least one animation clip/);
    await rig(modeled.id, ["walk", "idle", "walk"]);
    p = await settled(engine, p.id);
    const rigged = p.versions[2]!;
    expect(rigged.build).toMatchObject({
      mode: "process",
      parentVersionId: modeled.id,
      rig: { clips: ["walk", "idle"] },
    });
    expect(rigged.files.map((f) => f.name)).toContain("rigged.glb");
    // A later fixed step on top still finds the skeleton two versions back.
    await rig(rigged.id, ["idle"]);
    p = await settled(engine, p.id);
    expect(p.jobs.at(-1)!.status).toBe("succeeded");
    await expect(
      engine.command({
        operation: "submit",
        projectId: p.id,
        revision: p.revision,
        build: { ...build(), rig: { clips: ["idle"] } },
        requestId: "z",
      }),
    ).rejects.toThrow(/workbench operations/);
  });

  it("guards reference projection: baked textures, a score and the same blueprint", async () => {
    const engine = new Gen3DEngine(root, makeHost({ blenderReady: true }));
    let p = await project(engine);
    await engine.command({
      operation: "submit",
      projectId: p.id,
      revision: p.revision,
      build: build(),
      requestId: "m",
    });
    p = await settled(engine, p.id);
    const process = {
      targetTriangles: 5000,
      textureSize: 1024 as const,
      repair: true,
      bake: false,
      lods: [],
      collision: "none" as const,
      texture: "projection" as const,
    };
    const optimize = (patch: Partial<typeof process>) =>
      engine.command({
        operation: "optimize",
        projectId: p.id,
        revision: p.revision,
        versionId: p.versions[0]!.id,
        process: { ...process, ...patch },
      });
    await expect(optimize({})).rejects.toThrow(/need baked textures/);
    // Re-extracting the blueprint invalidates the registration the version was scored with.
    p = (
      await engine.command({
        operation: "extract-blueprint",
        projectId: p.id,
        revision: p.revision,
        referenceId: p.references[0]!.id,
        targetHeight: 0.6,
      })
    ).project!;
    p = (
      await engine.command({
        operation: "confirm-blueprint",
        projectId: p.id,
        revision: p.revision,
      })
    ).project!;
    await expect(optimize({ bake: true })).rejects.toThrow(/blueprint changed/);
    expect(p.jobs).toHaveLength(1);
  });

  it("refuses to optimize without Blender", async () => {
    const engine = new Gen3DEngine(root, makeHost());
    let p = await project(engine);
    await engine.command({
      operation: "submit",
      projectId: p.id,
      revision: p.revision,
      build: build(),
      requestId: "m",
    });
    p = await settled(engine, p.id);
    await expect(
      engine.command({
        operation: "optimize",
        projectId: p.id,
        revision: p.revision,
        versionId: p.versions[0]!.id,
        process: {
          targetTriangles: 800,
          textureSize: 512,
          repair: false,
          bake: false,
          lods: [],
          collision: "none",
        },
      }),
    ).rejects.toThrow(/needs Blender/);
  });

  it("limits builds to one per turn without an authorization", async () => {
    const engine = new Gen3DEngine(root, makeHost());
    let p = await project(engine);
    await engine.command({
      operation: "submit",
      projectId: p.id,
      revision: p.revision,
      build: build(),
      requestId: "a",
      turnId: "t1",
    });
    p = await settled(engine, p.id);
    await expect(
      engine.command({
        operation: "submit",
        projectId: p.id,
        revision: p.revision,
        build: build("x"),
        requestId: "b",
        turnId: "t1",
      }),
    ).rejects.toThrow(/one build/);
  });

  it("spends authorized rounds and stops when the deviation is small", async () => {
    const engine = new Gen3DEngine(root, makeHost({ offset: 30 }));
    let p = await project(engine);
    p = (
      await engine.command({
        operation: "start-run",
        projectId: p.id,
        revision: p.revision,
        maxRounds: 2,
      })
    ).project!;
    for (const id of ["a", "b"]) {
      await engine.command({
        operation: "submit",
        projectId: p.id,
        revision: p.revision,
        build: build(id),
        requestId: id,
        turnId: "t1",
      });
      p = await settled(engine, p.id);
    }
    expect(p.versions.map((v) => v.round)).toEqual([1, 2]);
    expect(p.runs[0]).toMatchObject({
      status: "completed",
      usedRounds: 2,
      stopReason: "rounds-used",
    });
    await expect(
      engine.command({
        operation: "submit",
        projectId: p.id,
        revision: p.revision,
        build: build("c"),
        requestId: "c",
        turnId: "t1",
      }),
    ).rejects.toThrow(/one build/);

    const exact = new Gen3DEngine(root, makeHost());
    p = (
      await exact.command({
        operation: "start-run",
        projectId: p.id,
        revision: p.revision,
        maxRounds: 4,
      })
    ).project!;
    await exact.command({
      operation: "submit",
      projectId: p.id,
      revision: p.revision,
      build: build("d"),
      requestId: "d",
      turnId: "t2",
    });
    p = await settled(exact, p.id);
    expect(p.runs.at(-1)).toMatchObject({
      status: "completed",
      usedRounds: 1,
      stopReason: "deviation-below-threshold",
    });
  });

  it("interrupts authorizations and jobs on restart instead of resuming them", async () => {
    const hang = vi.fn(() => new Promise<never>(() => {})) as unknown as typeof gen3dHostCall;
    const engine = new Gen3DEngine(root, hang);
    let p = await project(engine);
    p = (
      await engine.command({
        operation: "start-run",
        projectId: p.id,
        revision: p.revision,
        maxRounds: 3,
      })
    ).project!;
    await engine.command({
      operation: "submit",
      projectId: p.id,
      revision: p.revision,
      build: build(),
      requestId: "a",
      turnId: "t1",
    });
    const restarted = new Gen3DEngine(root, makeHost());
    await restarted.initialize();
    p = await restarted.get(p.id);
    expect(p.jobs[0]!.status).toBe("interrupted");
    expect(p.runs[0]).toMatchObject({ status: "interrupted", stopReason: "restart" });
  });

  it("keeps a conversation bound to one project and detaches on delete", async () => {
    const engine = new Gen3DEngine(root, makeHost());
    const p = await project(engine);
    const other = (await engine.command({ operation: "create", name: "Other" })).project!;
    await expect(
      engine.command({
        operation: "bind-thread",
        projectId: other.id,
        revision: other.revision,
        threadId: "thread-1",
      }),
    ).rejects.toThrow(/another 3D project/);
    await engine.detachThread("thread-1");
    expect((await engine.get(p.id)).threadId).toBeNull();
  });
});
