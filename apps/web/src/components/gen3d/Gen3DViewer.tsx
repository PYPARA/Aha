import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { Gen3DProject, Gen3DVersion } from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { PauseIcon, PlayIcon, RotateCcwIcon } from "~/lib/icons";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { OptionSelect } from "../ui/option-select";
import { PreviewSurface } from "../ui/preview-surface";
import {
  BLUEPRINT_VIEWS,
  DISPLAY_MODES,
  channelMaterial,
  checkerTexture,
  disposeScene,
  loadGen3DModel,
  overlayFrame,
  weightColors,
  type BlueprintView,
  type DisplayMode,
} from "./gen3dViewerScene";
import { gen3dAssetUrl } from "./useGen3D";
import type { Gen3DPaintSession } from "./gen3dPaint";

type Vec3 = [number, number, number];
/** Shows painted cells (value at least one half) on the surface, as the texture script reads them. */
function paintOverlayMaterial(
  color: THREE.Color,
  uniforms: {
    ahaMask: { value: THREE.Data3DTexture | null };
    ahaMin: { value: THREE.Vector3 };
    ahaSize: { value: THREE.Vector3 };
  },
) {
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
    side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vAhaWorld;")
      .replace(
        "#include <project_vertex>",
        "#include <project_vertex>\nvAhaWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nprecision highp sampler3D;\nuniform sampler3D ahaMask;\nuniform vec3 ahaMin;\nuniform vec3 ahaSize;\nvarying vec3 vAhaWorld;",
      )
      .replace(
        "#include <dithering_fragment>",
        "#include <dithering_fragment>\nif (texture(ahaMask, (vAhaWorld - ahaMin) / ahaSize).r < 0.5) discard;",
      );
  };
  material.customProgramCacheKey = () => "aha-paint-mask";
  return material;
}

const MODE_LABELS: Record<DisplayMode, string> = {
  material: "Materials (PBR)",
  color: "Base colour",
  normal: "Normal",
  roughness: "Roughness",
  metalness: "Metalness",
  occlusion: "Ambient occlusion",
  uv: "UV checker",
  wireframe: "Wireframe",
  solid: "Solid",
  weights: "Skin weights",
};
const VIEW_LABELS: Record<BlueprintView, string> = { front: "Front", side: "Side", back: "Back" };

