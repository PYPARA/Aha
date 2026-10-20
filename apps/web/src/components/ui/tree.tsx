import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "./button";
import { ChevronDownIcon, ChevronRightIcon, EllipsisIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

export interface TreeRow {
  id: string;
  parentId: string | null;
  level: number;
  label: string;
  hasChildren: boolean;
  expanded: boolean;
  selected: boolean;
  content: ReactNode;
}
/** Flat visible rows keep focus separate from activation and do not mount collapsed branches. */
export function Tree({
  rows,
  label,
  onActivate,
  onToggle,
  onContextMenu,
  menuLabel,
  className,
}: {
  rows: TreeRow[];
  label: string;
  onActivate: (id: string) => void;
  onToggle: (id: string) => void;
  onContextMenu: (id: string, anchor: DOMRect, trigger: HTMLElement) => void;
  menuLabel: (row: TreeRow) => string;
  className?: string;
}) {
  const prefix = useId();
  const scroll = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const active = rows.find((r) => r.id === focused) ?? rows.find((r) => r.selected) ?? rows[0];
  const activeIndex = rows.findIndex((r) => r.id === active?.id);
  const virtualized = rows.length > 100;
  const positions = useMemo(() => {
    const siblings = new Map<string | null, string[]>();
    for (const row of rows) {
      const ids = siblings.get(row.parentId) ?? [];
      ids.push(row.id);
      siblings.set(row.parentId, ids);
    }
    return new Map(
      [...siblings.values()].flatMap((ids) =>
        ids.map((id, index) => [id, { position: index + 1, size: ids.length }] as const),
      ),
    );
  }, [rows]);
  const virtual = useVirtualizer({
    count: rows.length,
    estimateSize: () => 36,
    getScrollElement: () => scroll.current,
    overscan: 8,
    enabled: rows.length > 100,
  });
  const visible =
    rows.length > 100
      ? virtual
          .getVirtualItems()
          .map((v) => ({ row: rows[v.index]!, index: v.index, start: v.start }))
      : rows.map((row, index) => ({ row, index, start: 0 }));
  useEffect(() => {
    if (activeIndex >= 0 && virtualized) virtual.scrollToIndex(activeIndex, { align: "auto" });
  }, [activeIndex, virtualized, virtual]);
  const move = (index: number) => {
    const row = rows[Math.max(0, Math.min(index, rows.length - 1))];
    if (!row) return;
    setFocused(row.id);
    if (rows.length > 100) virtual.scrollToIndex(index, { align: "auto" });
    else document.getElementById(`${prefix}-${row.id}`)?.scrollIntoView({ block: "nearest" });
  };
  return (
    <div
      ref={scroll}
      role="tree"
      aria-label={label}
      tabIndex={0}
      aria-activedescendant={active ? `${prefix}-${active.id}` : undefined}
      className={cn(
        "min-h-0 flex-1 overflow-auto rounded-md outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || !active) return;
        const index = rows.findIndex((r) => r.id === active.id);
        if (
          [
            "ArrowUp",
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
            "Home",
            "End",
            "Enter",
            " ",
            "ContextMenu",
          ].includes(event.key) ||
          (event.shiftKey && event.key === "F10")
        )
          event.preventDefault();
        else return;
        if (event.key === "ArrowUp") move(index - 1);
        if (event.key === "ArrowDown") move(index + 1);
        if (event.key === "Home") move(0);
        if (event.key === "End") move(rows.length - 1);
        if (event.key === "ArrowRight") {
          if (active.hasChildren && !active.expanded) onToggle(active.id);
          else if (rows[index + 1]?.parentId === active.id) move(index + 1);
        }
        if (event.key === "ArrowLeft") {
          if (active.expanded && active.hasChildren) onToggle(active.id);
          else if (active.parentId) move(rows.findIndex((r) => r.id === active.parentId));
        }
        if (event.key === "Enter" || event.key === " ") onActivate(active.id);
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          const row = document.getElementById(`${prefix}-${active.id}`);
          if (row) onContextMenu(active.id, row.getBoundingClientRect(), event.currentTarget);
        }
      }}
    >
      <div
        style={
          rows.length > 100 ? { height: virtual.getTotalSize(), position: "relative" } : undefined
        }
      >
        {visible.map(({ row, index, start }) => (
          <div
            key={row.id}
            ref={rows.length > 100 ? virtual.measureElement : undefined}
            data-index={index}
            id={`${prefix}-${row.id}`}
            role="treeitem"
            aria-label={row.label}
            aria-level={row.level}
            aria-posinset={positions.get(row.id)?.position}
            aria-setsize={positions.get(row.id)?.size}
            aria-selected={row.selected}
            aria-expanded={row.hasChildren ? row.expanded : undefined}
            className={cn(
              "flex min-h-9 min-w-0 items-center gap-1 rounded-md pr-1 text-ui-sm hover:bg-muted/50",
              row.selected && "bg-accent text-accent-foreground",
              focused === row.id && "ring-1 ring-inset ring-ring/60",
            )}
            style={{
              paddingLeft: `${Math.min(row.level - 1, 5) * 0.75}rem`,
              ...(rows.length > 100
                ? ({
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${start}px)`,
                  } as const)
                : {}),
            }}
            onClick={() => {
              setFocused(row.id);
              scroll.current?.focus({ preventScroll: true });
              onActivate(row.id);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setFocused(row.id);
              onContextMenu(
                row.id,
                new DOMRect(event.clientX, event.clientY, 0, 0),
                scroll.current!,
              );
            }}
          >
            {row.hasChildren ? (
              <Button
                size="icon-xs"
                variant="ghost"
                tabIndex={-1}
                aria-label={row.label}
                aria-expanded={row.expanded}
                onClick={(event) => {
                  event.stopPropagation();
                  setFocused(row.id);
                  scroll.current?.focus({ preventScroll: true });
                  onToggle(row.id);
                }}
              >
                {row.expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
              </Button>
            ) : (
              <span className="w-6 shrink-0" />
            )}
            <span className="flex min-w-0 flex-1 items-center gap-2" title={row.label}>
              {row.content}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              tabIndex={-1}
              aria-label={menuLabel(row)}
              onClick={(event) => {
                event.stopPropagation();
                setFocused(row.id);
                onContextMenu(row.id, event.currentTarget.getBoundingClientRect(), scroll.current!);
              }}
            >
              <EllipsisIcon />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
