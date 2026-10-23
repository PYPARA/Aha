import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { RotateCcwIcon } from "~/lib/icons";
import { Button } from "../ui/button";
import { PreviewSurface } from "../ui/preview-surface";
import { Checkbox } from "../ui/checkbox";
import { disposeModel, loadModel } from "./model3dScene";

type DisplayMode = "material" | "solid" | "wireframe";
export default function ModelViewer({
  url,
  bytes,
  selectedId,
  onSelect,
}: {
  url?: string | undefined;
  bytes?: Uint8Array | undefined;
  selectedId?: string | null | undefined;
  onSelect?: (id: string | null) => void;
}) {
  const tr = useAhaTranslation(),
    container = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<DisplayMode>("material"),
    [grid, setGrid] = useState(true),
    [bounds, setBounds] = useState(false),
    [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(true);
  const controls = useRef<{
    reset: () => void;
    display: (
      mode: DisplayMode,
      grid: boolean,
      bounds: boolean,
      selectedId?: string | null,
    ) => void;
  } | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const settings = useRef({ mode, grid, bounds, selectedId });
  settings.current = { mode, grid, bounds, selectedId };
  useEffect(
    () => controls.current?.display(mode, grid, bounds, selectedId),
    [mode, grid, bounds, selectedId],
  );
  useEffect(() => {
    if (!container.current || (!url && !bytes)) return;
    const element = container.current,
      abort = new AbortController();
    let root: THREE.Group | undefined,
      cleaned = false,
      renderer: THREE.WebGLRenderer | undefined,
      cleanup: () => void = () => {};
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        let input = bytes;
        if (!input) {
          const response = await fetch(url!, { credentials: "include", signal: abort.signal });
          if (!response.ok) throw new Error("Could not load the model file.");
          const size = Number(response.headers.get("content-length"));
          if (size > 100 * 1024 * 1024) throw new Error("Model exceeds 100 MiB.");
          input = new Uint8Array(await response.arrayBuffer());
        }
        if (input.byteLength > 100 * 1024 * 1024) throw new Error("Model exceeds 100 MiB.");
        root = await loadModel(input);
        if (cleaned) {
          disposeModel(root);
          return;
        }
        renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
        renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.setClearColor(0, 0);
        element.appendChild(renderer.domElement);
        const scene = new THREE.Scene();
        scene.add(root);
        scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 2.7));
        const light = new THREE.DirectionalLight(0xffffff, 3);
        light.position.set(3, 5, 4);
        scene.add(light);
        const box = new THREE.Box3().setFromObject(root),
          center = box.getCenter(new THREE.Vector3()),
          diameter = Math.max(box.getSize(new THREE.Vector3()).length(), 0.01);
        const camera = new THREE.PerspectiveCamera(36, 1, diameter / 1000, diameter * 1000),
          orbit = new OrbitControls(camera, renderer.domElement);
        orbit.target.copy(center);
        orbit.enableDamping = false;
        orbit.minDistance = diameter * 0.02;
        orbit.maxDistance = diameter * 50;
        const gridHelper = new THREE.GridHelper(Math.max(diameter * 2, 1), 20, 0x888888, 0x888888);
        gridHelper.position.y = box.min.y - 0.001;
        const gridMaterial = gridHelper.material as THREE.Material;
        gridMaterial.transparent = true;
        gridMaterial.opacity = 0.22;
        scene.add(gridHelper);
        const helper = new THREE.Box3Helper(box, 0x888888),
          selection = new THREE.Box3Helper(new THREE.Box3(), 0x888888);
        scene.add(helper, selection);
        const originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>(),
          overrides: THREE.Material[] = [];
        root.traverse((object) => {
          if (object instanceof THREE.Mesh) originals.set(object, object.material);
        });
        let frame = 0,
          visible = true;
        const render = () => {
          if (cleaned || frame || !visible || document.hidden) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            if (!cleaned && visible && !document.hidden) renderer!.render(scene, camera);
          });
        };
        const resize = () => {
          const width = element.clientWidth,
            height = element.clientHeight;
          if (!width || !height) return;
          renderer!.setSize(width, height);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          render();
        };
        const reset = () => {
          camera.position
            .copy(center)
            .add(new THREE.Vector3(0.95, 0.65, 1.2).normalize().multiplyScalar(diameter * 1.8));
          orbit.target.copy(center);
          orbit.update();
          render();
        };
        const display = (
          next: DisplayMode,
          showGrid: boolean,
          showBounds: boolean,
          id?: string | null,
        ) => {
          overrides.splice(0).forEach((m) => m.dispose());
          for (const [mesh, materials] of originals) {
            if (next === "material") mesh.material = materials;
            else {
              const material = new THREE.MeshStandardMaterial({
                color: 0x999999,
                roughness: 0.75,
                metalness: 0,
                wireframe: next === "wireframe",
              });
              overrides.push(material);
              mesh.material = material;
            }
          }
          gridHelper.visible = showGrid;
          helper.visible = showBounds;
          selection.visible = false;
          if (id) {
            let object: THREE.Object3D | undefined;
            root!.traverse((node) => {
              if (node.userData.ahaId === id) object = node;
            });
            if (object) {
              selection.box.setFromObject(object);
              selection.visible = true;
            }
          }
          render();
        };
        controls.current = { reset, display };
        const observer = new ResizeObserver(resize);
        observer.observe(element);
        const visibility = new IntersectionObserver((entries) => {
          visible = entries[0]?.isIntersecting ?? false;
          if (visible) render();
        });
        visibility.observe(element);
        document.addEventListener("visibilitychange", render);
        orbit.addEventListener("change", render);
        const raycaster = new THREE.Raycaster(),
          pointer = new THREE.Vector2();
        let start = { x: 0, y: 0 };
        const down = (event: PointerEvent) => {
          start = { x: event.clientX, y: event.clientY };
        };
        const up = (event: PointerEvent) => {
          if (Math.hypot(start.x - event.clientX, start.y - event.clientY) > 4) return;
          const rect = renderer!.domElement.getBoundingClientRect();
          pointer.set(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            (-(event.clientY - rect.top) / rect.height) * 2 + 1,
          );
          raycaster.setFromCamera(pointer, camera);
          const hit = raycaster.intersectObjects([...originals.keys()], false)[0];
          onSelectRef.current?.(hit ? String(hit.object.userData.ahaId) : null);
        };
        renderer.domElement.addEventListener("pointerdown", down);
        renderer.domElement.addEventListener("pointerup", up);
        const key = (event: KeyboardEvent) => {
          if (event.key.toLowerCase() === "r") reset();
        };
        element.addEventListener("keydown", key);
        orbit.listenToKeyEvents(element);
        reset();
        resize();
        display(
          settings.current.mode,
          settings.current.grid,
          settings.current.bounds,
          settings.current.selectedId,
        );
        setLoading(false);
        cleanup = () => {
          controls.current = null;
          cancelAnimationFrame(frame);
          observer.disconnect();
          visibility.disconnect();
          document.removeEventListener("visibilitychange", render);
          element.removeEventListener("keydown", key);
          orbit.dispose();
          renderer!.domElement.removeEventListener("pointerdown", down);
          renderer!.domElement.removeEventListener("pointerup", up);
          overrides.forEach((m) => m.dispose());
          for (const [mesh, material] of originals) mesh.material = material;
          gridHelper.dispose();
          helper.dispose();
          selection.dispose();
          renderer!.dispose();
          renderer!.forceContextLoss();
          renderer!.domElement.remove();
          if (root) disposeModel(root);
        };
      } catch (cause) {
        if (!cleaned) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setLoading(false);
        }
        if (root) disposeModel(root);
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
  }, [url, bytes]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2"
        role="toolbar"
        aria-label={tr("Model preview controls")}
      >
        {(["material", "solid", "wireframe"] as const).map((value) => (
          <Button
            key={value}
            size="xs"
            variant={mode === value ? "secondary" : "ghost"}
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
          >
            {tr(value === "material" ? "Materials" : value === "solid" ? "Solid" : "Wireframe")}
          </Button>
        ))}
        <label className="ms-2 flex items-center gap-1 text-ui-xs">
          <Checkbox checked={grid} onCheckedChange={(value) => setGrid(value === true)} />
          {tr("Grid")}
        </label>
        <label className="ms-2 flex items-center gap-1 text-ui-xs">
          <Checkbox checked={bounds} onCheckedChange={(value) => setBounds(value === true)} />
          {tr("Bounds")}
        </label>
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
            "3D model. Drag to orbit, right-drag to pan, scroll to zoom. R resets the view.",
          )}
          className="absolute inset-0 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        />
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