interface Loaded {
  root: THREE.Group;
  animations: THREE.AnimationClip[];
}
async function fetchModel(url: string, signal: AbortSignal): Promise<Loaded> {
  const response = await fetch(url, { credentials: "include", signal });
  if (!response.ok) throw new Error("Could not load the model file.");
  const { scene, animations } = await loadGen3DModel(new Uint8Array(await response.arrayBuffer()));
  return { root: scene, animations };
}
/** A theme colour token as three.js can read it (tokens may be oklch). */
function themeColor(element: HTMLElement, token = "--primary") {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  context.fillStyle = getComputedStyle(element).getPropertyValue(token).trim() || "#3b82f6";
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return new THREE.Color(r! / 255, g! / 255, b! / 255);
}
/** Outline plus a faint fill of a black-and-white blueprint silhouette. */
function silhouetteMaterial(texture: THREE.Texture, color: THREE.Color) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: { map: { value: texture }, tint: { value: color } },
    vertexShader:
      "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `uniform sampler2D map; uniform vec3 tint; varying vec2 vUv;
      float inside(vec2 p) { return step(0.5, texture2D(map, p).r); }
      void main() {
        float c = inside(vUv), d = 1.5 / 256.0;
        float edge = abs(c - inside(vUv + vec2(d, 0.0))) + abs(c - inside(vUv - vec2(d, 0.0)))
          + abs(c - inside(vUv + vec2(0.0, d))) + abs(c - inside(vUv - vec2(0.0, d)));
        float alpha = max(min(edge, 1.0) * 0.95, c * 0.18);
        gl_FragColor = vec4(tint, alpha);
      }`,
  });
}
const animatedFile = (version: Gen3DVersion) =>
  version.files.find((f) => f.name === "rigged.glb" || f.name === "animated.glb")?.name;

interface Settings {
  mode: DisplayMode;
  grid: boolean;
  bounds: boolean;
  skeleton: boolean;
  bone: string;
  overlay: "off" | BlueprintView;
  turntable: boolean;
}
interface Controls {
  highlight: (ids: readonly string[]) => void;
  setPaint: (session: Gen3DPaintSession | null) => void;
  paintChanged: () => void;
  reset: () => void;
  apply: (settings: Settings) => void;
  play: (clip: string, loop: boolean) => void;
  pause: (paused: boolean) => void;
}

/**
 * The 3D generation viewer: texture channels, UV checker, skin weights, reference overlay,
 * turntable, dimensions, animation playback and side-by-side version comparison, all in one
 * WebGL context.
 */
export function Gen3DViewer({
  project,
  version,
  selected = [],
  onSelect,
  paint = null,
}: {
  project: Gen3DProject;
  version: Gen3DVersion;
  /** While set, dragging on the model paints this repaint mask instead of picking parts. */
  paint?: Gen3DPaintSession | null;
  /** Part ids (ahaId) highlighted in the view; shared with the part lists in the panels. */
  selected?: readonly string[];
  /** A click on a part (additive with Cmd, Ctrl or Shift), or null for empty space. */
  onSelect?: (id: string | null, additive: boolean) => void;
}) {
  const tr = useAhaTranslation(),
    container = useRef<HTMLDivElement>(null),
    labels = useRef<HTMLDivElement>(null);
  const animated = animatedFile(version);
  const clips = version.process?.rig?.clips ?? version.process?.props?.clips ?? [];
  const canOverlay = !!project.blueprint && !!version.score;
  const [mode, setMode] = useState<DisplayMode>("material"),
    [grid, setGrid] = useState(true),
    [bounds, setBounds] = useState(false),
    [skeleton, setSkeleton] = useState(false),
    [bone, setBone] = useState(""),
    [bones, setBones] = useState<string[]>([]),
    [overlay, setOverlay] = useState<"off" | BlueprintView>("off"),
    [turntable, setTurntable] = useState(false),
    [clip, setClip] = useState(""),
    [paused, setPaused] = useState(false),
    [compareId, setCompareId] = useState(""),
    [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(true);
  const compare = project.versions.find((v) => v.id === compareId && v.id !== version.id);
  const controls = useRef<Controls | null>(null);
  const settings: Settings = {
    mode,
    grid,
    bounds,
    skeleton,
    bone,
    overlay: compare ? "off" : overlay,
    turntable,
  };
  const latest = useRef(settings);
  latest.current = settings;
  const selection = useRef(selected),
    onSelectRef = useRef(onSelect);
  selection.current = selected;
  onSelectRef.current = onSelect;
  const paintRef = useRef(paint);
  paintRef.current = paint;
  useEffect(() => controls.current?.highlight(selected), [selected.join("\n")]);
  // Painting works on the still, unscaled model: no clip, turntable, overlay or comparison.
  useEffect(() => {
    controls.current?.setPaint(paint);
    if (!paint) return;
    setClip("");
    setTurntable(false);
    setOverlay("off");
    setCompareId("");
    return paint.subscribe(() => controls.current?.paintChanged());
  }, [paint]);
  // Reset per-version choices when another version is shown.
  useEffect(() => {
    setClip("");
    setPaused(false);
    setOverlay("off");
    if (mode === "weights") setMode("material");
    setCompareId((current) => (current === version.id ? "" : current));
  }, [version.id]);
  useEffect(
    () => controls.current?.apply(settings),
    [mode, grid, bounds, skeleton, bone, overlay, turntable, compare?.id],
  );
  useEffect(() => {
    const entry = clips.find((c) => c.name === clip);
    controls.current?.play(clip, entry?.loop ?? false);
    setPaused(false);
  }, [clip]);
  useEffect(() => controls.current?.pause(paused), [paused]);

  const mainUrl = gen3dAssetUrl(project.id, "versions", version.id, animated ?? "model.glb");
  const compareUrl = compare
    ? gen3dAssetUrl(project.id, "versions", compare.id, "model.glb")
    : null;
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const abort = new AbortController();
    let cleaned = false,
      cleanup = () => {};
    const loadedRoots: THREE.Group[] = [];
    setLoading(true);
    setError(null);
    void (async () => {
      let renderer: THREE.WebGLRenderer | undefined;
      try {
        const main = await fetchModel(mainUrl, abort.signal);
        loadedRoots.push(main.root);
        const other = compareUrl ? await fetchModel(compareUrl, abort.signal) : null;
        if (other) loadedRoots.push(other.root);
        if (cleaned) return loadedRoots.forEach(disposeScene);
        renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
        renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.setClearColor(0, 0);
        element.appendChild(renderer.domElement);
        const scene = new THREE.Scene();
        // An environment map so metals reflect something instead of rendering black.
        const pmrem = new THREE.PMREMGenerator(renderer);
        const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
        scene.environment = environment;
        scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 1.4));
        const light = new THREE.DirectionalLight(0xffffff, 2);
        light.position.set(3, 5, 4);
        scene.add(light);
        scene.add(main.root);
        if (other) scene.add(other.root);
        const boxA = new THREE.Box3().setFromObject(main.root);
        const box = boxA.clone();
        if (other) box.union(new THREE.Box3().setFromObject(other.root));
        const center = box.getCenter(new THREE.Vector3()),
          diameter = Math.max(box.getSize(new THREE.Vector3()).length(), 0.01);
        const camera = new THREE.PerspectiveCamera(36, 1, diameter / 1000, diameter * 1000);
        const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, diameter / 1000, diameter * 1000);
        const orbit = new OrbitControls(camera, renderer.domElement);
        orbit.target.copy(center);
        orbit.minDistance = diameter * 0.02;
        orbit.maxDistance = diameter * 50;
        orbit.autoRotateSpeed = 4;
        const gridHelper = new THREE.GridHelper(Math.max(diameter * 2, 1), 20, 0x888888, 0x888888);
        gridHelper.position.y = box.min.y - 0.001;
        const gridMaterial = gridHelper.material as THREE.Material;
        gridMaterial.transparent = true;
        gridMaterial.opacity = 0.22;
        const boundsHelper = new THREE.Box3Helper(boxA, 0x888888);
        scene.add(gridHelper, boundsHelper);
        // Rest transforms, so leaving a clip returns props and skins to their published pose.
        const rest = new Map<THREE.Object3D, [THREE.Vector3, THREE.Quaternion, THREE.Vector3]>();
        main.root.traverse((o) =>
          rest.set(o, [o.position.clone(), o.quaternion.clone(), o.scale.clone()]),
        );
        const originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>(),
          geometries = new Map<THREE.Mesh, THREE.BufferGeometry>();
        for (const root of loadedRoots)
          root.traverse((o) => {
            if (o instanceof THREE.Mesh) {
              originals.set(o, o.material);
              geometries.set(o, o.geometry);
            }
          });
        const skinned = [...originals.keys()].filter(
          (m): m is THREE.SkinnedMesh => m instanceof THREE.SkinnedMesh,
        );
        const boneNames = skinned[0]?.skeleton.bones.map((b) => b.name) ?? [];
        setBones(boneNames);
        const skeletonHelper = skinned.length ? new THREE.SkeletonHelper(main.root) : null;
        if (skeletonHelper) scene.add(skeletonHelper);
        const mixer = new THREE.AnimationMixer(main.root);
        // Parts by stable id, for picking and highlighting.
        const partsById = new Map<string, THREE.Object3D>();
        main.root.traverse((o) => {
          const id = o.userData.ahaId;
          if (typeof id === "string" && !partsById.has(id)) partsById.set(id, o);
        });
        const highlights: THREE.Box3Helper[] = [];
        const highlightColor = themeColor(element);
        const highlight = (ids: readonly string[]) => {
          for (const helper of highlights.splice(0)) {
            scene.remove(helper);
            helper.dispose();
          }
          for (const id of ids) {
            const object = partsById.get(id);
            if (!object) continue;
            const helper = new THREE.Box3Helper(
              new THREE.Box3().setFromObject(object),
              highlightColor,
            );
            highlights.push(helper);
            scene.add(helper);
          }
          render();
        };
        const raycaster = new THREE.Raycaster(),
          pointer = new THREE.Vector2();
        const mainMeshes = [...originals.keys()].filter((m) => {
          let o: THREE.Object3D | null = m;
          while (o && o !== main.root) o = o.parent;
          return !!o;
        });
        const setPointer = (event: PointerEvent) => {
          const rect = renderer!.domElement.getBoundingClientRect();
          pointer.set(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            (-(event.clientY - rect.top) / rect.height) * 2 + 1,
          );
          raycaster.setFromCamera(pointer, camera);
        };
        // Mask painting: soft spheres into the session's voxel grid, shown by an overlay copy of
        // each mesh that only draws painted cells. The model's world space is its glTF space.
        let paintSession: Gen3DPaintSession | null = null,
          paintTexture: THREE.Data3DTexture | null = null,
          stroke: { last: THREE.Vector3; erase: boolean; pointer: number } | null = null;
        const paintUniforms = {
          ahaMask: { value: null as THREE.Data3DTexture | null },
          ahaMin: { value: new THREE.Vector3() },
          ahaSize: { value: new THREE.Vector3(1, 1, 1) },
        };
        // The accent (info) colour stays visible on any texture, unlike a near-black primary.
        const paintColor = themeColor(element, "--info");
        const paintMaterial = paintOverlayMaterial(paintColor, paintUniforms);
        const overlays = mainMeshes.map((mesh) => {
          const geometry = geometries.get(mesh)!;
          const overlay =
            mesh instanceof THREE.SkinnedMesh
              ? new THREE.SkinnedMesh(geometry, paintMaterial)
              : new THREE.Mesh(geometry, paintMaterial);
          if (overlay instanceof THREE.SkinnedMesh && mesh instanceof THREE.SkinnedMesh) {
            overlay.bindMode = mesh.bindMode;
            overlay.bind(mesh.skeleton, mesh.bindMatrix);
          }
          overlay.raycast = () => {};
          overlay.renderOrder = 5;
          overlay.visible = false;
          mesh.add(overlay);
          return overlay;
        });
        const eraseColor = new THREE.Color(0x9aa0a6);
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(0.9, 1, 48),
          new THREE.MeshBasicMaterial({
            color: paintColor,
            side: THREE.DoubleSide,
            depthTest: false,
            transparent: true,
          }),
        );
        ring.renderOrder = 20;
        ring.visible = false;
        scene.add(ring);
        const defaultButtons = { ...orbit.mouseButtons };
        const surfaceHit = (event: PointerEvent) => {
          setPointer(event);
          return raycaster.intersectObjects(mainMeshes, false)[0] ?? null;
        };
        const showRing = (hit: THREE.Intersection | null, erase: boolean) => {
          if (!hit || !paintSession) {
            ring.visible = false;
            return;
          }
          const normal = hit.face
            ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
            : camera.position.clone().sub(hit.point).normalize();
          ring.position.copy(hit.point);
          ring.lookAt(hit.point.clone().add(normal));
          // The visible edge of a dab (value one half) sits at about 85 % of its radius.
          ring.scale.setScalar(paintSession.radiusMetres * 0.85);
          (ring.material as THREE.MeshBasicMaterial).color.copy(erase ? eraseColor : paintColor);
          ring.visible = true;
        };
        const dabTo = (point: THREE.Vector3) => {
          if (!paintSession || !stroke) return;
          const r = paintSession.radiusMetres,
            distance = stroke.last.distanceTo(point);
          // Fill between pointer samples, but do not bridge a jump across a gap in the model.
          const steps = distance < r * 6 ? Math.ceil(distance / (r * 0.3)) : 1;
          let changed = false;
          for (let i = 1; i <= steps; i++) {
            const p = steps > 1 ? stroke.last.clone().lerp(point, i / steps) : point;
            changed = paintSession.dab(p.toArray() as Vec3, stroke.erase) || changed;
          }
          stroke.last = point.clone();
          if (changed && paintTexture) paintTexture.needsUpdate = true;
        };
        const paintDown = (event: PointerEvent) => {
          if (!paintSession || other || frameState || event.button !== 0) return;
          const hit = surfaceHit(event);
          // Off the model a drag still orbits.
          if (!hit) return;
          event.stopPropagation();
          event.preventDefault();
          element.focus({ preventScroll: true });
          element.setPointerCapture(event.pointerId);
          paintSession.beginStroke();
          stroke = {
            last: hit.point.clone(),
            erase: paintSession.erase !== event.altKey,
            pointer: event.pointerId,
          };
          if (paintSession.dab(hit.point.toArray() as Vec3, stroke.erase) && paintTexture)
            paintTexture.needsUpdate = true;
          showRing(hit, stroke.erase);
          render();
        };
        const paintMove = (event: PointerEvent) => {
          if (!paintSession || other || frameState) return;
          if (!stroke && event.buttons) {
            ring.visible = false;
            return;
          }
          const hit = surfaceHit(event);
          if (stroke && hit) dabTo(hit.point);
          showRing(hit, stroke ? stroke.erase : paintSession.erase !== event.altKey);
          render();
        };
        const paintUp = (event: PointerEvent) => {
          if (!stroke || event.pointerId !== stroke.pointer) return;
          stroke = null;
          if (element.hasPointerCapture(event.pointerId))
            element.releasePointerCapture(event.pointerId);
          paintSession?.endStroke();
        };
        const paintLeave = () => {
          if (stroke || !ring.visible) return;
          ring.visible = false;
          render();
        };
        element.addEventListener("pointerdown", paintDown, true);
        element.addEventListener("pointermove", paintMove);
        element.addEventListener("pointerup", paintUp);
        element.addEventListener("pointercancel", paintUp);
        element.addEventListener("pointerleave", paintLeave);
        const setPaint = (session: Gen3DPaintSession | null) => {
          paintSession = other ? null : session;
          stroke = null;
          if (paintSession) {
            const grid = paintSession.ensureGrid(
              boxA.min.toArray() as Vec3,
              boxA.max.toArray() as Vec3,
            );
            if (paintTexture?.image.data !== grid.data) {
              paintTexture?.dispose();
              paintTexture = new THREE.Data3DTexture(grid.data, ...grid.dims);
              paintTexture.format = THREE.RedFormat;
              paintTexture.type = THREE.UnsignedByteType;
              paintTexture.minFilter = paintTexture.magFilter = THREE.LinearFilter;
              paintTexture.unpackAlignment = 1;
            }
            paintTexture.needsUpdate = true;
            paintUniforms.ahaMask.value = paintTexture;
            paintUniforms.ahaMin.value.set(...grid.min);
            paintUniforms.ahaSize.value.set(
              grid.max[0] - grid.min[0],
              grid.max[1] - grid.min[1],
              grid.max[2] - grid.min[2],
            );
            // The left button paints on the model; the right one orbits (Shift pans).
            orbit.mouseButtons = {
              LEFT: THREE.MOUSE.ROTATE,
              MIDDLE: THREE.MOUSE.DOLLY,
              RIGHT: THREE.MOUSE.ROTATE,
            };
            renderer!.domElement.style.cursor = "crosshair";
          } else {
            orbit.mouseButtons = { ...defaultButtons };
            ring.visible = false;
            renderer!.domElement.style.cursor = "";
          }
          for (const overlay of overlays) overlay.visible = !!paintSession;
          render();
        };
        const paintChanged = () => {
          if (paintTexture) paintTexture.needsUpdate = true;
          if (ring.visible && paintSession) ring.scale.setScalar(paintSession.radiusMetres * 0.85);
          render();
        };
        let pressed = { x: 0, y: 0 };
        const down = (event: PointerEvent) => {
          pressed = { x: event.clientX, y: event.clientY };
        };
        const up = (event: PointerEvent) => {
          // A drag orbits; only a click picks. Picking is off while overlaying or comparing.
          if (Math.hypot(pressed.x - event.clientX, pressed.y - event.clientY) > 4) return;
          if (frameState || other || paintSession || !onSelectRef.current) return;
          const rect = renderer!.domElement.getBoundingClientRect();
          pointer.set(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            (-(event.clientY - rect.top) / rect.height) * 2 + 1,
          );
          raycaster.setFromCamera(pointer, camera);
          const hit = raycaster.intersectObjects(mainMeshes, false)[0];
          let object: THREE.Object3D | null = hit?.object ?? null;
          while (object && typeof object.userData.ahaId !== "string") object = object.parent;
          onSelectRef.current(
            object ? (object.userData.ahaId as string) : null,
            event.metaKey || event.ctrlKey || event.shiftKey,
          );
        };
        renderer.domElement.addEventListener("pointerdown", down);
        renderer.domElement.addEventListener("pointerup", up);
        let overrides: THREE.Material[] = [],
          weightGeometries: THREE.BufferGeometry[] = [],
          frameState: ReturnType<typeof overlayFrame> | null = null,
          playing = false,
          paused = false,
          frameId = 0,
          visible = true,
          last = performance.now();
        const size = () => ({ width: element.clientWidth, height: element.clientHeight });
        const placeLabels = (cameraUsed: THREE.Camera, width: number, height: number) => {
          const host = labels.current;
          if (!host) return;
          const show = latest.current.bounds && !other;
          host.style.display = show ? "" : "none";
          if (!show) return;
          const { min, max } = boxA;
          const edges: [THREE.Vector3, string][] = [
            [
              new THREE.Vector3((min.x + max.x) / 2, min.y, max.z),
              `${(max.x - min.x).toFixed(3)} m`,
            ],
            [
              new THREE.Vector3(max.x, (min.y + max.y) / 2, max.z),
              `${(max.y - min.y).toFixed(3)} m`,
            ],
            [
              new THREE.Vector3(max.x, min.y, (min.z + max.z) / 2),
              `${(max.z - min.z).toFixed(3)} m`,
            ],
          ];
          edges.forEach(([point, text], index) => {
            const label = host.children[index] as HTMLElement | undefined;
            if (!label) return;
            const p = point.clone().project(cameraUsed);
            label.textContent = text;
            label.style.transform = `translate(${((p.x + 1) / 2) * width}px, ${((1 - p.y) / 2) * height}px) translate(-50%, -50%)`;
            label.style.visibility = p.z < 1 ? "visible" : "hidden";
          });
        };
        const draw = () => {
          const { width, height } = size();
          if (!width || !height) return;
          renderer!.setScissorTest(false);
          renderer!.clear();
          if (frameState) {
            // Reference overlay: a centred square matching the blueprint image.
            const side = Math.min(width, height);
            const x = (width - side) / 2,
              y = (height - side) / 2;
            renderer!.setViewport(x, y, side, side);
            renderer!.setScissor(x, y, side, side);
            renderer!.setScissorTest(true);
            renderer!.render(scene, ortho);
            placeLabels(ortho, width, height);
            return;
          }
          if (other) {
            const half = Math.floor(width / 2);
            camera.aspect = half / height;
            camera.updateProjectionMatrix();
            for (const [index, root] of [main.root, other.root].entries()) {
              main.root.visible = index === 0;
              other.root.visible = index === 1;
              renderer!.setViewport(index * half, 0, half, height);
              renderer!.setScissor(index * half, 0, half, height);
              renderer!.setScissorTest(true);
              void root;
              renderer!.render(scene, camera);
            }
            main.root.visible = other.root.visible = true;
            return;
          }
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          renderer!.setViewport(0, 0, width, height);
          renderer!.render(scene, camera);
          placeLabels(camera, width, height);
          if (paintSession) {
            // A custom repaint view looks along the viewer's camera (orthographic in Blender).
            paintSession.camera = {
              direction: camera.position.clone().sub(orbit.target).normalize().toArray() as Vec3,
              up: new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).toArray() as Vec3,
            };
          }
        };
        const loop = () => {
          frameId = 0;
          if (cleaned || !visible || document.hidden) return;
          const now = performance.now(),
            dt = Math.min(0.1, (now - last) / 1000);
          last = now;
          if (playing && !paused) mixer.update(dt);
          if (latest.current.turntable && !frameState) orbit.update();
          draw();
          // orbit.update() above may already have queued the next frame through its change event.
          if (!frameId && ((playing && !paused) || (latest.current.turntable && !frameState)))
            frameId = requestAnimationFrame(loop);
        };
        const render = () => {
          if (cleaned || frameId) return;
          last = performance.now();
          frameId = requestAnimationFrame(loop);
        };
        const resize = () => {
          const { width, height } = size();
          if (!width || !height) return;
          renderer!.setSize(width, height);
          render();
        };
        // The blueprint silhouette drawn in front of the model, in the overlay frame itself.
        const silhouette = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
        silhouette.visible = false;
        silhouette.renderOrder = 10;
        scene.add(silhouette);
        const silhouettes = new Map<string, THREE.Texture>();
        const tint = themeColor(element);
        let silhouetteView = "";
        const showSilhouette = async (
          view: BlueprintView,
          frame: ReturnType<typeof overlayFrame>,
          target: THREE.Vector3,
        ) => {
          silhouetteView = view;
          let texture = silhouettes.get(view);
          if (!texture) {
            const url = gen3dAssetUrl(
              project.id,
              "blueprint",
              view,
              undefined,
              project.blueprint!.createdAt,
            );
            const response = await fetch(url, { credentials: "include", signal: abort.signal });
            if (!response.ok) return;
            texture = new THREE.Texture(
              await createImageBitmap(await response.blob(), { imageOrientation: "flipY" }),
            );
            texture.needsUpdate = true;
            silhouettes.set(view, texture);
          }
          if (cleaned || silhouetteView !== view || !frameState) return;
          (silhouette.material as THREE.Material).dispose();
          silhouette.material = silhouetteMaterial(texture, tint);
          silhouette.scale.set(frame.half * 2 * (frame.flipImage ? -1 : 1), frame.half * 2, 1);
          silhouette.position
            .copy(target)
            .add(new THREE.Vector3(...frame.direction).multiplyScalar(diameter * 2));
          silhouette.lookAt(ortho.position);
          silhouette.visible = true;
          render();
        };
        const reset = () => {
          // Narrow views (each half when comparing) need more distance to fit the model across.
          const { width, height } = size();
          const aspect = width && height ? (other ? width / 2 : width) / height : 1;
          camera.position
            .copy(center)
            .add(
              new THREE.Vector3(0.95, 0.65, 1.2)
                .normalize()
                .multiplyScalar(diameter * 1.8 * Math.max(1, 1 / aspect)),
            );
          orbit.target.copy(center);
          orbit.update();
          render();
        };
        const material = (mesh: THREE.Mesh, source: THREE.Material, next: DisplayMode) => {
          const m = source as THREE.MeshStandardMaterial;
          const made = (() => {
            switch (next) {
              case "color":
                return new THREE.MeshBasicMaterial({
                  map: m.map ?? null,
                  color: m.color ?? 0xffffff,
                  vertexColors: m.vertexColors,
                });
              case "normal":
                return m.normalMap
                  ? channelMaterial(m.normalMap, "rgb", 1)
                  : new THREE.MeshNormalMaterial();
              case "roughness":
                return channelMaterial(m.roughnessMap ?? null, "g", m.roughness ?? 1);
              case "metalness":
                return channelMaterial(m.metalnessMap ?? null, "b", m.metalness ?? 0);
              case "occlusion":
                return channelMaterial(m.aoMap ?? null, "r", 1);
              case "uv":
                return mesh.geometry.getAttribute("uv")
                  ? new THREE.MeshBasicMaterial({ map: checkerTexture() })
                  : new THREE.MeshBasicMaterial({ color: 0xd14b8f });
              case "weights":
                return new THREE.MeshBasicMaterial({
                  vertexColors: mesh instanceof THREE.SkinnedMesh,
                  color: mesh instanceof THREE.SkinnedMesh ? 0xffffff : 0x777777,
                });
              default:
                return new THREE.MeshStandardMaterial({
                  color: 0x999999,
                  roughness: 0.75,
                  metalness: 0,
                  wireframe: next === "wireframe",
                });
            }
          })();
          made.side = source.side;
          overrides.push(made);
          return made;
        };
        const apply = (s: Settings) => {
          overrides.forEach((m) => m.dispose());
          weightGeometries.forEach((g) => g.dispose());
          overrides = [];
          weightGeometries = [];
          const boneIndex = boneNames.indexOf(s.bone);
          for (const [mesh, source] of originals) {
            mesh.geometry = geometries.get(mesh)!;
            if (s.mode === "material") {
              mesh.material = source;
              continue;
            }
            if (s.mode === "weights" && mesh instanceof THREE.SkinnedMesh) {
              const geometry = mesh.geometry.clone();
              const index = geometry.getAttribute("skinIndex"),
                weight = geometry.getAttribute("skinWeight");
              const bones = mesh.skeleton.bones.map((b) => b.name);
              geometry.setAttribute(
                "color",
                new THREE.BufferAttribute(
                  weightColors(
                    index.array,
                    weight.array,
                    bones.indexOf(boneNames[Math.max(0, boneIndex)]!),
                  ),
                  3,
                ),
              );
              weightGeometries.push(geometry);
              mesh.geometry = geometry;
            }
            mesh.material = Array.isArray(source)
              ? source.map((m) => material(mesh, m, s.mode))
              : material(mesh, source, s.mode);
          }
          gridHelper.visible = s.grid && s.overlay === "off";
          boundsHelper.visible = s.bounds && !other;
          if (skeletonHelper) skeletonHelper.visible = s.skeleton;
          if (s.overlay !== "off" && canOverlay && !other) {
            const registration = version.score!.views[s.overlay];
            frameState = overlayFrame(
              s.overlay,
              { min: boxA.min.toArray(), max: boxA.max.toArray() },
              project.blueprint!.pxPerMetre,
              registration,
            );
            ortho.left = ortho.bottom = -frameState.half;
            ortho.right = ortho.top = frameState.half;
            const target = new THREE.Vector3(...frameState.centre);
            ortho.position
              .copy(target)
              .add(new THREE.Vector3(...frameState.direction).multiplyScalar(diameter * 4));
            ortho.up.set(0, 1, 0);
            ortho.lookAt(target);
            ortho.updateProjectionMatrix();
            orbit.enabled = false;
            void showSilhouette(s.overlay, frameState, target);
          } else {
            frameState = null;
            orbit.enabled = true;
            silhouette.visible = false;
          }
          orbit.autoRotate = s.turntable;
          render();
        };
        const restPose = () => {
          mixer.stopAllAction();
          for (const [o, [p, q, s]] of rest) {
            o.position.copy(p);
            o.quaternion.copy(q);
            o.scale.copy(s);
          }
        };
        const play = (name: string, loop: boolean) => {
          restPose();
          const animation = main.animations.find((a) => a.name === name);
          playing = !!animation;
          if (animation) {
            const action = mixer.clipAction(animation);
            action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
            action.clampWhenFinished = true;
            action.reset().play();
          }
          render();
        };
        const pause = (next: boolean) => {
          paused = next;
          render();
        };
        controls.current = { highlight, setPaint, paintChanged, reset, apply, play, pause };
        const observer = new ResizeObserver(resize);
        observer.observe(element);
        const visibility = new IntersectionObserver((entries) => {
          visible = entries[0]?.isIntersecting ?? false;
          if (visible) render();
        });
        visibility.observe(element);
        document.addEventListener("visibilitychange", render);
        orbit.addEventListener("change", render);
        orbit.listenToKeyEvents(element);
        reset();
        resize();
        apply(latest.current);
        highlight(selection.current);
        setPaint(paintRef.current);
        setLoading(false);
        cleanup = () => {
          controls.current = null;
          cancelAnimationFrame(frameId);
          renderer!.domElement.removeEventListener("pointerdown", down);
          renderer!.domElement.removeEventListener("pointerup", up);
          element.removeEventListener("pointerdown", paintDown, true);
          element.removeEventListener("pointermove", paintMove);
          element.removeEventListener("pointerup", paintUp);
          element.removeEventListener("pointercancel", paintUp);
          element.removeEventListener("pointerleave", paintLeave);
          overlays.forEach((o) => o.removeFromParent());
          paintMaterial.dispose();
          paintTexture?.dispose();
          ring.geometry.dispose();
          (ring.material as THREE.Material).dispose();
          highlights.forEach((h) => h.dispose());
          observer.disconnect();
          visibility.disconnect();
          document.removeEventListener("visibilitychange", render);
          orbit.dispose();
          mixer.stopAllAction();
          overrides.forEach((m) => m.dispose());
          weightGeometries.forEach((g) => g.dispose());
          for (const [mesh, source] of originals) {
            mesh.material = source;
            mesh.geometry = geometries.get(mesh)!;
          }
          skeletonHelper?.dispose();
          silhouette.geometry.dispose();
          (silhouette.material as THREE.Material).dispose();
          silhouettes.forEach((t) => t.dispose());
          gridHelper.dispose();
          boundsHelper.dispose();
          environment.dispose();
          pmrem.dispose();
          renderer!.dispose();
          renderer!.forceContextLoss();
          renderer!.domElement.remove();
          loadedRoots.forEach(disposeScene);
        };
      } catch (cause) {
        if (!cleaned && !abort.signal.aborted) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setLoading(false);
        }
        loadedRoots.forEach(disposeScene);
        renderer?.dispose();
        renderer?.forceContextLoss();
        renderer?.domElement.remove();
      }
    })();
    return () => {
      cleaned = true;
      abort.abort();
      cleanup();
    };
  }, [mainUrl, compareUrl]);

  const modes: DisplayMode[] = [...DISPLAY_MODES, ...(bones.length ? (["weights"] as const) : [])];
  const onKey = (event: KeyboardEvent) => {
    if (event.target !== container.current) return;
    const key = event.key.toLowerCase();
    if (paint && key === "z" && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
      event.preventDefault();
      paint.undo();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (paint && (key === "[" || key === "]")) {
      paint.setBrush({ radius: paint.radius * (key === "]" ? 1.25 : 0.8) });
      return;
    }
    if (paint && (key === "e" || key === "b")) {
      paint.setBrush({ erase: key === "e" });
      return;
    }
    if (key === "r") controls.current?.reset();
    else if (key === "t") setTurntable((v) => !v);
    else if (key === " " && clip) {
      event.preventDefault();
      setPaused((v) => !v);
    } else if (/^[1-9]$/.test(key)) setMode(DISPLAY_MODES[Number(key) - 1]!);
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2"
        role="toolbar"
        aria-label={tr("Model preview controls")}
      >
        <div className="w-40">
          <OptionSelect
            size="xs"
            label={tr("Display")}
            value={mode}
            onValueChange={(v) => setMode(v as DisplayMode)}
          >
            {modes.map((value, index) => (
              <option key={value} value={value}>
                {value === "weights"
                  ? tr(MODE_LABELS[value])
                  : `${index + 1} · ${tr(MODE_LABELS[value])}`}
              </option>
            ))}
          </OptionSelect>
        </div>
        {mode === "weights" && bones.length > 0 && (
          <div className="w-32">
            <OptionSelect
              size="xs"
              label={tr("Bone")}
              value={bone || bones[0]!}
              onValueChange={setBone}
            >
              {bones.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </OptionSelect>
          </div>
        )}
        {canOverlay && !compare && !paint && (
          <div className="w-36">
            <OptionSelect
              size="xs"
              label={tr("Reference overlay")}
              value={overlay}
              onValueChange={(v) => setOverlay(v as typeof overlay)}
            >
              <option value="off">{tr("No reference overlay")}</option>
              {BLUEPRINT_VIEWS.map((view) => (
                <option key={view} value={view}>
                  {tr("Overlay: {view}").replace("{view}", tr(VIEW_LABELS[view]))}
                </option>
              ))}
            </OptionSelect>
          </div>
        )}
        {project.versions.length > 1 && !paint && (
          <div className="w-36">
            <OptionSelect
              size="xs"
              label={tr("Compare with")}
              value={compare?.id ?? ""}
              onValueChange={setCompareId}
            >
              <option value="">{tr("No comparison")}</option>
              {project.versions
                .filter((v) => v.id !== version.id)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {tr("Compare with {name}").replace("{name}", v.name)}
                  </option>
                ))}
            </OptionSelect>
          </div>
        )}
        {animated && clips.length > 0 && (
          <div className="flex items-center gap-1">
            <div className="w-28">
              <OptionSelect size="xs" label={tr("Animation")} value={clip} onValueChange={setClip}>
                <option value="">{tr("Rest pose")}</option>
                {clips.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </OptionSelect>
            </div>
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={!clip}
              aria-label={tr(paused ? "Play" : "Pause")}
              title={tr(paused ? "Play (Space)" : "Pause (Space)")}
              onClick={() => setPaused((v) => !v)}
            >
              {paused ? <PlayIcon /> : <PauseIcon />}
            </Button>
          </div>
        )}
        <label className="flex items-center gap-1 text-ui-xs">
          <Checkbox checked={grid} onCheckedChange={(v) => setGrid(v === true)} />
          {tr("Grid")}
        </label>
        <label className="flex items-center gap-1 text-ui-xs">
          <Checkbox checked={bounds} onCheckedChange={(v) => setBounds(v === true)} />
          {tr("Dimensions")}
        </label>
        <label className="flex items-center gap-1 text-ui-xs">
          <Checkbox checked={turntable} onCheckedChange={(v) => setTurntable(v === true)} />
          {tr("Turntable")}
        </label>
        {bones.length > 0 && (
          <label className="flex items-center gap-1 text-ui-xs">
            <Checkbox checked={skeleton} onCheckedChange={(v) => setSkeleton(v === true)} />
            {tr("Bones")}
          </label>
        )}
        <Button
          className="ms-auto"
          size="icon-xs"
          variant="ghost"
          aria-label={tr("Reset view")}
          title={tr("Reset view (R)")}
          onClick={() => controls.current?.reset()}
        >
          <RotateCcwIcon />
        </Button>
      </div>
      <PreviewSurface className="relative flex min-h-40 flex-1 overflow-hidden">
        <div
          ref={container}
          tabIndex={0}
          role="application"
          aria-label={tr(
            paint
              ? "3D model, painting the repaint mask. Drag on the model to paint, Alt-drag to erase, right-drag or drag beside the model to orbit, scroll to zoom. [ and ] change the brush size, E and B switch eraser and brush, Cmd or Ctrl+Z undoes, R resets the view."
              : "3D model. Drag to orbit, right-drag or arrow keys to pan, scroll to zoom; click a part to select it, with Cmd or Ctrl to add. R resets the view, 1–9 switch the display, T toggles the turntable, Space pauses the animation.",
          )}
          onKeyDown={onKey}
          className="absolute inset-0 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        />
        <div ref={labels} className="pointer-events-none absolute inset-0" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="absolute start-0 top-0 rounded-sm bg-background/80 px-1 text-ui-xs tabular-nums text-foreground"
            />
          ))}
        </div>
        {paint && !loading && !error && (
          <div
            className="pointer-events-none absolute bottom-2 start-2 max-w-[calc(100%-1rem)] rounded-md bg-background/85 px-2 py-1 text-ui-xs"
            role="status"
          >
            {tr(
              "Painting the mask: drag on the model, Alt-drag to erase, right-drag to orbit, [ ] brush size.",
            )}
          </div>
        )}
        {selected.length > 0 && !compare && !paint && (
          <div
            className="absolute bottom-2 start-2 flex max-w-[calc(100%-1rem)] items-center gap-2 rounded-md bg-background/85 px-2 py-1 text-ui-xs"
            role="status"
          >
            <span className="min-w-0 truncate" title={selected.join(", ")}>
              {tr("Selected: {parts}").replace("{parts}", selected.join(", "))}
            </span>
            {onSelect && (
              <Button size="xs" variant="ghost" onClick={() => onSelect(null, false)}>
                {tr("Clear")}
              </Button>
            )}
          </div>
        )}
        {compare && (
          <div className="pointer-events-none absolute inset-x-0 top-2 flex text-ui-xs" aria-hidden>
            <span className="flex-1 text-center">{version.name}</span>
            <span className="flex-1 text-center">{compare.name}</span>
          </div>
        )}
        {(loading || error) && (
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center p-5 text-ui-sm text-muted-foreground"
            role={error ? "alert" : "status"}
          >
            {error ?? tr("Loading model…")}
          </div>
        )}
      </PreviewSurface>
    </div>
  );
}
