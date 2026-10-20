import { useEffect, useState } from "react";
import { Input } from "../ui/input";

export function SpriteNumberField({
  label,
  value,
  onChange,
  min = 1,
  max = 4096,
  step = 1,
  disabled = false,
  resetKey,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  resetKey?: string | number | boolean | undefined;
}) {
  const [draft, setDraft] = useState(String(value)),
    [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(String(value));
    setInvalid(false);
  }, [value, resetKey]);
  const commit = (raw: string) => {
    const number = Number(raw);
    if (!raw.trim() || !Number.isFinite(number)) {
      setInvalid(true);
      return;
    }
    const next = Math.min(max, Math.max(min, Math.round(number / step) * step));
    setDraft(String(next));
    setInvalid(false);
    if (next !== value) onChange(next);
  };
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-ui-sm">
      <span>{label}</span>
      <Input
        aria-label={label}
        aria-invalid={invalid || undefined}
        inputMode="decimal"
        type="text"
        role="spinbutton"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={
          draft.trim() !== "" && Number.isFinite(Number(draft)) ? Number(draft) : undefined
        }
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        className="min-w-0"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setInvalid(false);
        }}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const base =
              draft.trim() !== "" && Number.isFinite(Number(draft)) ? Number(draft) : value;
            const next = Math.min(max, Math.max(min, base + (e.key === "ArrowUp" ? step : -step)));
            setDraft(String(next));
            setInvalid(false);
            if (next !== value) onChange(next);
          }
          if (e.key === "Enter") {
            e.preventDefault();
            commit(e.currentTarget.value);
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setDraft(String(value));
            setInvalid(false);
          }
        }}
      />
    </label>
  );
}
