import type { ReactNode } from "react";
import { Select, SelectTrigger, SelectValue, SelectItem } from "~/components/ui/select";
import { ComposerPickerSelectPopup } from "~/components/chat/ComposerPickerMenuPopup";

export function ResourceSelect({
  label,
  value,
  onChange,
  options,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: ReactNode; disabled?: boolean }[];
  disabled?: boolean;
}) {
  return (
    <Select
      items={options}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(String(next));
      }}
      disabled={disabled}
    >
      <SelectTrigger aria-label={label} size="sm" className="min-w-0">
        <SelectValue />
      </SelectTrigger>
      <ComposerPickerSelectPopup>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </SelectItem>
        ))}
      </ComposerPickerSelectPopup>
    </Select>
  );
}
