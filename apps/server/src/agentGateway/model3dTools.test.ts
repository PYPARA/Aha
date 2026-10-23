import { expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { Model3DProject } from "@synara/contracts";
import { GatewayToolError, type ToolContext } from "./toolRuntime";
const mocks = vi.hoisted(() => ({ forThread: vi.fn(), command: vi.fn() }));
vi.mock("../model3d/engine", () => ({ model3DEngine: async () => mocks }));
import { makeModel3DTools } from "./model3dTools";
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
const project: Model3DProject = {
  schemaVersion: 1,
  id: "project",
  name: "Model",
  revision: 4,
  updatedAt: "",
  mode: "threejs",
  triangleBudget: 5000,
  textureBudget: 2048,
  threadId: "thread",
  adoptedVersionId: null,
  previewVersionId: null,
  versions: [],
  jobs: [],
  textures: [],
  archived: false,
};
const tool = makeModel3DTools()[0]!;
it("binds every read and submission to the live caller and does not expose adopt or export", async () => {
  mocks.forThread.mockResolvedValue(project);
  mocks.command.mockResolvedValue({ project });
  const get = await Effect.runPromise(tool.handler({ operation: "get" }, context));
  expect(JSON.stringify(get)).toContain("baseRevision");
  expect(mocks.forThread).toHaveBeenCalledWith("thread");
  const build = {
    mode: "threejs",
    source: "function buildModel(){}",
    parameters: {},
    parameterDefinitions: [],
    parentVersionId: null,
    prompt: "chest",
    materialEdits: [],
  };
  await Effect.runPromise(
    tool.handler(
      {
        operation: "submit",
        baseRevision: 4,
        requestId: "stable-request",
        projectId: "foreign",
        build,
      },
      context,
    ),
  );
  expect(mocks.command).toHaveBeenLastCalledWith({
    operation: "submit",
    projectId: "project",
    revision: 4,
    requestId: "stable-request",
    build,
  });
  const before = mocks.command.mock.calls.length;
  expect(
    JSON.stringify(await Effect.runPromise(tool.handler({ operation: "adopt" }, context))),
  ).toContain("Unknown");
  expect(mocks.command).toHaveBeenCalledTimes(before);
});
it("refuses missing bindings, stale turns and an unselected modeling route", async () => {
  mocks.forThread.mockResolvedValue(null);
  expect(
    JSON.stringify(await Effect.runPromise(tool.handler({ operation: "get" }, context))),
  ).toContain("not bound");
  mocks.forThread.mockResolvedValue(project);
  const build = {
    mode: "blender",
    source: "import bpy",
    parameters: {},
    parameterDefinitions: [],
    parentVersionId: null,
    prompt: "chest",
    materialEdits: [],
  };
  expect(
    JSON.stringify(
      await Effect.runPromise(
        tool.handler(
          { operation: "submit", baseRevision: 4, requestId: "request", build },
          context,
        ),
      ),
    ),
  ).toContain("mode changed");
  const stale = {
    ...context,
    assertCallerTurnActive: () =>
      Effect.fail(new GatewayToolError("inactive_turn", "inactive turn")),
  } satisfies ToolContext;
  expect(
    JSON.stringify(await Effect.runPromise(tool.handler({ operation: "get" }, stale))),
  ).toContain("inactive turn");
});
it("returns actionable validation and runtime errors to the model without dispatching invalid material data", async () => {
  mocks.forThread.mockResolvedValue(project);
  const build = {
    mode: "threejs",
    source: "function buildModel(){}",
    parameters: {},
    parameterDefinitions: [],
    parentVersionId: null,
    prompt: "prop",
    materialEdits: [],
  };
  const before = mocks.command.mock.calls.length;
  const invalid = await Effect.runPromise(
    tool.handler(
      {
        operation: "submit",
        baseRevision: 4,
        requestId: "invalid-material",
        build: { ...build, materialEdits: [{ materialId: "body", roughness: 2 }] },
      },
      context,
    ),
  );
  expect(JSON.stringify(invalid)).toContain("roughness");
  expect(mocks.command).toHaveBeenCalledTimes(before);
  mocks.command.mockRejectedValueOnce(new Error("The selected parent model is damaged."));
  const failed = await Effect.runPromise(
    tool.handler(
      {
        operation: "submit",
        baseRevision: 4,
        requestId: "runtime-error",
        build,
      },
      context,
    ),
  );
  expect(JSON.stringify(failed)).toContain("The selected parent model is damaged.");
});
