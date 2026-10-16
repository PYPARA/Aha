import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { drawingApi } from "../drawing/useDrawing";
import { spriteConversationPlanEntries } from "./spritePlanTimeline";
export function useSpriteConversationPlans(threadId: string) {
  const query = useQuery({
    queryKey: ["sprite-conversation", threadId],
    queryFn: () => drawingApi()?.spriteForThread?.({ threadId }) ?? Promise.resolve(null),
    enabled: !!threadId,
    refetchInterval: 2500,
  });
  const refetch = query.refetch;
  useEffect(
    () =>
      drawingApi()?.onEvent?.((e) => {
        if (e.type === "sprite-changed") void refetch();
      }),
    [refetch],
  );
  return useMemo(
    () => spriteConversationPlanEntries(query.data?.plans ?? [], threadId),
    [query.data?.plans, threadId],
  );
}
