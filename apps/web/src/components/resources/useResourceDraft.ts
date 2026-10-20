import { useCallback, useEffect, useRef, useState } from "react";
import type { ResourceEntry } from "@synara/contracts/resourceLibrary";
import { resourceApi } from "./resourceLibrary";

interface Draft {
  id: string;
  tags: string;
  notes: string;
  initialTags: string;
  initialNotes: string;
}
const makeDraft = (entry: ResourceEntry | null): Draft => ({
  id: entry?.id ?? "",
  tags: entry?.tags.join(", ") ?? "",
  notes: entry?.notes ?? "",
  initialTags: entry?.tags.join(", ") ?? "",
  initialNotes: entry?.notes ?? "",
});
export function useResourceDraft(entry: ResourceEntry | null, onUpdated: () => Promise<unknown>) {
  const [draft, setDraft] = useState(() => makeDraft(entry));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const pending = useRef<(() => void) | null>(null);
  const entryId = entry?.id ?? "";
  const entryTags = entry?.tags.join(", ") ?? "";
  const entryNotes = entry?.notes ?? "";
  const dirty = draft.tags !== draft.initialTags || draft.notes !== draft.initialNotes;
  useEffect(() => {
    setDraft((previous) =>
      previous.tags === previous.initialTags && previous.notes === previous.initialNotes
        ? {
            id: entryId,
            tags: entryTags,
            notes: entryNotes,
            initialTags: entryTags,
            initialNotes: entryNotes,
          }
        : previous,
    );
    setError(null);
  }, [entryId, entryNotes, entryTags]);
  const guard = useCallback(
    (action: () => void) => {
      if (saving) return;
      if (dirty) {
        pending.current = action;
        setConfirmLeave(true);
      } else action();
    },
    [dirty, saving],
  );
  const save = async () => {
    if (!draft.id || saving) return false;
    const submitted = { ...draft };
    setSaving(true);
    setError(null);
    try {
      const tags = submitted.tags
        .split(/[,，]/u)
        .map((tag) => tag.trim())
        .filter(Boolean);
      await resourceApi({ op: "metadata", ids: [submitted.id], tags, notes: submitted.notes });
      setDraft((previous) =>
        previous.id === submitted.id
          ? { ...previous, initialTags: submitted.tags, initialNotes: submitted.notes }
          : previous,
      );
      await onUpdated();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setSaving(false);
    }
  };
  const leave = () => {
    const action = pending.current;
    pending.current = null;
    setConfirmLeave(false);
    setDraft(makeDraft(entry));
    action?.();
  };
  return {
    draft,
    setDraft,
    dirty,
    saving,
    error,
    guard,
    save,
    confirmLeave,
    leave,
    cancelLeave: () => {
      pending.current = null;
      setConfirmLeave(false);
    },
    saveAndLeave: async () => {
      if (!(await save())) return;
      const action = pending.current;
      pending.current = null;
      setConfirmLeave(false);
      action?.();
    },
  };
}
