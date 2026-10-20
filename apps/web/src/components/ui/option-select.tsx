import { Children, isValidElement, type ReactNode } from "react";
import { Select, SelectTrigger, SelectValue, SelectItem } from "./select";
import { ComposerPickerSelectPopup } from "../chat/ComposerPickerMenuPopup";

/** The shared Select for small forms whose options are naturally expressed as JSX. */
export function OptionSelect({
  label,
  value,
  onValueChange,
  disabled,
  children,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const options = Children.toArray(children).filter(
    isValidElement<{ value: string; children: ReactNode; disabled?: boolean }>,
  );
  const items = options.map((option) => ({
    value: String(option.props.value),
    label: option.props.children,
  }));
  return (
    <Select
      items={items}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onValueChange(String(next));
      }}
    >
      <SelectTrigger aria-label={label} className="min-w-0">
        <SelectValue />
      </SelectTrigger>
      <ComposerPickerSelectPopup>
        {options.map((option) => (
          <SelectItem
            key={String(option.props.value)}
            value={String(option.props.value)}
            disabled={option.props.disabled}
          >
            {option.props.children}
          </SelectItem>
        ))}
      </ComposerPickerSelectPopup>
    </Select>
  );
}
