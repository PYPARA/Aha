import { Select, SelectTrigger, SelectValue, SelectItem } from "../ui/select";
import { ComposerPickerSelectPopup } from "../chat/ComposerPickerMenuPopup";

export function SpriteSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-ui-sm">
      <span>{label}</span>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next !== null) onChange(next as T);
        }}
        disabled={disabled}
        items={options}
      >
        <SelectTrigger aria-label={label} className="min-w-0">
          <SelectValue />
        </SelectTrigger>
        <ComposerPickerSelectPopup>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </ComposerPickerSelectPopup>
      </Select>
    </label>
  );
}
