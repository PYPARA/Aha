"use client";

import { useRef } from "react";
import { create } from "zustand";

import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "~/components/ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";

export interface ConfirmDialogOptions {
  /** Already translated: names the target of the action. */
  title: string;
  /** Already translated: states the impact and whether it can be recovered. */
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Irreversible or data-removing actions use the destructive button and focus Cancel first. */
  destructive?: boolean;
}

interface PendingConfirm extends ConfirmDialogOptions {
  id: number;
  resolve: (confirmed: boolean) => void;
}

const useConfirmDialogStore = create<{ pending: PendingConfirm | null }>(() => ({ pending: null }));
let nextConfirmId = 0;

/** Promise-based replacement for window.confirm, rendered by the single ConfirmDialogHost. */
export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    // A newer request supersedes an unanswered one; the older caller sees a cancel.
    useConfirmDialogStore.getState().pending?.resolve(false);
    useConfirmDialogStore.setState({ pending: { ...options, id: ++nextConfirmId, resolve } });
  });
}

function settle(id: number, confirmed: boolean) {
  const pending = useConfirmDialogStore.getState().pending;
  if (pending?.id !== id) return;
  useConfirmDialogStore.setState({ pending: null });
  pending.resolve(confirmed);
}

export function ConfirmDialogHost() {
  const tr = useAhaTranslation();
  const pending = useConfirmDialogStore((s) => s.pending);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open && pending) settle(pending.id, false);
      }}
    >
      {pending && (
        <AlertDialogPopup initialFocus={pending.destructive ? cancelRef : confirmRef}>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending.title}</AlertDialogTitle>
            {pending.description ? (
              <AlertDialogDescription className="whitespace-pre-line">
                {pending.description}
              </AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button ref={cancelRef} variant="outline" />}>
              {pending.cancelLabel ?? tr("Cancel")}
            </AlertDialogClose>
            <Button
              ref={confirmRef}
              variant={pending.destructive ? "destructive" : "default"}
              onClick={() => settle(pending.id, true)}
            >
              {pending.confirmLabel ?? tr("Confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      )}
    </AlertDialog>
  );
}
