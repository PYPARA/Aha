import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Gen3DCommand } from "@synara/contracts";
import { ensureNativeApi } from "~/nativeApi";
import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";

export const gen3dApi = () => ensureNativeApi().gen3d;
export const gen3dKey = ["gen3d"] as const;
export const gen3dAssetUrl = (
  projectId: string,
  kind: "versions" | "blueprint" | "references",
  id: string,
  file?: string,
  /** Blueprints are rewritten in place; pass their creation time to refresh cached images. */
  revision?: string,
) =>
  resolveWsHttpUrl(
    `/api/gen3d/assets/${encodeURIComponent(projectId)}/${kind}/${encodeURIComponent(id)}${
      file ? "/" + file : ""
    }${revision ? "?r=" + encodeURIComponent(revision) : ""}`,
  );
export function useGen3DEvents() {
  const client = useQueryClient();
  useEffect(
    () =>
      gen3dApi().onEvent(() => {
        void client.invalidateQueries({ queryKey: gen3dKey });
      }),
    [client],
  );
}
export function useGen3D(id: string | null) {
  return useQuery({
    queryKey: [...gen3dKey, "project", id],
    enabled: !!id,
    queryFn: () => gen3dApi().get({ id: id! }),
  });
}
export function useGen3DCommand() {
  const client = useQueryClient();
  return async (command: Gen3DCommand) => {
    const result = await gen3dApi().command(command);
    if (result.project)
      client.setQueryData([...gen3dKey, "project", result.project.id], result.project);
    await client.invalidateQueries({ queryKey: gen3dKey });
    return result;
  };
}
