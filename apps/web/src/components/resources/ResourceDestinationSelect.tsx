import type { ResourceEntry } from "@synara/contracts/resourceLibrary";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { ResourceSelect } from "./ResourceSelect";
const UNSELECTED = "$unselected";
/** null is not a destination; the empty path explicitly selects the library root. */
export function ResourceDestinationSelect({
  value,
  onChange,
  directories,
  disabled,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  directories: ResourceEntry[];
  disabled?: boolean;
}) {
  const tr = useAhaTranslation();
  return (
    <ResourceSelect
      label={tr("Destination")}
      value={value === null ? UNSELECTED : `path:${value}`}
      onChange={(value) => onChange(value === UNSELECTED ? null : value.slice(5))}
      disabled={disabled ?? false}
      options={[
        { value: UNSELECTED, label: tr("Choose a destination folder.") },
        { value: "path:", label: tr("Library root") },
        ...directories
          .toSorted((a, b) => a.path.localeCompare(b.path))
          .map((d) => ({ value: `path:${d.path}`, label: d.path })),
      ]}
    />
  );
}
