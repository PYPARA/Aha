import { useEffect, useId, useRef, useState } from "react";
import type { Model3DEnvironment } from "@synara/contracts";
import { useAhaTranslation } from "~/aha/AppearanceProvider";
import { CircleCheckIcon, InfoIcon } from "~/lib/icons";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  dialogFieldLabelClassName,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { model3dApi } from "./useModel3D";

export type RuntimeDialogIntent = "settings" | "blender";
const BLENDER_INTRO_KEY = "aha:model3d:blender-intro:v1";

export function blenderRuntimeReady(environment: Model3DEnvironment | undefined) {
  return !!(
    environment?.desktop &&
    environment.blenderPath &&
    environment.uvxPath &&
    environment.prepared &&
    !environment.error
  );
}

export function shouldRemindBlender(environment: Model3DEnvironment | undefined) {
  if (!blenderRuntimeReady(environment)) return true;
  try {
    return localStorage.getItem(BLENDER_INTRO_KEY) !== "seen";
  } catch {
    return true;
  }
}

/** Mounted for one opening, so query refreshes cannot replace an edited path. */
export function ModelRuntimeDialog({
  intent,
  initial,
  onClose,
  onChanged,
}: {
  intent: RuntimeDialogIntent;
  initial: Model3DEnvironment | undefined;
  onClose: () => void;
  onChanged: (environment: Model3DEnvironment) => void;
}) {
  const tr = useAhaTranslation(),
    fieldId = useId();
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const [blenderPath, setBlenderPath] = useState(initial?.blenderPath ?? ""),
    [uvxPath, setUvxPath] = useState(initial?.uvxPath ?? ""),
    [result, setResult] = useState(initial),
    [busy, setBusy] = useState<"detect" | "choose" | "prepare" | "check" | null>("detect"),
    [error, setError] = useState<string | null>(null),
    [detectionAttempt, setDetectionAttempt] = useState(0),
    [checked, setChecked] = useState(false);
  const receive = (environment: Model3DEnvironment | undefined) => {
    if (!environment) throw new Error("Could not detect the 3D runtime. Try again.");
    setResult(environment);
    setBlenderPath(environment.blenderPath ?? "");
    setUvxPath(environment.uvxPath ?? "");
    return environment;
  };
  useEffect(() => {
    let active = true;
    void model3dApi()
      .command({ operation: "environment" })
      .then((response) => {
        if (!active) return;
        const environment = response.environment;
        if (!environment) throw new Error("Could not detect the 3D runtime. Try again.");
        setResult(environment);
        setBlenderPath(environment.blenderPath ?? "");
        setUvxPath(environment.uvxPath ?? "");
        onChangedRef.current(environment);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setBusy(null);
      });
    return () => {
      active = false;
    };
  }, [detectionAttempt]);
  const pathsChanged =
      blenderPath.trim() !== (result?.blenderPath ?? "") ||
      uvxPath.trim() !== (result?.uvxPath ?? ""),
    ready = blenderRuntimeReady(result),
    displayedError = error ?? result?.error,
    canFinish = ready && !pathsChanged && !displayedError,
    canConfigure = result?.desktop === true && !busy;
  const choose = async (key: "blenderPath" | "uvxPath") => {
    setBusy("choose");
    setError(null);
    setChecked(false);
    try {
      const response = await model3dApi().command({
        operation: "blender-settings",
        [key]: ":choose:",
      });
      const environment = response.environment;
      if (!environment) throw new Error("Could not detect the 3D runtime. Try again.");
      setResult(environment);
      // Selecting one executable must not discard an unsaved edit in the other field.
      if (key === "blenderPath") setBlenderPath(environment.blenderPath ?? "");
      else setUvxPath(environment.uvxPath ?? "");
      onChanged(environment);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };
  const run = async (prepare: boolean) => {
    setBusy(prepare ? "prepare" : "check");
    setError(null);
    setChecked(false);
    try {
      const saved = await model3dApi().command({
        operation: "blender-settings",
        ...(blenderPath.trim() ? { blenderPath: blenderPath.trim() } : {}),
        ...(uvxPath.trim() ? { uvxPath: uvxPath.trim() } : {}),
      });
      const configured = receive(saved.environment);
      onChanged(configured);
      if (configured.error) throw new Error(configured.error);
      const response = await model3dApi().command({
        operation: prepare ? "prepare-runtime" : "check-runtime",
      });
      const environment = receive(response.environment);
      onChanged(environment);
      setChecked(!prepare && blenderRuntimeReady(environment));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };
  const finish = () => {
    if (intent === "blender") {
      try {
        localStorage.setItem(BLENDER_INTRO_KEY, "seen");
      } catch {
        // The reminder remains usable when local preferences cannot be persisted.
      }
    }
    onClose();
  };
  const statusTitle =
    busy === "detect"
      ? "Detecting Blender runtime…"
      : busy === "prepare"
        ? "Preparing Blender dependencies…"
        : busy === "check"
          ? "Checking Blender connection…"
          : !result
            ? "Runtime status unavailable"
            : !result.desktop
              ? "Open Aha desktop to use Blender"
              : !result.blenderPath
                ? "Blender was not found"
                : !result.uvxPath
                  ? "uvx was not found"
                  : !result.prepared
                    ? "Prepare Blender dependencies"
                    : checked
                      ? "Blender connection verified"
                      : "Blender runtime prepared";
  const statusDescription =
    busy === "prepare"
      ? "The first preparation downloads modeling dependencies. This may take a few minutes."
      : busy === "check"
        ? "A dedicated Blender window will open briefly for the connection check."
        : !result
          ? "Retry detection to read the local Blender environment."
          : !result.desktop
            ? "Local 3D execution requires the Aha desktop app. Saved models remain available for preview."
            : !result.blenderPath
              ? "Install Blender, then select its executable below."
              : !result.uvxPath
                ? "Install uv with uvx, then select the uvx executable below."
                : !result.prepared
                  ? "Your applications were found. Prepare the modeling dependencies before building."
                  : "Blender modeling opens a dedicated window. Keep it open while the task runs, then review the candidate in Aha.";
  const buttonLabel =
    busy === "prepare"
      ? "Preparing…"
      : busy === "check"
        ? "Checking…"
        : canFinish
          ? intent === "blender"
            ? "Use Blender"
            : "Done"
          : result?.prepared
            ? "Save and check"
            : "Prepare Blender runtime";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && (!busy || busy === "detect")) onClose();
      }}
    >
      <DialogPopup showCloseButton={!busy || busy === "detect"}>
        <DialogHeader className="pe-10">
          <DialogTitle>
            {tr(intent === "blender" ? "Model with Blender" : "3D runtime settings")}
          </DialogTitle>
          <DialogDescription>
            {tr(
              "AI models in a dedicated Blender window and returns the result to this workshop for preview and export.",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5 pt-2 text-ui-sm">
          <Alert role="status" aria-live="polite" variant={ready && !busy ? "success" : "default"}>
            {ready && !busy ? <CircleCheckIcon /> : <InfoIcon />}
            <AlertTitle>{tr(statusTitle)}</AlertTitle>
            <AlertDescription>
              {busy !== "detect" && <p>{tr(statusDescription)}</p>}
              {result?.blenderVersion && (
                <p className="break-words text-ui-xs">{result.blenderVersion}</p>
              )}
            </AlertDescription>
          </Alert>
          <fieldset className="min-w-0 space-y-4" disabled={!canConfigure}>
            <legend className="sr-only">{tr("Executable paths")}</legend>
            {(
              [
                {
                  key: "blenderPath",
                  label: "Blender executable",
                  chooseLabel: "Choose Blender executable",
                  value: blenderPath,
                  setValue: setBlenderPath,
                  placeholder: "/Applications/Blender.app/Contents/MacOS/Blender",
                },
                {
                  key: "uvxPath",
                  label: "uvx executable",
                  chooseLabel: "Choose uvx executable",
                  value: uvxPath,
                  setValue: setUvxPath,
                  placeholder: "/Users/you/.local/bin/uvx",
                },
              ] as const
            ).map((field) => (
              <div key={field.key} className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <label htmlFor={`${fieldId}-${field.key}`} className={dialogFieldLabelClassName}>
                    {tr(field.label)}
                  </label>
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={tr(field.chooseLabel)}
                    onClick={() => void choose(field.key)}
                  >
                    {tr("Choose executable")}
                  </Button>
                </div>
                <Input
                  id={`${fieldId}-${field.key}`}
                  value={field.value}
                  onChange={(event) => {
                    field.setValue(event.target.value);
                    setChecked(false);
                  }}
                  placeholder={field.placeholder}
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
            ))}
          </fieldset>
          {displayedError && (
            <Alert variant="error">
              <AlertTitle>{tr("Runtime setup failed")}</AlertTitle>
              <AlertDescription className="break-words whitespace-pre-wrap">
                {tr(displayedError)}
              </AlertDescription>
            </Alert>
          )}
          {pathsChanged && (
            <p role="status" className="text-ui-xs text-muted-foreground">
              {tr("Executable paths have changed. Save and check before modeling.")}
            </p>
          )}
          <details className="text-ui-xs text-muted-foreground">
            <summary className="cursor-pointer rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring">
              {tr("Runtime details")}
            </summary>
            <div className="space-y-2 pt-2 leading-relaxed">
              <p>
                {tr(
                  "Pinned mcp-for-blender 2.2.2. Preparation downloads dependencies into Aha's private runtime, without changing other clients or global Blender settings.",
                )}
              </p>
              <p>
                {tr(
                  "Blender safe mode is enabled. The dedicated instance isolates projects; it is not an operating-system Python sandbox.",
                )}
              </p>
            </div>
          </details>
        </DialogPanel>
        <DialogFooter className="sm:flex-wrap">
          <Button variant="ghost" disabled={!!busy && busy !== "detect"} onClick={onClose}>
            {tr(canFinish ? "Close" : "Set up later")}
          </Button>
          {ready && !pathsChanged && (
            <Button variant="outline" disabled={!canConfigure} onClick={() => void run(false)}>
              {tr(busy === "check" ? "Checking…" : "Check connection")}
            </Button>
          )}
          {!result && !busy ? (
            <Button
              onClick={() => {
                setError(null);
                setBusy("detect");
                setDetectionAttempt((attempt) => attempt + 1);
              }}
            >
              {tr("Retry")}
            </Button>
          ) : (
            (result?.desktop || !result) && (
              <Button
                disabled={!canConfigure}
                onClick={() => (canFinish ? finish() : void run(!result?.prepared))}
              >
                {tr(buttonLabel)}
              </Button>
            )
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
