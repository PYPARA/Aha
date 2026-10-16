import { useMemo, useState } from "react";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import {
  ArchiveIcon,
  EllipsisIcon,
  LoaderCircleIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";
import { Menu, MenuItem, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { PickerPanelShell } from "../chat/PickerPanelShell";
import { PickerTriggerButton } from "../chat/PickerTriggerButton";
import {
  PICKER_PANEL_ACTION_ROW_CLASS_NAME,
  PICKER_PANEL_PLAIN_SEARCH_INPUT_CLASS_NAME,
  PICKER_PANEL_ROW_GEOMETRY_CLASS_NAME,
  PICKER_PANEL_ROW_SELECTED_CLASS_NAME,
} from "../chat/pickerPanelStyles";

export interface SpriteConversationOption {
  id: string;
  title: string;
  archived: boolean;
  draft: boolean;
  running: boolean;
  updatedAt: string;
}
export function SpriteConversationPicker({
  conversations,
  activeId,
  busy,
  showArchived,
  onShowArchived,
  onSelect,
  onNew,
  onAction,
}: {
  conversations: SpriteConversationOption[];
  activeId: string | null;
  busy: boolean;
  showArchived: boolean;
  onShowArchived: (value: boolean) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onAction: (action: "archive" | "restore" | "delete") => void;
}) {
  const tr = useAhaTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const active = conversations.find((c) => c.id === activeId);
  const visible = useMemo(
    () =>
      conversations
        .filter((c) => c.archived === showArchived)
        .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [conversations, showArchived],
  );
  const filtered = visible.filter((c) =>
    c.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <div className="flex min-w-0 items-center gap-1 border-b px-3 py-2">
      <Combobox
        items={visible.map((c) => c.id)}
        filteredItems={filtered.map((c) => c.id)}
        value={activeId}
        autoHighlight
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) setQuery("");
        }}
        onValueChange={(id: string | null) => {
          if (id) {
            onSelect(id);
            setOpen(false);
          }
        }}
      >
        <ComboboxTrigger
          render={
            <PickerTriggerButton
              icon={active?.archived ? <ArchiveIcon /> : null}
              className="flex-1 max-w-none sm:max-w-none"
              disabled={busy}
              aria-label={tr("Sprite conversations")}
              title={active?.title}
              label={active?.title ?? tr("Conversation")}
            />
          }
        />
        <ComboboxPopup align="start" className="min-w-64 p-0">
          <PickerPanelShell
            variant="plain"
            widthClassName="w-full"
            searchInput={
              <ComboboxInput
                inputClassName={PICKER_PANEL_PLAIN_SEARCH_INPUT_CLASS_NAME}
                placeholder={tr("Search conversations")}
                showTrigger={false}
                size="sm"
                unstyled
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            }
            footer={
              <button
                type="button"
                className={PICKER_PANEL_ACTION_ROW_CLASS_NAME}
                onClick={() => {
                  onShowArchived(!showArchived);
                  setQuery("");
                }}
              >
                <ArchiveIcon className="size-3.5" />
                {tr(showArchived ? "View active conversations" : "View archived conversations")}
              </button>
            }
          >
            <ComboboxEmpty>{tr("No conversations found")}</ComboboxEmpty>
            <ComboboxList className="max-h-64">
              {filtered.map((c, index) => (
                <ComboboxItem
                  key={c.id}
                  data-testid={`sprite-chat-option-${c.id}`}
                  value={c.id}
                  index={index}
                  hideIndicator={c.id !== activeId}
                  className={cn(
                    PICKER_PANEL_ROW_GEOMETRY_CLASS_NAME,
                    c.id === activeId && PICKER_PANEL_ROW_SELECTED_CLASS_NAME,
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2" title={c.title}>
                    {c.running && (
                      <LoaderCircleIcon
                        aria-label={tr("Running")}
                        className="size-3 animate-spin"
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    {c.draft && (
                      <span className="shrink-0 text-muted-foreground text-ui-sm">
                        {tr("Draft")}
                      </span>
                    )}
                  </span>
                </ComboboxItem>
              ))}
            </ComboboxList>
          </PickerPanelShell>
        </ComboboxPopup>
      </Combobox>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon"
              variant="ghost"
              className="size-7 shrink-0"
              disabled={busy}
              aria-label={tr("New conversation")}
              onClick={onNew}
            >
              <PlusIcon className="size-4" />
            </Button>
          }
        />
        <TooltipPopup>{tr("New conversation")}</TooltipPopup>
      </Tooltip>
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7 shrink-0"
                    disabled={busy || !active}
                    aria-label={tr("Conversation options")}
                  >
                    <EllipsisIcon className="size-4" />
                  </Button>
                }
              />
            }
          />
          <TooltipPopup>{tr("Conversation options")}</TooltipPopup>
        </Tooltip>
        <ComposerPickerMenuPopup align="end">
          {active && !active.draft && (
            <MenuItem onClick={() => onAction(active.archived ? "restore" : "archive")}>
              {active.archived ? <RotateCcwIcon /> : <ArchiveIcon />}
              {tr(active.archived ? "Restore conversation" : "Archive conversation")}
            </MenuItem>
          )}
          <MenuItem variant="destructive" onClick={() => onAction("delete")}>
            <Trash2 />
            {tr("Delete conversation")}
          </MenuItem>
        </ComposerPickerMenuPopup>
      </Menu>
    </div>
  );
}
