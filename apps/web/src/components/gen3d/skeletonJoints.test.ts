import { describe, expect, it } from "vitest";
import { fromRender, mirrorId, moveJoint, templateSkeleton, toRender } from "./skeletonJoints";

const dims = [0.4, 1.0, 0.3] as const;
describe("skeletonJoints", () => {
  it("maps joints to the runtime's orthographic renders and back", () => {
    expect(toRender("front", dims, [0, 0.5, 0])).toEqual({ x: 256, y: 256 });
    // 1.2 m span over 512 px: the model's top is 0.5 m above the centre.
    expect(toRender("front", dims, [0, 1, 0]).y).toBeCloseTo(256 - (0.5 * 512) / 1.2);
    // Side view: the model's front (+Z) is on the left.
    expect(toRender("side", dims, [0, 0.5, 0.1]).x).toBeLessThan(256);
    const p = [0.1, 0.7, -0.05] as const;
    const front = toRender("front", dims, p),
      side = toRender("side", dims, p);
    expect(fromRender("front", dims, p, front.x, front.y)).toEqual([0.1, 0.7, -0.05]);
    expect(fromRender("side", dims, p, side.x, side.y)).toEqual([0.1, 0.7, -0.05]);
  });
  it("mirrors sided joints", () => {
    expect(mirrorId("thigh_l")).toBe("thigh_r");
    expect(mirrorId("hips")).toBeNull();
    const joints = templateSkeleton("biped", dims);
    const moved = moveJoint(joints, "hand_l", [0.3, 0.4, 0.02], true);
    expect(moved.find((j) => j.id === "hand_r")!.position).toEqual([-0.3, 0.4, 0.02]);
    expect(
      moveJoint(joints, "hand_l", [0.3, 0.4, 0.02], false).find((j) => j.id === "hand_r"),
    ).toEqual(joints.find((j) => j.id === "hand_r"));
  });
  it("scales templates to the model and keeps quadruped feet on the ground", () => {
    const biped = templateSkeleton("biped", dims);
    expect(biped).toHaveLength(17);
    expect(biped.every((j) => Math.abs(j.position[0]) <= 0.2 && j.position[1] <= 1)).toBe(true);
    const quadruped = templateSkeleton("quadruped", [0.2, 0.4, 0.6]);
    expect(quadruped.find((j) => j.id === "hand_l")!.position[1]).toBeLessThan(0.3 * 0.4);
  });
});
