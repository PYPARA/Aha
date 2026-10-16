import { expect, it } from "vitest";
import { deriveWorkLogEntries, extractSpritePlanPointer } from "./workLog";
import { makeActivity } from "./storeTestFixtures";
import { isSummarizableToolCallEntry } from "./components/chat/toolCallGroup.logic";
const pointer = { projectId: "project", planId: "plan", threadId: "thread" };
it("keeps a recognized sprite proposal visible outside collapsed tool groups", () => {
  const activities = [
    makeActivity({
      id: "proposal",
      kind: "tool.completed",
      summary: "Sprite generation",
      payload: {
        itemType: "mcp_tool_call",
        data: {
          toolName: "mcp__synara__sprite_animation",
          result: { content: [{ type: "text", text: JSON.stringify({ spritePlan: pointer }) }] },
        },
      },
    }),
  ];
  const entries = deriveWorkLogEntries(activities, undefined);
  expect(entries[0]?.spritePlan).toEqual(pointer);
  expect(isSummarizableToolCallEntry(entries[0]!)).toBe(false);
  const foreign = deriveWorkLogEntries(
    [
      makeActivity({
        id: "foreign",
        kind: "tool.completed",
        summary: "Other",
        payload: {
          itemType: "mcp_tool_call",
          data: { toolName: "other_tool", result: { spritePlan: pointer } },
        },
      }),
    ],
    undefined,
  );
  expect(foreign[0]?.spritePlan).toBeUndefined();
});
it("rejects malformed plan pointers and prose", () => {
  expect(extractSpritePlanPointer("Assistant says plan: plan")).toBeUndefined();
  expect(
    extractSpritePlanPointer({ spritePlan: { ...pointer, planId: "../../path" } }),
  ).toBeUndefined();
});
it("recognizes the persisted Codex MCP retry result and retains its card across lifecycle updates", () => {
  const item = {
    type: "mcpToolCall",
    id: "call-retry",
    server: "synara",
    tool: "sprite_animation",
    arguments: { operation: "retry", runId: "run" },
  };
  const entries = deriveWorkLogEntries(
    [
      makeActivity({
        id: "start",
        kind: "tool.started",
        summary: "sprite_animation",
        payload: {
          itemType: "mcp_tool_call",
          data: { item: { ...item, status: "inProgress", result: null } },
        },
      }),
      makeActivity({
        id: "done",
        kind: "tool.completed",
        summary: "sprite_animation",
        payload: {
          itemType: "mcp_tool_call",
          data: {
            item: {
              ...item,
              status: "completed",
              result: {
                content: [
                  { type: "text", text: JSON.stringify({ spritePlan: pointer, submitted: false }) },
                ],
              },
            },
          },
        },
      }),
    ],
    undefined,
  );
  expect(entries).toHaveLength(1);
  expect(entries[0]?.spritePlan).toEqual(pointer);
});
