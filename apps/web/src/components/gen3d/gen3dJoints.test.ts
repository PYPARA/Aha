import { describe, expect, it } from "vitest";
import { Gen3DJointSession } from "./gen3dJoints";

const joints = [
  { id: "hips", parent: null, position: [0, 0.5, 0] as const, radius: 0.05 },
  { id: "thigh_l", parent: "hips", position: [0.1, 0.45, 0] as const, radius: 0.03 },
  { id: "thigh_r", parent: "hips", position: [-0.1, 0.45, 0] as const, radius: 0.03 },
];

describe("Gen3DJointSession", () => {
  it("moves mirrored partners and makes one undo step per drag", () => {
    const session = new Gen3DJointSession(joints);
    session.beginDrag();
    session.move("thigh_l", [0.12, 0.4, 0.02]);
    session.move("thigh_l", [0.15, 0.38, 0.03]);
    session.endDrag();
    expect(session.joints.find((j) => j.id === "thigh_r")!.position).toEqual([-0.15, 0.38, 0.03]);
    session.move("hips", [0, 0.52, 0]);
    session.undo();
    expect(session.joints[0]!.position).toEqual([0, 0.5, 0]);
    session.undo();
    expect(session.joints[1]!.position).toEqual([0.1, 0.45, 0]);
    expect(session.canUndo).toBe(false);
  });
  it("keeps the selection across saved changes and ignores moves that change nothing", () => {
    const session = new Gen3DJointSession(joints);
    session.select("thigh_r");
    session.setMirror(false);
    session.move("thigh_r", [-0.1, 0.45, 0]);
    expect(session.canUndo).toBe(false);
    session.reset(joints.slice(0, 2));
    expect(session.selected).toBe("hips");
    session.reset(joints);
    session.select("thigh_l");
    session.reset(joints);
    expect(session.selected).toBe("thigh_l");
  });
});
