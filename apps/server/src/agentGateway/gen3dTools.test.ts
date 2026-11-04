import { expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import type { Gen3DProject } from "@synara/contracts";
import type { ToolContext } from "./toolRuntime";
const mocks = vi.hoisted(() => ({ forThread: vi.fn(), command: vi.fn(), root: "" }));
vi.mock("../gen3d/engine", () => ({
  gen3DEngine: async () => mocks,
  GEN3D_RENDERS: ["render-34.png", "render-front.png", "render-side.png", "render-back.png"],
}));
import { makeGen3DTools } from "./gen3dTools";

const context: ToolContext = {
  principal: {
    kind: "provider-session",
    sessionKey: "session",
    threadId: "thread",
    provider: "codex",
    turnId: "turn",
  },
  callerThreadId: "thread",
  callerThreadLabel: "Model",
  callerSessionKey: "session",
  callerProvider: "codex",
  callerCapabilities: new Set(["thread:write"]),
  callerTurnId: "turn",
  assertCallerTurnActive: () => Effect.void,
  jsonRpcRequestId: 1,
};
const project = (patch: Partial<Gen3DProject> = {}): Gen3DProject => ({
  schemaVersion: 1,
  id: "project",
  revision: 4,
  name: "Robot",
  description: "",
  updatedAt: "",
  triangleBudget: 5000,
  threadId: "thread",
  adoptedVersionId: null,
  previewVersionId: null,
  references: [],
  blueprint: null,
  versions: [],
  jobs: [],
  runs: [],
  archived: false,
  ...patch,
});
const tool = makeGen3DTools()[0]!;
const text = (result: unknown) => JSON.stringify(result);

it("submits for the live caller turn and never exposes adopt or export", async () => {
  mocks.forThread.mockResolvedValue(project());
  mocks.command.mockResolvedValue({ project: project() });
  const get = await Effect.runPromise(tool.handler({ operation: "get" }, context));
  expect(text(get)).toContain("baseRevision");
  expect(mocks.forThread).toHaveBeenCalledWith("thread");
  await Effect.runPromise(
    tool.handler(
      {
        operation: "submit",
        baseRevision: 4,
        requestId: "r1",
        build: { source: "function buildModel(){}", prompt: "robot", parentVersionId: null },
      },
      context,
    ),
  );
  expect(mocks.command).toHaveBeenLastCalledWith({
    operation: "submit",
    projectId: "project",
    revision: 4,
    requestId: "r1",
    turnId: "turn",
    build: { source: "function buildModel(){}", prompt: "robot", parentVersionId: null },
  });
  for (const operation of ["adopt", "export", "archive"]) {
    const result = await Effect.runPromise(tool.handler({ operation }, context));
    expect(text(result)).toContain("Unknown gen3d operation");
  }
});

it("returns blueprint, diff and render images from views", async () => {
  mocks.root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aha-gen3d-tool-")));
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  for (const view of ["front", "side", "back"]) {
    await fs.mkdir(path.join(mocks.root, "project", "blueprint"), { recursive: true });
    await fs.writeFile(path.join(mocks.root, "project", "blueprint", view + ".png"), png);
  }
  const files = ["diff-front.png", "diff-side.png", "diff-back.png", "render-34.png"];
  await fs.mkdir(path.join(mocks.root, "project", "versions", "v1"), { recursive: true });
  for (const name of files)
    await fs.writeFile(path.join(mocks.root, "project", "versions", "v1", name), png);
  const score = {
    score: 90,
    maxRegionPct: 1.2,
    views: {
      front: { iou: 0.9, contourPct: 1, shiftPx: 0 },
      side: { iou: 0.9, contourPct: 1, shiftPx: 0 },
      back: { iou: 0.9, contourPct: 1, shiftPx: 0 },
    },
    regions: [],
  };
  mocks.forThread.mockResolvedValue(
    project({
      blueprint: {
        referenceId: "ref",
        targetHeight: 1,
        pxPerMetre: 230,
        boxes: {} as never,
        confirmed: true,
        createdAt: "",
      },
      previewVersionId: "v1",
      versions: [
        {
          id: "v1",
          name: "v1",
          createdAt: "",
          build: { source: "", prompt: "", parentVersionId: null },
          hash: "",
          report: {} as never,
          topology: { boundaryEdges: 0, nonManifoldEdges: 0 },
          score,
          runId: null,
          round: null,
          files: files.map((name) => ({ name, hash: "", bytes: 8 })),
          runtime: { three: "0.186.1" },
        },
      ],
    }),
  );
  const result = (await Effect.runPromise(tool.handler({ operation: "views" }, context))) as {
    content: { type: string }[];
  };
  expect(result.content.filter((c) => c.type === "image")).toHaveLength(7);
  await fs.rm(mocks.root, { recursive: true, force: true });
});

it("refuses conversations that are not bound to a project", async () => {
  mocks.forThread.mockResolvedValue(null);
  const result = await Effect.runPromise(tool.handler({ operation: "get" }, context));
  expect(text(result)).toContain("not bound");
});
