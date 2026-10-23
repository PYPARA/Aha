import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Model3DCommand } from "@synara/contracts";
import { ensureNativeApi } from "~/nativeApi";
import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";

export const model3dApi = () => ensureNativeApi().model3d;
export const model3dKey = ["model3d"] as const;
export const modelAssetUrl = (projectId: string, versionId: string, file = "model.glb") =>
  resolveWsHttpUrl(
    `/api/model3d/assets/${encodeURIComponent(projectId)}/${encodeURIComponent(versionId)}/${file}`,
  );
export function useModel3DEvents() {
  const client = useQueryClient();
  useEffect(
    () =>
      model3dApi().onEvent(() => {
        void client.invalidateQueries({ queryKey: model3dKey });
      }),
    [client],
  );
}
export function useModel3D(id: string | null) {
  return useQuery({
    queryKey: [...model3dKey, "project", id],
    enabled: !!id,
    queryFn: () => model3dApi().get({ id: id! }),
  });
}
export function useModel3DCommand() {
  const client = useQueryClient();
  return async (command: Model3DCommand) => {
    const result = await model3dApi().command(command);
    if (result.project)
      client.setQueryData([...model3dKey, "project", result.project.id], result.project);
    await client.invalidateQueries({ queryKey: model3dKey });
    return result;
  };
}
