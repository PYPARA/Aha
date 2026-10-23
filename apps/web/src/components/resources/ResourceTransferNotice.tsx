import { useEffect, useRef } from "react";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { toastManager } from "../ui/toast";
import { useResourceTransfer } from "./resourceLibrary";

/**
 * Reports transfers that did not start in the Resource Center (batch results, drawings).
 * Resource Center transfers keep their inline status bar with retry there.
 */
export function ResourceTransferNotice() {
  const tr = useAhaTranslation();
  const result = useResourceTransfer((s) => s.lastResult);
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (!result || result.libraryId || reported.current === result.transferId) return;
    reported.current = result.transferId;
    if (!result.rejected.length) return;
    toastManager.add({
      type: "error",
      title: tr("Some images were not added"),
      description: [...new Set(result.rejected.map((item) => tr(item.error)))].join("\n"),
    });
  }, [result, tr]);
  return null;
}
