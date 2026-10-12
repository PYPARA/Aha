import { drawingParameterLabel } from "./drawingParameters";
import { useRef, useState } from "react";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { PickerTriggerButton } from "../chat/PickerTriggerButton";
import { calculateImageSize, normalizeImageSize, parseRatio, type SizeTier } from "./imageSize";

const tiers: SizeTier[] = ["1K", "2K", "4K"];
const ratios = ["1:1", "3:2", "2:3", "16:9", "9:16", "4:3", "3:4", "21:9"];
function preset(size?: string) {
  for (const tier of tiers)
    for (const ratio of ratios)
      if (calculateImageSize(tier, ratio) === size) return { tier, ratio };
  return null;
}
export function DrawingSizePicker({
  value,
  onChange,
}: {
  value?: string | undefined;
  onChange: (value?: string) => void;
}) {
  const tr = useAhaTranslation();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <PickerTriggerButton
        ref={trigger}
        className="max-w-none shrink-0 rounded-full px-2"
        icon={null}
        label={`${tr("Size")} ${drawingParameterLabel(value ?? "auto", tr).replace("x", "×")}`}
        aria-label={tr("Size")}
        onClick={() => setOpen(true)}
      />
      {open ? (
        <SizeDialog
          value={value}
          onClose={() => setOpen(false)}
          onApply={(size) => {
            onChange(size);
            setOpen(false);
          }}
          returnFocus={trigger}
        />
      ) : null}
    </>
  );
}
const choice = (active: boolean) =>
  `flex min-h-12 items-center justify-center rounded-xl border px-3 py-3 text-ui font-medium transition-colors ${active ? "border-primary/65 bg-primary/10 text-primary" : "border-transparent bg-muted/50 text-foreground/75 hover:bg-muted"}`;

