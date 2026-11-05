// 3D generation leans on spatial reasoning (reading three views, placing parts, fixing the
// largest deviation), so its conversation starts at the model's strongest reasoning effort.
import type { ModelSelection, ProviderModelDescriptor } from "@synara/contracts";
import { getModelCapabilities } from "@synara/shared/model";
import type { QueryClient } from "@tanstack/react-query";
import type { useAppSettings } from "~/appSettings";
import { modelQueryOptionsForProviderInstance } from "~/hooks/useProviderModelCatalog";
import { resolveRuntimeModelDescriptor } from "../chat/runtimeModelCapabilities";

const LADDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** The highest effort on the known ladder among the supported ones, or null. */
export function strongestEffort(supported: readonly string[]): string | null {
  let best: string | null = null;
  for (const effort of supported)
    if (LADDER.includes(effort) && (best === null || LADDER.indexOf(effort) > LADDER.indexOf(best)))
      best = effort;
  return best;
}

/** The same selection with its reasoning effort raised to the strongest the model supports. */
export function withStrongestEffort(
  selection: ModelSelection,
  runtimeModel: ProviderModelDescriptor | undefined,
): ModelSelection {
  if (selection.provider !== "codex" && selection.provider !== "claudeAgent") return selection;
  const discovered = runtimeModel?.supportedReasoningEfforts?.map((e) => e.value) ?? [];
  const known = discovered.length
    ? discovered
    : getModelCapabilities(selection.provider, selection.model).reasoningEffortLevels.map(
        (l) => l.value,
      );
  const effort = strongestEffort(known);
  if (!effort) return selection;
  return selection.provider === "codex"
    ? { ...selection, options: { ...selection.options, reasoningEffort: effort } }
    : { ...selection, options: { ...selection.options, effort: effort as never } };
}

/** Looks up the model's discovered efforts (best effort; static capabilities otherwise). */
export async function strongestEffortSelection(
  selection: ModelSelection,
  queryClient: QueryClient,
  settings: ReturnType<typeof useAppSettings>["settings"],
): Promise<ModelSelection> {
  let runtimeModels: readonly ProviderModelDescriptor[] = [];
  try {
    const instanceId = selection.instanceId ?? selection.provider;
    const result = await Promise.race([
      queryClient.fetchQuery(
        modelQueryOptionsForProviderInstance({
          settings,
          provider: selection.provider,
          instanceId: instanceId as never,
          cwd: null,
          enabled: true,
        }),
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
    ]);
    runtimeModels = result?.models ?? [];
  } catch {
    // Discovery is optional here; static capabilities still apply.
  }
  return withStrongestEffort(
    selection,
    resolveRuntimeModelDescriptor({
      provider: selection.provider,
      model: selection.model,
      runtimeModels,
    }),
  );
}
