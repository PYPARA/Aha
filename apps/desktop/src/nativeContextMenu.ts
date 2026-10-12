import { randomUUID } from "node:crypto";
import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

/** Keep native roles and edit flags owned by Electron, not approximated by renderer state. */
export function nativeContextMenuTemplate(
  params: Pick<
    ContextMenuParams,
    "misspelledWord" | "dictionarySuggestions" | "mediaType" | "editFlags" | "x" | "y"
  >,
  actions: {
    replaceMisspelling: (word: string) => void;
    copyImageAt: (x: number, y: number) => void;
  },
  extension?: { label: string; click: () => void },
): MenuItemConstructorOptions[] {
  const menu: MenuItemConstructorOptions[] = [];
  if (params.misspelledWord) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 5))
      menu.push({ label: suggestion, click: () => actions.replaceMisspelling(suggestion) });
    if (!params.dictionarySuggestions.length)
      menu.push({ label: "No suggestions", enabled: false });
    menu.push({ type: "separator" });
  }
  if (params.mediaType === "image") {
    menu.push({ label: "Copy Image", click: () => actions.copyImageAt(params.x, params.y) });
    menu.push({ type: "separator" });
  }
  menu.push(
    { role: "cut", enabled: params.editFlags.canCut },
    { role: "copy", enabled: params.editFlags.canCopy },
    { role: "paste", enabled: params.editFlags.canPaste },
    { role: "selectAll", enabled: params.editFlags.canSelectAll },
  );
  if (extension) menu.push({ type: "separator" }, extension);
  return menu;
}

/** One active menu per window. A late response can never attach to a newer menu. */
export class NativeContextMenuSession {
  private active:
    | {
        id: string;
        settle?: (value: { requestId: string; label: string | null }) => void;
        timer?: ReturnType<typeof setTimeout>;
        label: string | null;
      }
    | undefined;
  constructor(
    private readonly sendQuery: (request: { requestId: string; x: number; y: number }) => void,
    private readonly sendResult: (result: { requestId: string; selected: boolean }) => void,
  ) {}
  query(x: number, y: number) {
    this.cancel();
    const requestId = randomUUID();
    return new Promise<{ requestId: string; label: string | null }>((resolve) => {
      this.active = { id: requestId, settle: resolve, label: null };
      this.active.timer = setTimeout(() => this.respond(requestId, null), 150);
      try {
        this.sendQuery({ requestId, x, y });
      } catch {
        this.respond(requestId, null);
      }
    });
  }
  respond(requestId: string, label: unknown) {
    const active = this.active;
    if (!active || active.id !== requestId || !active.settle) return;
    clearTimeout(active.timer);
    active.label = typeof label === "string" && label.trim() && label.length <= 100 ? label : null;
    active.settle({ requestId, label: active.label });
    delete active.settle;
  }
  isCurrent(id: string) {
    return this.active?.id === id;
  }
  finish(id: string, selected = false) {
    const active = this.active;
    if (!active || active.id !== id) return;
    this.active = undefined;
    clearTimeout(active.timer);
    active.settle?.({ requestId: id, label: null });
    this.sendResult({ requestId: id, selected: selected && active.label !== null });
  }
  cancel() {
    if (this.active) this.finish(this.active.id);
  }
}
