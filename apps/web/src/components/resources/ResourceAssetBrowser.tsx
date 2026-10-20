import { useEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import { resourceType, type ResourceEntry } from "@synara/contracts/resourceLibrary";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Checkbox } from "~/components/ui/checkbox";
import { Menu, MenuItem } from "~/components/ui/menu";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { PreviewSurface } from "~/components/ui/preview-surface";
import { CheckIcon } from "~/lib/icons";
import { ResourcePreview, humanResourceBytes } from "./ResourcePreview";
import {
  emptyResourceSelection,
  resourceRectsIntersect,
  selectResource,
  type ResourceSelection,
} from "./resourceSelection";

export interface ResourceItemAction {
  key: string;
  label: string;
  run: () => void;
  disabled?: boolean;
}
interface DragSession {
  x: number;
  y: number;
  clientX: number;
  clientY: number;
  moved: boolean;
  base: ResourceSelection;
  additive: boolean;
  pointerId: number;
}
export function ResourceAssetBrowser({
  entries,
  selection,
  onSelectionChange,
  multiple,
  view,
  onOpen,
  onExitMultiple,
  disabled,
  scrollRef,
  actions,
  onDragStartBlocked,
  showPaths = false,
}: {
  showPaths?: boolean;
  entries: ResourceEntry[];
  selection: ResourceSelection;
  onSelectionChange: (next: ResourceSelection, afterChange?: () => void) => void;
  multiple: boolean;
  view: "grid" | "list";
  onOpen: (entry: ResourceEntry, trigger: HTMLElement) => void;
  onExitMultiple: () => void;
  disabled: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  actions: ResourceItemAction[];
  onDragStartBlocked?: (() => boolean) | undefined;
}) {
  const tr = useAhaTranslation();
  const [marquee, setMarquee] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [context, setContext] = useState<{ x: number; y: number; trigger: HTMLElement } | null>(
    null,
  );
  const [announcement, setAnnouncement] = useState("");
  const drag = useRef<DragSession | null>(null);
  const frame = useRef(0);
  const suppressClick = useRef(false);
  const beforeClick = useRef<ResourceSelection | null>(null);
  const live = useRef({ selection, entries, onSelectionChange });
  useEffect(() => {
    live.current = { selection, entries, onSelectionChange };
  }, [selection, entries, onSelectionChange]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const order = entries.map((entry) => entry.id);
  const selected = new Set(selection.ids);
  const pick = (entry: ResourceEntry, event: MouseEvent<HTMLButtonElement>) => {
    if (disabled || event.detail > 1) return;
    beforeClick.current = selection;
    onSelectionChange(selectResource(selection, entry.id, order, event, multiple));
  };
  const finishDrag = (cancel: boolean) => {
    const session = drag.current;
    if (!session) return;
    const ids = cancel ? session.base.ids : updateDrag(false);
    if (cancel) live.current.onSelectionChange(session.base);
    suppressClick.current = session.moved;
    drag.current = null;
    cancelAnimationFrame(frame.current);
    setMarquee(null);
    const scroller = scrollRef.current;
    if (scroller?.hasPointerCapture(session.pointerId))
      scroller.releasePointerCapture(session.pointerId);
    setAnnouncement(`${ids.length} ${tr("selected")}`);
  };
  const updateDrag = (autoScroll: boolean) => {
    const session = drag.current,
      scroller = scrollRef.current;
    if (!session || !scroller) return live.current.selection.ids;
    const bounds = scroller.getBoundingClientRect();
    if (session.moved) {
      const speed =
        session.clientY < bounds.top + 32
          ? -Math.min(18, (bounds.top + 32 - session.clientY) / 2)
          : session.clientY > bounds.bottom - 32
            ? Math.min(18, (session.clientY - bounds.bottom + 32) / 2)
            : 0;
      if (autoScroll) scroller.scrollTop += speed;
      const x =
        Math.min(bounds.width, Math.max(0, session.clientX - bounds.left)) + scroller.scrollLeft;
      const y =
        Math.min(bounds.height, Math.max(0, session.clientY - bounds.top)) + scroller.scrollTop;
      const rect = {
        left: Math.min(x, session.x),
        right: Math.max(x, session.x),
        top: Math.min(y, session.y),
        bottom: Math.max(y, session.y),
      };
      setMarquee({
        left: rect.left,
        top: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
      });
      const ids = Array.from(scroller.querySelectorAll<HTMLElement>("[data-resource-entry-id]"))
        .filter((tile) => {
          const r = tile.getBoundingClientRect();
          return resourceRectsIntersect(rect, {
            left: r.left - bounds.left + scroller.scrollLeft,
            right: r.right - bounds.left + scroller.scrollLeft,
            top: r.top - bounds.top + scroller.scrollTop,
            bottom: r.bottom - bounds.top + scroller.scrollTop,
          });
        })
        .map((tile) => tile.dataset.resourceEntryId!);
      const next = session.additive ? [...new Set([...session.base.ids, ...ids])] : ids;
      if (next.join("\0") !== live.current.selection.ids.join("\0"))
        live.current.onSelectionChange({ ...session.base, ids: next });
      return next;
    }
    return session.base.ids;
  };
  const tick = () => {
    if (!drag.current) return;
    updateDrag(true);
    frame.current = requestAnimationFrame(tick);
  };
  return (
    <>
      <div
        ref={scrollRef}
        data-testid="resource-scroll"
        role="group"
        aria-label={tr("Resources; drag blank space to select")}
        tabIndex={entries.length ? -1 : 0}
        className="relative min-h-0 flex-1 overflow-auto overscroll-contain"
        onClick={(event) => {
          if (
            (event.target as HTMLElement).closest(
              "[data-resource-entry-id],button,input,[role=checkbox]",
            )
          )
            return;
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          if (!disabled) onSelectionChange(emptyResourceSelection());
        }}
        onPointerDown={(event) => {
          if (
            disabled ||
            event.button !== 0 ||
            (event.target as HTMLElement).closest(
              "[data-resource-entry-id],button,input,select,textarea,[role=checkbox]",
            )
          )
            return;
          const scroller = event.currentTarget,
            rect = scroller.getBoundingClientRect();
          if (
            event.clientX >= rect.left + scroller.clientWidth ||
            event.clientY >= rect.top + scroller.clientHeight ||
            onDragStartBlocked?.()
          )
            return;
          event.preventDefault();
          scroller.focus({ preventScroll: true });
          drag.current = {
            x: event.clientX - rect.left + scroller.scrollLeft,
            y: event.clientY - rect.top + scroller.scrollTop,
            clientX: event.clientX,
            clientY: event.clientY,
            moved: false,
            base: selection,
            additive: event.metaKey || event.ctrlKey,
            pointerId: event.pointerId,
          };
          scroller.setPointerCapture(event.pointerId);
          frame.current = requestAnimationFrame(tick);
        }}
        onPointerMove={(event) => {
          const session = drag.current;
          if (!session) return;
          const distance = Math.hypot(
            event.clientX - session.clientX,
            event.clientY - session.clientY,
          );
          session.clientX = event.clientX;
          session.clientY = event.clientY;
          session.moved ||=
            distance > 5 ||
            Math.hypot(
              event.clientX -
                (event.currentTarget.getBoundingClientRect().left +
                  session.x -
                  event.currentTarget.scrollLeft),
              event.clientY -
                (event.currentTarget.getBoundingClientRect().top +
                  session.y -
                  event.currentTarget.scrollTop),
            ) > 5;
          updateDrag(false);
        }}
        onPointerUp={(event) => {
          const session = drag.current;
          if (session) {
            session.clientX = event.clientX;
            session.clientY = event.clientY;
            const bounds = event.currentTarget.getBoundingClientRect();
            session.moved ||=
              Math.hypot(
                event.clientX - bounds.left + event.currentTarget.scrollLeft - session.x,
                event.clientY - bounds.top + event.currentTarget.scrollTop - session.y,
              ) > 5;
          }
          finishDrag(false);
        }}
        onPointerCancel={() => finishDrag(true)}
        onLostPointerCapture={() => {
          if (drag.current) finishDrag(true);
        }}
        onKeyDown={(event) => {
          if ((event.target as HTMLElement).closest("input,textarea,select,[role=menu]")) return;
          if (disabled) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (drag.current) finishDrag(true);
            else if (selection.ids.length)
              onSelectionChange({ ...selection, ids: [], anchorId: null });
            else onExitMultiple();
            return;
          }
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
            event.preventDefault();
            event.stopPropagation();
            onSelectionChange({ ...selection, ids: order });
            return;
          }
          const button = (event.target as HTMLElement).closest<HTMLElement>(
            "[data-resource-button]",
          );
          const id = button?.dataset.resourceButton;
          const entry = entries.find((item) => item.id === id);
          if (!entry || !button) return;
          if (event.key === " " && !multiple && entry.kind === "directory") {
            event.preventDefault();
            return;
          }
          if (event.key === "Enter" || (event.key === " " && !multiple)) {
            event.preventDefault();
            onOpen(entry, button);
            return;
          }
          if (event.key === " " && multiple) {
            event.preventDefault();
            onSelectionChange(selectResource(selection, entry.id, order, {}, true));
            return;
          }
          if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
            event.preventDefault();
            const buttons = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>("[data-resource-button]"),
            );
            const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
            const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
            let index = Math.max(
              0,
              Math.min(entries.length - 1, order.indexOf(entry.id) + direction),
            );
            if (vertical && view === "grid") {
              const current = button.getBoundingClientRect();
              const candidates = buttons
                .map((button, index) => ({ index, rect: button.getBoundingClientRect() }))
                .filter(({ rect }) => direction * (rect.top - current.top) > 1)
                .toSorted(
                  (a, b) =>
                    Math.abs(a.rect.top - current.top) - Math.abs(b.rect.top - current.top) ||
                    Math.abs(a.rect.left + a.rect.width / 2 - current.left - current.width / 2) -
                      Math.abs(b.rect.left + b.rect.width / 2 - current.left - current.width / 2),
                );
              index = candidates[0]?.index ?? order.indexOf(entry.id);
            }
            buttons[index]?.focus({ preventScroll: true });
            buttons[index]?.scrollIntoView({ block: "nearest" });
            const next = entries[index];
            if (next)
              onSelectionChange(
                multiple
                  ? { ...selection, focusedId: next.id }
                  : selectResource(selection, next.id, order, event),
              );
          }
        }}
      >
        <div
          data-testid="resource-entries"
          className={
            view === "grid"
              ? "grid select-none grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] content-start gap-3 p-4 pb-10"
              : "flex select-none flex-col gap-1 p-3 pb-10"
          }
        >
          {entries.map((entry, index) => (
            <article
              key={entry.id}
              data-resource-entry-id={entry.id}
              className={`relative min-w-0 rounded-lg border ${view === "grid" && entry.kind === "directory" ? "col-span-full" : ""} ${selected.has(entry.id) ? "border-ring bg-accent" : "border-transparent hover:bg-muted/50"}`}
              onContextMenu={(event) => {
                if (disabled) return;
                event.preventDefault();
                const trigger =
                  event.currentTarget.querySelector<HTMLElement>("[data-resource-button]")!;
                const context = { x: event.clientX, y: event.clientY, trigger };
                if (!selected.has(entry.id))
                  onSelectionChange(
                    { ids: [entry.id], anchorId: entry.id, focusedId: entry.id },
                    () => setContext(context),
                  );
                else setContext(context);
              }}
            >
              {multiple ? (
                <Checkbox
                  className="absolute left-3 top-3 z-10"
                  tabIndex={-1}
                  aria-label={`${tr("Select")} ${entry.name}`}
                  checked={selected.has(entry.id)}
                  disabled={disabled}
                  onCheckedChange={() =>
                    onSelectionChange(selectResource(selection, entry.id, order, {}, true))
                  }
                />
              ) : null}
              <button
                type="button"
                data-resource-button={entry.id}
                aria-label={entry.name}
                aria-pressed={selected.has(entry.id)}
                disabled={disabled}
                tabIndex={
                  (selection.focusedId ? selection.focusedId === entry.id : index === 0) ? 0 : -1
                }
                className={`w-full min-w-0 rounded-lg p-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring ${view === "list" || entry.kind === "directory" ? `flex items-center gap-3 ${multiple ? "pl-9" : ""}` : "block"}`}
                onClick={(event) => pick(entry, event)}
                onFocus={() => {
                  if (selection.focusedId !== entry.id)
                    onSelectionChange({ ...selection, focusedId: entry.id });
                }}
                onDoubleClick={(event) => {
                  if (multiple && beforeClick.current) onSelectionChange(beforeClick.current);
                  beforeClick.current = null;
                  onOpen(entry, event.currentTarget);
                }}
              >
                <PreviewSurface
                  checker={entry.kind === "file" && resourceType(entry.name) === "image"}
                  className={
                    view === "grid" && entry.kind !== "directory"
                      ? "flex h-40 items-center justify-center overflow-hidden rounded-md"
                      : "flex size-12 shrink-0 items-center justify-center overflow-hidden rounded"
                  }
                >
                  <ResourcePreview entry={entry} />
                </PreviewSurface>
                <span className={`min-w-0 ${view === "grid" ? "block px-1 py-2" : "flex-1 py-1"}`}>
                  <span className="block truncate text-ui font-medium" title={entry.name}>
                    {entry.name}
                  </span>
                  {view === "grid" && showPaths && entry.kind === "file" ? (
                    <span
                      className="block truncate text-ui-xs text-muted-foreground"
                      dir="rtl"
                      style={{ textAlign: "left" }}
                      title={entry.path}
                    >
                      {entry.path.split("/").slice(0, -1).join("/") || tr("Library root")}
                    </span>
                  ) : null}
                  <span
                    className="block truncate text-ui-xs text-muted-foreground"
                    title={entry.path}
                  >
                    {view === "list"
                      ? entry.path
                      : entry.kind === "directory"
                        ? tr("Folder")
                        : humanResourceBytes(entry.bytes)}
                  </span>
                </span>
                {view === "list" ? (
                  <span className="hidden shrink-0 text-right text-ui-xs text-muted-foreground @[40rem]:block">
                    {entry.kind === "directory"
                      ? tr("Folder")
                      : `${tr(resourceType(entry.name))} · ${humanResourceBytes(entry.bytes)}`}
                    <br />
                    {new Date(entry.modifiedAt).toLocaleString()}
                  </span>
                ) : null}
              </button>
              {view === "grid" && !multiple && selected.has(entry.id) ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute right-3 top-3 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground"
                >
                  <CheckIcon className="size-3" />
                </span>
              ) : null}
            </article>
          ))}
        </div>
        {marquee ? (
          <div
            data-testid="resource-marquee"
            aria-hidden
            className="pointer-events-none absolute z-10 border border-ring bg-ring/15"
            style={marquee}
          />
        ) : null}
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
      <Menu
        open={!!context}
        onOpenChange={(open) => {
          if (!open) setContext(null);
        }}
      >
        <ComposerPickerMenuPopup
          anchor={
            context
              ? { getBoundingClientRect: () => new DOMRect(context.x, context.y, 0, 0) }
              : undefined
          }
          finalFocus={() => context?.trigger ?? scrollRef.current}
          align="start"
        >
          {actions.map((action) => (
            <MenuItem
              key={action.key}
              disabled={action.disabled}
              onClick={() => {
                setContext(null);
                action.run();
              }}
            >
              {action.label}
            </MenuItem>
          ))}
        </ComposerPickerMenuPopup>
      </Menu>
    </>
  );
}
