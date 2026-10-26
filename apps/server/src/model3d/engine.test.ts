import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Model3DEngine } from "./engine";
import { ModelHostTimeoutError, type modelHostCall } from "./hostClient";
import type { Model3DBuild, Model3DProject, Model3DValidationReport } from "@synara/contracts";

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aha-model-test-")));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const build: Model3DBuild = {
  mode: "threejs",
  source: "function buildModel(){return group}",
  parameters: { width: 1 },
  parameterDefinitions: [{ key: "width", label: "Width", type: "number" }],
  parentVersionId: null,
  prompt: "a prop",
  materialEdits: [],
};
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
function makeHost() {
  return vi.fn(async (method: string, input: Record<string, unknown>, signal?: AbortSignal) => {
    if (method === "build" || method === "import") {
      if (signal?.aborted) throw new Error("Cancelled");
      const directory = path.join(root, String(input.projectId), "jobs", String(input.jobId));
      await fs.writeFile(path.join(directory, "model.glb"), triangleGlb());
      await fs.writeFile(path.join(directory, "thumbnail.png"), new Uint8Array());
      return { report, hasBlend: false };
    }
    return {};
  });
}
async function wait(engine: Model3DEngine, projectId: string) {
  for (let count = 0; count < 200; count++) {
    const project = await engine.get(projectId);
    if (!project.jobs.some((j) => ["queued", "running", "validating"].includes(j.status)))
      return project;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Task did not settle");
}
async function create(engine: Model3DEngine) {
  return (await engine.command({ operation: "create", name: "Chest" })).project!;
}
async function submit(
  engine: Model3DEngine,
  project: Model3DProject,
  input = build,
  requestId = "request-1",
) {
  await engine.command({
    operation: "submit",
    projectId: project.id,
    revision: project.revision,
    build: input,
    requestId,
  });
  return wait(engine, project.id);
}

describe("3D immutable projects and task publication", () => {
  it("publishes candidates, adopts explicitly, restores history and keeps files after conversation deletion", async () => {
    const host = makeHost(),
      engine = new Model3DEngine(root, host as typeof modelHostCall);
    await engine.initialize();
    let project: Model3DProject = await submit(engine, await create(engine));
    expect(project.jobs[0]?.status).toBe("succeeded");
    expect(project.versions).toHaveLength(1);
    expect(project.adoptedVersionId).toBeNull();
    const first = project.versions[0]!;
    await engine.command({
      operation: "adopt",
      projectId: project.id,
      revision: project.revision,
      versionId: first.id,
    });
    project = await engine.get(project.id);
    project = await submit(
      engine,
      project,
      { ...build, parentVersionId: first.id, parameters: { width: 2 } },
      "request-2",
    );
    expect(project.versions).toHaveLength(2);
    expect(project.adoptedVersionId).toBe(first.id);
    project = (
      await engine.command({
        operation: "bind-thread",
        projectId: project.id,
        revision: project.revision,
        threadId: "chat",
      })
    ).project!;
    await engine.detachThread("chat");
    const restored = new Model3DEngine(root, host as typeof modelHostCall);
    await restored.initialize();
    project = await restored.get(project.id);
    expect(project.threadId).toBeNull();
    expect(project.adoptedVersionId).toBe(first.id);
    expect(project.versions[1]!.build.parameters.width).toBe(2);
    await restored.verifyVersion(project.id, first);
    expect((await restored.read(project.id, first.id, "model.glb")).subarray(0, 4).toString()).toBe(
      "glTF",
    );
    await expect(restored.read(project.id, first.id, "../project.json")).rejects.toThrow();
    await expect(
      restored.command({
        operation: "export",
        projectId: project.id,
        revision: project.revision,
        versionId: project.versions[1]!.id,
      }),
    ).rejects.toThrow("explicitly adopted");
  });
  it("does not publish corrupt output or overwrite the last adopted model", async () => {
    const host = makeHost(),
      engine = new Model3DEngine(root, host as typeof modelHostCall);
    await engine.initialize();
    let project: Model3DProject = await submit(engine, await create(engine));
    const first = project.versions[0]!;
    project = (
      await engine.command({
        operation: "adopt",
        projectId: project.id,
        revision: project.revision,
        versionId: first.id,
      })
    ).project!;
    host.mockImplementationOnce(async (_method, input) => {
      await fs.writeFile(
        path.join(root, String(input.projectId), "jobs", String(input.jobId), "model.glb"),
        "broken",
      );
      return { report, hasBlend: false };
    });
    project = await submit(engine, project, { ...build, source: "broken candidate" }, "bad-result");
    expect(project.jobs.at(-1)?.status).toBe("failed");
    expect(project.versions).toHaveLength(1);
    expect(project.adoptedVersionId).toBe(first.id);
    await engine.verifyVersion(project.id, first);
    expect(project.jobs.at(-1)?.build.source).toBe("broken candidate");
  });
  it("fails a build the host never answers and tells the host to stop it", async () => {
    const host = makeHost(),
      engine = new Model3DEngine(root, host as typeof modelHostCall);
    await engine.initialize();
    host.mockImplementationOnce(async () => {
      throw new ModelHostTimeoutError();
    });
    const project = await submit(engine, await create(engine));
    expect(project.jobs.at(-1)).toMatchObject({ status: "failed", error: "Model host timed out." });
    expect(host).toHaveBeenCalledWith("cancel", { jobId: project.jobs.at(-1)!.id });
  });
  it("deduplicates a stable request and rejects stale or conflicting writes", async () => {
    const host = makeHost(),
      engine = new Model3DEngine(root, host as typeof modelHostCall);
    await engine.initialize();
    const original = await create(engine);
    let project: Model3DProject = await submit(engine, original);
    await engine.command({
      operation: "submit",
      projectId: original.id,
      revision: original.revision,
      build,
      requestId: "request-1",
    });
    expect(host).toHaveBeenCalledTimes(1);
    await expect(
      engine.command({
        operation: "submit",
        projectId: project.id,
        revision: project.revision,
        build: { ...build, source: "different" },
        requestId: "request-1",
      }),
    ).rejects.toThrow("different model source");
    const changes = await Promise.allSettled([
      engine.command({
        operation: "update",
        projectId: project.id,
        revision: project.revision,
        name: "A",
      }),
      engine.command({
        operation: "update",
        projectId: project.id,
        revision: project.revision,
        name: "B",
      }),
    ]);
    expect(changes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    project = await engine.get(project.id);
    await expect(
      engine.command({
        operation: "submit",
        projectId: project.id,
        revision: project.revision,
        build: { ...build, source: "x".repeat(1024 * 1024 + 1) },
      }),
    ).rejects.toThrow();
    await expect(
      engine.command({
        operation: "submit",
        projectId: project.id,
        revision: project.revision,
        build: { ...build, materialEdits: [{ materialId: "wood", baseColor: "missing" }] },
      }),
    ).rejects.toThrow("Texture does not belong");
  });
  it("cancels only the owned task and never submits another build", async () => {
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const host = vi.fn(
      async (method: string, _input: Record<string, unknown>, signal?: AbortSignal) => {
        if (method === "cancel") return {};
        started();
        return new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
        );
      },
    );
    const engine = new Model3DEngine(root, host as typeof modelHostCall);
    await engine.initialize();
    let project = await create(engine);
    project = (
      await engine.command({
        operation: "submit",
        projectId: project.id,
        revision: project.revision,
        build,
        requestId: "cancel-me",
      })
    ).project!;
    await ready;
    project = await engine.get(project.id);
    await engine.command({
      operation: "cancel",
      projectId: project.id,
      revision: project.revision,
      jobId: project.jobs[0]!.id,
    });
    project = await wait(engine, project.id);
    expect(project.jobs[0]!.status).toBe("cancelled");
    expect(project.versions).toHaveLength(0);
    expect(host.mock.calls.filter((c) => c[0] === "build")).toHaveLength(1);
  });
  it("binds a conversation to only one project when two projects race", async () => {
    const engine = new Model3DEngine(root, makeHost() as typeof modelHostCall);
    await engine.initialize();
    const projects = await Promise.all([create(engine), create(engine)]);
    const results = await Promise.allSettled(
      projects.map((project) =>
        engine.command({
          operation: "bind-thread",
          projectId: project.id,
          revision: project.revision,
          threadId: "same-conversation",
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await engine.forThread("same-conversation"))?.id).toBe(projects[0]!.id);
  });
  it("recovers a committed version and interrupts uncertain work without replay", async () => {
    const host = makeHost(),
      engine = new Model3DEngine(root, host as typeof modelHostCall);
    await engine.initialize();
    let project: Model3DProject = await submit(engine, await create(engine));
    const version = project.versions[0]!;
    const mutable = {
      ...project,
      versions: [],
      jobs: project.jobs.map((j) => ({ ...j, status: "running", versionId: null })),
    };
    await fs.writeFile(path.join(root, project.id, "project.json"), JSON.stringify(mutable));
    const recovered = new Model3DEngine(root, host as typeof modelHostCall);
    await recovered.initialize();
    project = await recovered.get(project.id);
    expect(project.versions[0]?.id).toBe(version.id);
    expect(project.jobs[0]?.status).toBe("succeeded");
    expect(host).toHaveBeenCalledTimes(1);
    await fs.writeFile(
      path.join(root, project.id, "project.json"),
      JSON.stringify({
        ...project,
        jobs: [
          ...project.jobs,
          { ...project.jobs[0], id: "uncertain", status: "running", versionId: null },
        ],
      }),
    );
    await recovered.initialize();
    expect((await recovered.get(project.id)).jobs.at(-1)?.status).toBe("interrupted");
    expect(host).toHaveBeenCalledTimes(1);
  });
  it("rejects path traversal and symlink project directories", async () => {
    const engine = new Model3DEngine(root, makeHost() as typeof modelHostCall);
    await engine.initialize();
    await expect(engine.get("../outside")).rejects.toThrow();
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(root, "linked"));
    await expect(engine.get("linked")).rejects.toThrow(/symbolic/i);
  });
});
