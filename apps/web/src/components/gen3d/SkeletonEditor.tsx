import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { Gen3DProject, Gen3DSkeletonNode, Gen3DVersion } from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { OptionSelect } from "../ui/option-select";
import { Gen3DJointSession } from "./gen3dJoints";
import { RENDER_SIZE, fromRender, toRender, type Dimensions } from "./skeletonJoints";
import { gen3dAssetUrl } from "./useGen3D";

const VIEWS = [
  { view: "front", file: "render-front.png", label: "Front" },
  { view: "side", file: "render-side.png", label: "Side" },
] as const;

/**
 * Joints over the version's front and side renders: drag them, or pick one and use arrows. The
 * same joints can be dragged on the model in the 3D viewer through the shared session.
 */
export function SkeletonEditor({
  project,
  version,
  initial,
  status,
  disabled,
  onConfirm,
  onDiscard,
  onSession,
}: {
  project: Gen3DProject;
  version: Gen3DVersion;
  initial: readonly Gen3DSkeletonNode[];
  status: string;
  disabled: boolean;
  onConfirm: (joints: Gen3DSkeletonNode[]) => void;
  onDiscard: () => void;
  /** The editing session while the editor is open (the viewer drags the same joints). */
  onSession?: ((session: Gen3DJointSession | null) => void) | undefined;
}) {
  const tr = useAhaTranslation();
  const dims = version.report.dimensions as unknown as Dimensions;
  const [session] = useState(() => new Gen3DJointSession(initial));
  useSyncExternalStore(session.subscribe, session.snapshot);
  const { joints, selected, mirror } = session;
  const [dragging, setDragging] = useState<{ view: "front" | "side"; id: string } | null>(null);
  // Project refreshes create new arrays; only a change in the saved joints resets local edits.
  const saved = JSON.stringify(initial);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else session.reset(JSON.parse(saved) as Gen3DSkeletonNode[]);
  }, [saved]);
  const sessionCallback = useRef(onSession);
  sessionCallback.current = onSession;
  useEffect(() => {
    sessionCallback.current?.(session);
    return () => sessionCallback.current?.(null);
  }, [session]);
  const changed = JSON.stringify(joints) !== saved;
  const svgs = useRef<Record<string, SVGSVGElement | null>>({});
  const place = (view: "front" | "side", id: string, x: number, y: number) => {
    const joint = joints.find((j) => j.id === id);
    if (!joint) return;
    const clamp = (n: number) => Math.min(RENDER_SIZE, Math.max(0, n));
    session.move(id, fromRender(view, dims, joint.position, clamp(x), clamp(y)));
  };
  const pointer = (view: "front" | "side", event: PointerEvent) => {
    const box = svgs.current[view]!.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * RENDER_SIZE,
      y: ((event.clientY - box.top) / box.height) * RENDER_SIZE,
    };
  };
  const nudge = (view: "front" | "side", event: KeyboardEvent) => {
    const step = event.shiftKey ? 10 : 2;
    const delta = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }[event.key];
    const joint = joints.find((j) => j.id === selected);
    if (!delta || !joint || disabled) return;
    event.preventDefault();
    const at = toRender(view, dims, joint.position);
    place(view, joint.id, at.x + delta[0]!, at.y + delta[1]!);
  };
  return (
    <section className="space-y-3" aria-label={tr("Joints")}>
      <p className="text-ui-xs leading-relaxed text-muted-foreground">{status}</p>
      <div className="grid grid-cols-2 gap-2">
        {VIEWS.map(({ view, file, label }) => (
          <figure key={view} className="space-y-1">
            <div className="relative aspect-square overflow-hidden rounded-md border border-border bg-muted/40">
              <img
                src={gen3dAssetUrl(project.id, "versions", version.id, file)}
                alt=""
                className="absolute inset-0 size-full object-contain"
              />
              <svg
                ref={(node) => {
                  svgs.current[view] = node;
                }}
                viewBox={`0 0 ${RENDER_SIZE} ${RENDER_SIZE}`}
                className="absolute inset-0 size-full touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring"
                role="application"
                tabIndex={0}
                aria-label={`${tr(label)}: ${tr("Move the selected joint with the arrow keys (Shift for larger steps).")}`}
                onKeyDown={(event) => nudge(view, event)}
                onPointerMove={(event) => {
                  if (!dragging || dragging.view !== view) return;
                  const at = pointer(view, event);
                  place(view, dragging.id, at.x, at.y);
                }}
                onPointerUp={() => {
                  setDragging(null);
                  session.endDrag();
                }}
                onPointerCancel={() => {
                  setDragging(null);
                  session.endDrag();
                }}
              >
                {joints.map((joint) => {
                  const parent = joints.find((j) => j.id === joint.parent);
                  if (!parent) return null;
                  const a = toRender(view, dims, parent.position),
                    b = toRender(view, dims, joint.position);
                  return (
                    <line
                      key={joint.id}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      className="stroke-primary"
                      strokeWidth={3}
                      strokeOpacity={0.8}
                    />
                  );
                })}
                {joints.map((joint) => {
                  const at = toRender(view, dims, joint.position);
                  const active = joint.id === selected;
                  return (
                    <circle
                      key={joint.id}
                      cx={at.x}
                      cy={at.y}
                      r={active ? 9 : 6}
                      className={
                        active ? "fill-primary stroke-background" : "fill-background stroke-primary"
                      }
                      strokeWidth={2.5}
                      style={{ cursor: disabled ? "default" : "grab" }}
                      onPointerDown={(event) => {
                        if (disabled) return;
                        event.preventDefault();
                        (event.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(
                          event.pointerId,
                        );
                        session.select(joint.id);
                        session.beginDrag();
                        setDragging({ view, id: joint.id });
                      }}
                    >
                      <title>{joint.id}</title>
                    </circle>
                  );
                })}
              </svg>
            </div>
            <figcaption className="text-ui-xs text-muted-foreground">{tr(label)}</figcaption>
          </figure>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-40 flex-1">
          <OptionSelect
            label={tr("Selected joint")}
            value={selected}
            onValueChange={(id) => session.select(id)}
          >
            {joints.map((joint) => (
              <option key={joint.id} value={joint.id}>
                {joint.id}
              </option>
            ))}
          </OptionSelect>
        </div>
        <label className="flex items-center gap-2 text-ui-xs">
          <Checkbox
            checked={mirror}
            onCheckedChange={(value) => session.setMirror(value === true)}
          />
          {tr("Mirror left and right")}
        </label>
      </div>
      {onSession && (
        <p className="text-ui-xs leading-relaxed text-muted-foreground">
          {tr(
            "You can also drag the joints on the model in the viewer: they stay in front of the model, and turning the view moves them in depth.",
          )}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          variant="ghost"
          disabled={disabled || !session.canUndo}
          onClick={() => session.undo()}
        >
          {tr("Undo")}
        </Button>
        <Button className="flex-1" disabled={disabled} onClick={() => onConfirm(joints)}>
          {tr(changed ? "Save and confirm joints" : "Confirm joints")}
        </Button>
        <Button variant="ghost" disabled={disabled} onClick={onDiscard}>
          {tr("Discard joints")}
        </Button>
      </div>
    </section>
  );
}