function SizeDialog({
  value,
  onClose,
  onApply,
  returnFocus,
}: {
  value?: string | undefined;
  onClose: () => void;
  onApply: (size?: string) => void;
  returnFocus: React.RefObject<HTMLButtonElement | null>;
}) {
  const tr = useAhaTranslation();
  const current = preset(value);
  const parsed = value?.match(/^(\d+)x(\d+)$/);
  const [mode, setMode] = useState<"auto" | "ratio" | "resolution">(
    !value || value === "auto" ? "auto" : current ? "ratio" : "resolution",
  );
  const [tier, setTier] = useState<SizeTier>(current?.tier ?? "1K");
  const [ratio, setRatio] = useState(current?.ratio ?? "1:1");
  const [customRatio, setCustomRatio] = useState("16:9");
  const [width, setWidth] = useState(parsed?.[1] ?? "1024");
  const [height, setHeight] = useState(parsed?.[2] ?? "1024");
  const validDimensions =
    /^\d+$/.test(width) &&
    /^\d+$/.test(height) &&
    Number(width) > 0 &&
    Number(height) > 0 &&
    Number.isSafeInteger(Number(width)) &&
    Number.isSafeInteger(Number(height));
  const size =
    mode === "auto"
      ? "auto"
      : mode === "ratio"
        ? (calculateImageSize(tier, ratio === "custom" ? customRatio : ratio) ?? "")
        : validDimensions
          ? normalizeImageSize(`${Number(width)}x${Number(height)}`)
          : "";
  const valid = mode === "auto" || Boolean(size);
  const adjusted =
    mode === "resolution" && validDimensions && size !== `${Number(width)}x${Number(height)}`;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup
        bottomStickOnMobile={false}
        className="max-w-md"
        finalFocus={returnFocus}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.nativeEvent.isComposing && valid) {
            e.preventDefault();
            onApply(size);
          }
        }}
      >
        <DialogHeader className="px-5 pt-5 pb-4">
          <DialogTitle>{tr("Set image dimensions")}</DialogTitle>
          <DialogDescription>
            {tr("Current")}: {drawingParameterLabel(value ?? "auto", tr).replace("x", "×")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5 px-5">
          <div
            className="grid grid-cols-3 gap-1 rounded-xl bg-muted/40 p-1"
            aria-label={tr("Size mode")}
          >
            {(
              [
                ["auto", "Automatic"],
                ["ratio", "By aspect ratio"],
                ["resolution", "Custom width and height"],
              ] as const
            ).map(([v, label]) => (
              <Button
                key={v}
                variant={mode === v ? "secondary" : "ghost"}
                className="h-auto min-h-10 whitespace-normal"
                aria-pressed={mode === v}
                onClick={() => setMode(v)}
              >
                {tr(label)}
              </Button>
            ))}
          </div>
          {mode === "auto" ? (
            <p className="py-10 text-center text-ui text-muted-foreground">
              {tr("Dimensions are chosen automatically by the model.")}
            </p>
          ) : mode === "ratio" ? (
            <>
              <div>
                <p className="mb-2 text-ui-sm text-muted-foreground">{tr("Resolution tier")}</p>
                <div className="grid grid-cols-3 gap-2">
                  {tiers.map((v) => (
                    <button
                      type="button"
                      key={v}
                      className={choice(tier === v)}
                      aria-pressed={tier === v}
                      onClick={() => setTier(v)}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <p className="mb-2 text-ui-sm text-muted-foreground">{tr("Aspect ratio")}</p>
                <div className="grid grid-cols-4 gap-2">
                  {ratios.map((v) => {
                    const r = parseRatio(v)!;
                    return (
                      <button
                        type="button"
                        key={v}
                        className={`${choice(ratio === v)} flex-col gap-2`}
                        aria-pressed={ratio === v}
                        onClick={() => setRatio(v)}
                      >
                        <span
                          aria-hidden
                          className="block rounded-sm border-2 border-current opacity-65"
                          style={{
                            width: r.width >= r.height ? 24 : (24 * r.width) / r.height,
                            height: r.height >= r.width ? 24 : (24 * r.height) / r.width,
                          }}
                        />
                        {v}
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className={`${choice(ratio === "custom")} mt-2 w-full`}
                  aria-pressed={ratio === "custom"}
                  onClick={() => setRatio("custom")}
                >
                  {tr("Custom aspect ratio")}
                </button>
              </div>
              {ratio === "custom" ? (
                <label className="grid gap-2 text-ui-sm">
                  {tr("Custom aspect ratio")}
                  <Input
                    nativeInput
                    autoFocus
                    value={customRatio}
                    onChange={(e) => setCustomRatio(e.target.value)}
                    placeholder="16:9"
                    aria-label={tr("Custom aspect ratio")}
                  />
                </label>
              ) : null}
            </>
          ) : (
            <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2 py-4">
              <label className="grid gap-2 text-ui-sm">
                {tr("Width")}
                <Input
                  nativeInput
                  autoFocus
                  inputMode="numeric"
                  value={width}
                  onChange={(e) => setWidth(e.target.value)}
                  aria-label={tr("Width")}
                />
              </label>
              <Button
                variant="ghost"
                size="icon"
                aria-label={tr("Swap dimensions")}
                onClick={() => {
                  setWidth(height);
                  setHeight(width);
                }}
              >
                ⇄
              </Button>
              <label className="grid gap-2 text-ui-sm">
                {tr("Height")}
                <Input
                  nativeInput
                  inputMode="numeric"
                  value={height}
                  onChange={(e) => setHeight(e.target.value)}
                  aria-label={tr("Height")}
                />
              </label>
            </div>
          )}
          {mode !== "auto" ? (
            <p className="text-ui-xs leading-relaxed text-muted-foreground">
              {tr(
                "Size presets use multiples of 16, a maximum edge of 3840, a maximum ratio of 3:1, and 655,360–8,294,400 pixels. Provider support may differ.",
              )}
            </p>
          ) : null}
          <div className="rounded-xl bg-muted/50 p-4" aria-live="polite">
            <p className="text-ui-xs text-muted-foreground">
              {tr(adjusted ? "Will adjust to" : "Will use")}
            </p>
            <p className="mt-1 font-mono text-xl font-semibold">
              {mode === "auto"
                ? tr("Auto")
                : size?.replace("x", "×") || tr("Enter valid dimensions or ratio.")}
            </p>
          </div>
        </DialogPanel>
        <DialogFooter className="px-5 pb-5">
          <Button variant="secondary" onClick={onClose}>
            {tr("Cancel")}
          </Button>
          <Button disabled={!valid} onClick={() => onApply(size)}>
            {tr("Confirm")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
