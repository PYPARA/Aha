// FILE: ComposerActionNotice.tsx
// Purpose: Detached notice above the composer: one short message plus inline action pills.
// Layer: Chat composer UI
// Exports: ComposerActionNotice

import type { ReactNode } from "react";
import { useAhaTranslation } from "../../aha/AppearanceProvider";

import { cn } from "~/lib/utils";
import { ComposerStackedPanel } from "./ComposerStackedPanel";
import { COMPOSER_INLINE_ACTION_PILL_CLASS_NAME } from "./composerPickerStyles";
import { COMPOSER_NOTICE_CONTENT_CLASS_NAME } from "./composerStackedPanelStyles";

export interface ComposerActionNoticeAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
}

export function ComposerActionNotice({
  message,
  actions,
  "data-testid": testId,
}: {
  message: ReactNode;
  actions: ReadonlyArray<ComposerActionNoticeAction>;
  "data-testid"?: string;
}) {
  const tr = useAhaTranslation();
  return (
    <ComposerStackedPanel
      detached
      className={cn(COMPOSER_NOTICE_CONTENT_CLASS_NAME, "mb-2")}
      role="status"
      data-testid={testId}
    >
      <p>{typeof message === "string" ? tr(message) : message}</p>
      <div className="mt-2 flex flex-wrap gap-3">
        {actions.map((action) => (
          <button
            key={tr(action.label)}
            type="button"
            className={cn(COMPOSER_INLINE_ACTION_PILL_CLASS_NAME, "disabled:opacity-60")}
            disabled={action.disabled}
            onClick={action.onClick}
          >
            {tr(action.label)}
          </button>
        ))}
      </div>
    </ComposerStackedPanel>
  );
}
