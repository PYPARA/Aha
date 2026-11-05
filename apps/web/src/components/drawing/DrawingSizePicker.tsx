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
import {
  calculateImageSize,
  IMAGE_FRAME_MIN_PIXELS,
  IMAGE_REQUEST_MIN_PIXELS,
  normalizeImageSize,
  parseRatio,
  type ImageSizeOptions,
  type SizeTier,
} from "./imageSize";

const stillTiers: SizeTier[] = ["1K", "2K", "4K"];
const frameTiers: SizeTier[] = ["512", "1K", "2K", "4K"];
const ratios = ["1:1", "3:2", "2:3", "16:9", "9:16", "4:3", "3:4", "21:9"];
const SHEET_MAX_PIXELS = 8_294_400;
function preset(size: string | undefined, tiers: SizeTier[], options: ImageSizeOptions) {
  for (const tier of tiers)
    for (const ratio of ratios)
      if (calculateImageSize(tier, ratio, options) === size) return { tier, ratio };
  return null;
}
/** GIF sizes are per frame; the model renders every frame on one sheet that must fit its limits. */
export function gifSheetNotice(size: string | undefined, frameCount: number) {
  const match = size?.match(/^(\d+)x(\d+)$/);
  if (!match) return null;
  const pixels = Number(match[1]) * Number(match[2]) * frameCount;
  if (pixels < IMAGE_REQUEST_MIN_PIXELS)
    return "Frames combined are below the minimum pixel budget; some providers reject this. Use more frames or a larger frame size.";
  if (pixels > SHEET_MAX_PIXELS)
    return "Frames combined exceed the pixel or 3840 edge limit; some providers reject this. Use fewer frames or a smaller frame size.";
  return null;
}
export function DrawingSizePicker({
  value,
  onChange,
  exact = false,
  animated,
}: {
  value?: string | undefined;
  exact?: boolean;
  /** GIF output: the value is the size of each frame. */
  animated?: { frameCount: number } | undefined;
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
        label={`${tr(animated ? "Frame size" : "Size")} ${drawingParameterLabel(value ?? "auto", tr).replace("x", "×")}`}
        aria-label={tr(animated ? "Frame size" : "Size")}
        onClick={() => setOpen(true)}
      />
      {open ? (
        <SizeDialog
          value={value}
          exact={exact}
          animated={animated}
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
  exact,
  animated,
}: {
  value?: string | undefined;
  onClose: () => void;
  onApply: (size?: string) => void;
  returnFocus: React.RefObject<HTMLButtonElement | null>;
  exact: boolean;
  animated?: { frameCount: number } | undefined;
}) {
  const tr = useAhaTranslation();
  const tiers = animated ? frameTiers : stillTiers;
  const sizeOptions: ImageSizeOptions = animated ? { minPixels: IMAGE_FRAME_MIN_PIXELS } : {};
  const current = preset(value, tiers, sizeOptions);
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
        ? (calculateImageSize(tier, ratio === "custom" ? customRatio : ratio, sizeOptions) ?? "")
        : validDimensions
          ? exact
            ? `${Number(width)}x${Number(height)}`
            : normalizeImageSize(`${Number(width)}x${Number(height)}`, sizeOptions)
          : "";
  const sizeParts = size.match(/^(\d+)x(\d+)$/);
  const valid =
    mode === "auto" ||
    (Boolean(size) &&
      (!exact ||
        (sizeParts &&
          Number(sizeParts[1]) <= 4096 &&
          Number(sizeParts[2]) <= 4096 &&
          Number(sizeParts[1]) * Number(sizeParts[2]) <= 8294400)));
  const adjusted =
    mode === "resolution" && validDimensions && size !== `${Number(width)}x${Number(height)}`;
  const sheetNotice = animated ? gifSheetNotice(size, animated.frameCount) : null;
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
          <DialogTitle>
            {tr(animated ? "Set frame dimensions" : "Set image dimensions")}
          </DialogTitle>
          <DialogDescription>
            {tr("Current")}: {drawingParameterLabel(value ?? "auto", tr).replace("x", "×")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5 px-5">
          {exact && (
            <div className="flex flex-wrap gap-2">
              {[512, 1024, 1536, 2048].map((edge) => (
                <Button
                  key={edge}
                  size="sm"
                  variant={size === `${edge}x${edge}` ? "secondary" : "outline"}
                  onClick={() => {
                    setMode("resolution");
                    setWidth(String(edge));
                    setHeight(String(edge));
                  }}
                >
                  {edge}×{edge}
                </Button>
              ))}
            </div>
          )}
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
                exact
                  ? "Custom request dimensions are sent as entered. Provider support may differ; returned dimensions are shown after generation."
                  : animated
                    ? "GIF size is per frame: multiples of 16, a maximum edge of 3840 and a maximum ratio of 3:1. The model renders all frames on one sheet, which must also fit its pixel limits. Provider support may differ."
                    : "Size presets use multiples of 16, a maximum edge of 3840, a maximum ratio of 3:1, and 655,360–8,294,400 pixels. Provider support may differ.",
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
            {animated && sizeParts ? (
              <p className="mt-1 text-ui-xs text-muted-foreground">
                {tr("Frames combined")}: {animated.frameCount} × {sizeParts[1]}×{sizeParts[2]}
              </p>
            ) : null}
          </div>
          {sheetNotice ? (
            <p role="status" className="text-ui-xs leading-relaxed text-warning">
              {tr(sheetNotice)}
            </p>
          ) : null}
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
