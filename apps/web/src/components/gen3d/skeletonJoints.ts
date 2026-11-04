// Joint templates and the mapping between joints and the version's orthographic renders.
import type { Gen3DSkeletonNode } from "@synara/contracts";

type Joint = {
  id: string;
  parent: string | null;
  position: [number, number, number];
  radius: number;
};
export type Dimensions = readonly [number, number, number];

/** Runtime renders are 512 px orthographic views spanning 1.2 times the longest side,
 * centred on the bottom-centred model (see gen3dRuntime renders). */
export const RENDER_SIZE = 512;
const span = (d: Dimensions) => Math.max(d[0], d[1], d[2], 1e-6) * 1.2;

/** Model point -> render pixel. Front: x right, y up. Side (camera at +X): -z right, y up. */
export function toRender(view: "front" | "side", d: Dimensions, p: readonly number[]) {
  const scale = RENDER_SIZE / span(d);
  const u = view === "front" ? p[0]! : -p[2]!;
  return { x: RENDER_SIZE / 2 + u * scale, y: RENDER_SIZE / 2 - (p[1]! - d[1] / 2) * scale };
}

/** Render pixel -> the two coordinates that view controls, keeping the third. */
export function fromRender(
  view: "front" | "side",
  d: Dimensions,
  p: readonly number[],
  x: number,
  y: number,
): [number, number, number] {
  const scale = RENDER_SIZE / span(d);
  const u = (x - RENDER_SIZE / 2) / scale,
    up = d[1] / 2 - (y - RENDER_SIZE / 2) / scale;
  const round = (n: number) => Math.round(n * 10000) / 10000;
  return view === "front" ? [round(u), round(up), p[2]!] : [p[0]!, round(up), round(-u)];
}

/** The mirrored partner of a joint id (thigh_l <-> thigh_r), if the id is sided. */
export function mirrorId(id: string) {
  const match = /^(.*)_(l|r)$/.exec(id);
  return match ? `${match[1]}_${match[2] === "l" ? "r" : "l"}` : null;
}

/** Moves one joint and, when mirroring, its partner to the mirrored x. */
export function moveJoint(
  joints: readonly Gen3DSkeletonNode[],
  id: string,
  position: [number, number, number],
  mirror: boolean,
): Gen3DSkeletonNode[] {
  const partner = mirror ? mirrorId(id) : null;
  return joints.map((j) =>
    j.id === id
      ? { ...j, position }
      : j.id === partner
        ? { ...j, position: [-position[0], position[1], position[2]] as const }
        : j,
  );
}

/** A starting rig scaled to the model's bounds; the user drags joints onto the body. */
export function templateSkeleton(kind: "biped" | "quadruped", d: Dimensions): Gen3DSkeletonNode[] {
  const [w, h, depth] = d,
    r = Math.max(w, h, depth) * 0.03;
  const at = (id: string, parent: string | null, x: number, y: number, z: number): Joint => ({
    id,
    parent,
    position: [x * w, y * h, z * depth],
    radius: r,
  });
  const sided = (make: (side: "l" | "r", s: 1 | -1) => Joint[]) => [
    ...make("l", 1),
    ...make("r", -1),
  ];
  const joints: Joint[] =
    kind === "biped"
      ? [
          at("hips", null, 0, 0.5, 0),
          at("spine", "hips", 0, 0.6, 0),
          at("chest", "spine", 0, 0.7, 0),
          at("neck", "chest", 0, 0.8, 0),
          at("head", "neck", 0, 0.9, 0),
          ...sided((side, s) => [
            at(`upperarm_${side}`, "chest", 0.3 * s, 0.76, 0),
            at(`forearm_${side}`, `upperarm_${side}`, 0.38 * s, 0.6, 0),
            at(`hand_${side}`, `forearm_${side}`, 0.42 * s, 0.46, 0),
            at(`thigh_${side}`, "hips", 0.12 * s, 0.46, 0),
            at(`shin_${side}`, `thigh_${side}`, 0.12 * s, 0.25, 0),
            at(`foot_${side}`, `shin_${side}`, 0.12 * s, 0.04, 0.15),
          ]),
        ]
      : [
          at("hips", null, 0, 0.55, -0.3),
          at("spine", "hips", 0, 0.58, 0),
          at("chest", "spine", 0, 0.58, 0.25),
          at("neck", "chest", 0, 0.7, 0.33),
          at("head", "neck", 0, 0.8, 0.4),
          ...sided((side, s) => [
            at(`upperarm_${side}`, "chest", 0.25 * s, 0.5, 0.28),
            at(`forearm_${side}`, `upperarm_${side}`, 0.25 * s, 0.25, 0.28),
            at(`hand_${side}`, `forearm_${side}`, 0.25 * s, 0.03, 0.3),
            at(`thigh_${side}`, "hips", 0.25 * s, 0.5, -0.3),
            at(`shin_${side}`, `thigh_${side}`, 0.25 * s, 0.25, -0.32),
            at(`foot_${side}`, `shin_${side}`, 0.25 * s, 0.03, -0.3),
          ]),
          at("tail_1", "hips", 0, 0.6, -0.42),
          at("tail_2", "tail_1", 0, 0.66, -0.5),
        ];
  return joints;
}
