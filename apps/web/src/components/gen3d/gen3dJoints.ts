// Joints being edited, shared between the joint editor (2D renders, list, confirm) and the 3D
// viewer (drag the joints on the model). Positions are in the model's glTF space, metres.
import type { Gen3DSkeletonNode } from "@synara/contracts";
import { moveJoint } from "./skeletonJoints";

const UNDO_LIMIT = 50;
const round = (n: number) => Math.round(n * 10000) / 10000;

export class Gen3DJointSession {
  joints: Gen3DSkeletonNode[];
  selected: string;
  mirror = true;
  private undoStack: Gen3DSkeletonNode[][] = [];
  private listeners = new Set<() => void>();
  private revision = 0;
  /** The joints at the start of the current drag (one undo step per drag). */
  private dragStart: Gen3DSkeletonNode[] | null = null;
  constructor(initial: readonly Gen3DSkeletonNode[]) {
    this.joints = [...initial];
    this.selected = initial[0]?.id ?? "";
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  snapshot = () => this.revision;
  private emit() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  get canUndo() {
    return this.undoStack.length > 0;
  }
  /** Replaces the joints (saved joints changed); keeps the selection when it still exists. */
  reset(joints: readonly Gen3DSkeletonNode[]) {
    this.joints = [...joints];
    if (!joints.some((j) => j.id === this.selected)) this.selected = joints[0]?.id ?? "";
    this.undoStack = [];
    this.dragStart = null;
    this.emit();
  }
  select(id: string) {
    if (id === this.selected || !this.joints.some((j) => j.id === id)) return;
    this.selected = id;
    this.emit();
  }
  setMirror(mirror: boolean) {
    this.mirror = mirror;
    this.emit();
  }
  beginDrag() {
    this.dragStart ??= this.joints;
  }
  endDrag() {
    const start = this.dragStart;
    this.dragStart = null;
    if (start && start !== this.joints) this.pushUndo(start);
  }
  private pushUndo(joints: Gen3DSkeletonNode[]) {
    this.undoStack.push(joints);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
  }
  /** Moves a joint (and its mirrored partner when mirroring); a single move outside a drag is
   * its own undo step. */
  move(id: string, position: readonly number[]) {
    const before = this.joints;
    const next = moveJoint(
      before,
      id,
      [round(position[0]!), round(position[1]!), round(position[2]!)],
      this.mirror,
    );
    if (next.every((j, i) => j.position.every((v, k) => v === before[i]!.position[k]))) return;
    if (!this.dragStart) this.pushUndo(before);
    this.joints = next;
    this.emit();
  }
  undo() {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.dragStart = null;
    this.joints = previous;
    this.emit();
  }
}
