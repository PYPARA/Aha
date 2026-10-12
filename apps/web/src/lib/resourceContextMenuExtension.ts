import type { DesktopBridge } from "@synara/contracts";

export interface ResourceMenuAction {
  label: string;
  run: () => void;
}
// Registered by capture handlers during this exact DOM contextmenu dispatch. This
// uses the actual hit target, so browser zoom cannot select an adjacent image.
let candidate: { element: Element; action: ResourceMenuAction; x: number; y: number } | null = null;
let clearActive: (() => void) | undefined;
export function registerResourceMenuAction(
  element: Element,
  position: { x: number; y: number },
  action: ResourceMenuAction,
) {
  candidate = { element, action, ...position };
}
export function takeResourceMenuAction(position: {
  x: number;
  y: number;
}): ResourceMenuAction | null {
  const current = candidate;
  candidate = null;
  if (!current?.element.isConnected || current.x !== position.x || current.y !== position.y)
    return null;
  return current.action;
}
export function installResourceContextMenuExtension(bridge: DesktopBridge) {
  // React remount/HMR must not accumulate document or IPC listeners.
  clearActive?.();
  let pending: { id: string; action: ResourceMenuAction; element: Element } | null = null;
  const reset = () => {
    candidate = null;
    pending = null;
  };
  document.addEventListener("contextmenu", reset, true);
  window.addEventListener("pagehide", reset);
  const extension = bridge.contextMenuExtension;
  const offQuery = extension?.onQuery(({ requestId, x, y }) => {
    const current = candidate;
    // Electron uses zoomed coordinates; main normalizes them back to CSS pixels.
    // Keep a newer target intact when an older request arrives at a different point.
    if (current && (Math.abs(current.x - x) > 2 || Math.abs(current.y - y) > 2)) {
      extension.respond(requestId, null);
      return;
    }
    candidate = null;
    pending = current?.element.isConnected
      ? { id: requestId, action: current.action, element: current.element }
      : null;
    extension.respond(requestId, pending?.action.label ?? null);
  });
  const offResult = extension?.onResult(({ requestId, selected }) => {
    if (pending?.id !== requestId) return;
    const current = pending;
    pending = null;
    if (selected && current.element.isConnected) current.action.run();
  });
  const dispose = () => {
    reset();
    offQuery?.();
    offResult?.();
    document.removeEventListener("contextmenu", reset, true);
    window.removeEventListener("pagehide", reset);
    if (clearActive === dispose) clearActive = undefined;
  };
  clearActive = dispose;
  return dispose;
}
