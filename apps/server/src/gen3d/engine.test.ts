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
  objects: [{ id: "body", name: "Body", triangles: 1 }],
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
function makeHost(options: { offset?: number } = {}): typeof gen3dHostCall {
  const host = vi.fn(async (method: string, input: Record<string, unknown>) => {
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
    return { report, topology: { boundaryEdges: 0, nonManifoldEdges: 0 } };
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
