// A repaint mask painted on the model in the 3D viewer, shared between the viewer (which paints
// and shows it) and the repaint panel (brush settings, undo, render). One session per version.
import {
  createPaintGrid,
  encodePaintGrid,
  paintSphere,
  paintedCells,
  type PaintGrid,
} from "@synara/shared/gen3dPaintMask";

type Vec3 = [number, number, number];
const UNDO_LIMIT = 20;
/** Brush radius range as a share of the model's bounding diagonal. */
export const BRUSH_MIN = 0.005,
  BRUSH_MAX = 0.2;

export class Gen3DPaintSession {
  grid: PaintGrid | null = null;
  /** Brush radius as a share of the model's bounding diagonal. */
  radius = 0.04;
  erase = false;
  painted = 0;
  /** Bumps when the painted cells change (not for brush settings). */
  maskRevision = 0;
  /** The viewer's current camera, in glTF axes; what a custom view render uses. */
  camera: { direction: Vec3; up: Vec3 } | null = null;
  private undoStack: Uint8Array[] = [];
  private listeners = new Set<() => void>();
  private revision = 0;
  constructor(readonly versionId: string) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  snapshot = () => this.revision;
  private emit() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  /** The grid over the model's bounds, made on first use. */
  ensureGrid(min: Vec3, max: Vec3) {
    this.grid ??= createPaintGrid(min, max);
    return this.grid;
  }
  get diagonal() {
    const g = this.grid;
    return g ? Math.hypot(g.max[0] - g.min[0], g.max[1] - g.min[1], g.max[2] - g.min[2]) : 0;
  }
  /** Brush radius in metres (0 before the grid exists). */
  get radiusMetres() {
    return this.radius * this.diagonal;
  }
  get canUndo() {
    return this.undoStack.length > 0;
  }
  setBrush(brush: { radius?: number; erase?: boolean }) {
    if (brush.radius !== undefined)
      this.radius = Math.min(BRUSH_MAX, Math.max(BRUSH_MIN, brush.radius));
    if (brush.erase !== undefined) this.erase = brush.erase;
    this.emit();
  }
  beginStroke() {
    if (!this.grid) return;
    this.undoStack.push(this.grid.data.slice());
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
  }
  /** One brush dab; erase overrides the session's mode (Alt while painting). */
  dab(centre: Vec3, erase = this.erase) {
    return this.grid ? paintSphere(this.grid, centre, this.radiusMetres, erase) : false;
  }
  endStroke() {
    if (!this.grid) return;
    // A stroke that changed nothing does not need an undo step.
    const last = this.undoStack.at(-1);
    if (last && last.every((v, i) => v === this.grid!.data[i])) this.undoStack.pop();
    else this.maskRevision++;
    this.painted = paintedCells(this.grid);
    this.emit();
  }
  undo() {
    const previous = this.undoStack.pop();
    if (!previous || !this.grid) return;
    this.grid.data.set(previous);
    this.maskRevision++;
    this.painted = paintedCells(this.grid);
    this.emit();
  }
  clear() {
    if (!this.grid || !this.painted) return;
    this.beginStroke();
    this.grid.data.fill(0);
    this.endStroke();
  }
  encoded() {
    return this.grid ? encodePaintGrid(this.grid) : null;
  }
}
