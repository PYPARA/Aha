import { beforeEach, afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
vi.mock("electron", () => ({ BrowserWindow: vi.fn(), dialog: {}, ipcMain: {} }));
import { importModelFile, Model3DHost } from "./host";
let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aha-model-import-")));
});
afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(root, { recursive: true, force: true });
});
function makeHost(log: string[] = []) {
  return new Model3DHost(
    root,
    path.join(root, "runtime"),
    () => "",
    "",
    (m) => log.push(m),
  );
}
// Private members are reached directly so the stuck compiler can be simulated.
type Internals = {
  handle(method: string, input: Record<string, unknown>): Promise<unknown>;
  compile(task: { id: string }): Promise<unknown>;
  compilers: Map<string, () => void>;
  trace(jobId: string, phase: string): void;
};
async function writeJob() {
  const build = {
    mode: "threejs",
    source: "function buildModel({THREE}){return new THREE.Group()}",
    parameters: {},
    parameterDefinitions: [],
    parentVersionId: null,
    prompt: "",
    materialEdits: [],
  };
  const project = {
    schemaVersion: 1,
    id: "project",
    revision: 1,
    name: "Turret",
    updatedAt: "",
    mode: "threejs",
    triangleBudget: 5000,
    textureBudget: 2048,
    threadId: null,
    adoptedVersionId: null,
    previewVersionId: null,
    versions: [],
    jobs: [
      {
        id: "job",
        requestId: "request",
        fingerprint: "",
        createdAt: "",
        status: "running",
        build,
        error: null,
        versionId: null,
      },
    ],
    textures: [],
    archived: false,
  };
  await fs.mkdir(path.join(root, "project", "jobs", "job"), { recursive: true });
  await fs.writeFile(path.join(root, "project", "project.json"), JSON.stringify(project));
  await fs.writeFile(
    path.join(root, "project", "jobs", "job", "input.json"),
    JSON.stringify({ build, parent: null, textures: [] }),
  );
}
it("answers a stuck build with the phase it stopped in and stops the compiler", async () => {
  await writeJob();
  const log: string[] = [],
    host = makeHost(log) as unknown as Internals;
  let started!: () => void;
  const compiling = new Promise<void>((resolve) => (started = resolve));
  const stopped = vi.fn();
  host.compile = (task) =>
    new Promise((_, reject) => {
      host.trace(task.id, "compiling");
      host.compilers.set(task.id, () => {
        stopped();
        reject(new Error("Model task cancelled."));
      });
      started();
    });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const result = host.handle("build", { projectId: "project", jobId: "job" });
  const settled = expect(result).rejects.toThrow(
    "Model host did not finish within 90 s (stuck at: compiling). The task was stopped.",
  );
  await compiling;
  await vi.advanceTimersByTimeAsync(90_000);
  await settled;
  expect(stopped).toHaveBeenCalledOnce();
  expect(log[0]).toBe("job job build received");
  expect(log).toContainEqual(expect.stringMatching(/^job job compiling \+\d+ms$/));
  expect(log.at(-1)).toMatch(/^job job failed: Model host did not finish within 90 s/);
});
it("quits without waiting for a request the host never answers", async () => {
  const host = makeHost(),
    internals = host as unknown as Internals;
  let received!: () => void;
  const arrived = new Promise<void>((resolve) => (received = resolve));
  internals.handle = () => {
    received();
    return new Promise(() => {});
  };
  await host.start();
  const request = http.request({
    socketPath: host.pipe,
    path: "/build",
    method: "POST",
    headers: { authorization: "Bearer " + host.token },
  });
  const closed = new Promise((resolve) => request.on("error", resolve));
  request.end("{}");
  await arrived;
  const started = Date.now();
  await host.dispose();
  expect(Date.now() - started).toBeLessThan(1_000);
  await closed;
  await expect(fs.stat(host.pipe)).rejects.toThrow();
});
it("embeds a complete glTF package while refusing remote, missing and escaping resources", async () => {
  await fs.mkdir(path.join(root, "package"));
  const file = path.join(root, "package", "model.gltf");
  await fs.writeFile(path.join(root, "package", "mesh.bin"), Buffer.from([0, 1, 2]));
  const write = async (uri: string) =>
    fs.writeFile(
      file,
      JSON.stringify({ asset: { version: "2.0" }, buffers: [{ byteLength: 3, uri }] }),
    );
  await write("mesh.bin");
  const result = JSON.parse(new TextDecoder().decode(await importModelFile(file)));
  expect(result.buffers[0].uri).toBe("data:application/octet-stream;base64,AAEC");
  await write("https://example.com/mesh.bin");
  await expect(importModelFile(file)).rejects.toThrow("Remote");
  await write("missing.bin");
  await expect(importModelFile(file)).rejects.toThrow();
  await fs.writeFile(path.join(root, "secret.bin"), "secret");
  await write("../secret.bin");
  await expect(importModelFile(file)).rejects.toThrow("escapes");
  await fs.symlink(path.join(root, "secret.bin"), path.join(root, "package", "linked.bin"));
  await write("linked.bin");
  await expect(importModelFile(file)).rejects.toThrow("escapes");
  await write("%2Fetc%2Fpasswd");
  await expect(importModelFile(file)).rejects.toThrow("absolute");
});
it("refuses oversized imports before reading or decoding them", async () => {
  const file = path.join(root, "large.glb"),
    handle = await fs.open(file, "w");
  await handle.truncate(100 * 1024 * 1024 + 1);
  await handle.close();
  await expect(importModelFile(file)).rejects.toThrow("100 MiB");
});
