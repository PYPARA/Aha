export interface ResourceSelection {
  ids: string[];
  focusedId: string | null;
  anchorId: string | null;
}
export const emptyResourceSelection = (): ResourceSelection => ({
  ids: [],
  focusedId: null,
  anchorId: null,
});
export function selectResource(
  state: ResourceSelection,
  id: string,
  order: readonly string[],
  modifiers: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean } = {},
  multiple = false,
): ResourceSelection {
  const additive = modifiers.metaKey || modifiers.ctrlKey;
  if (modifiers.shiftKey && state.anchorId && order.includes(state.anchorId)) {
    const a = order.indexOf(state.anchorId),
      b = order.indexOf(id);
    if (b < 0) return state;
    const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    return {
      ids: additive ? [...new Set([...state.ids, ...range])] : [...range],
      focusedId: id,
      anchorId: state.anchorId,
    };
  }
  const ids =
    multiple || additive
      ? state.ids.includes(id)
        ? state.ids.filter((selected) => selected !== id)
        : [...state.ids, id]
      : [id];
  return { ids, focusedId: id, anchorId: id };
}
export function reconcileResourceSelection(
  state: ResourceSelection,
  order: readonly string[],
): ResourceSelection {
  const available = new Set(order);
  const ids = state.ids.filter((id) => available.has(id));
  const focusedId = state.focusedId && available.has(state.focusedId) ? state.focusedId : null;
  const anchorId = state.anchorId && available.has(state.anchorId) ? state.anchorId : null;
  return ids.length === state.ids.length &&
    focusedId === state.focusedId &&
    anchorId === state.anchorId
    ? state
    : { ids, focusedId, anchorId };
}
export interface ResourceRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
export function resourceRectsIntersect(a: ResourceRect, b: ResourceRect) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
