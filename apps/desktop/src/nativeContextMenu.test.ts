import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeContextMenuSession, nativeContextMenuTemplate } from "./nativeContextMenu";
const params = {
  x: 12,
  y: 34,
  mediaType: "image" as const,
  misspelledWord: "",
  dictionarySuggestions: [],
  editFlags: {
    canCut: false,
    canCopy: true,
    canPaste: true,
    canSelectAll: false,
    canUndo: false,
    canRedo: false,
    canDelete: false,
    canEditRichly: false,
  },
};
afterEach(() => vi.useRealTimers());
describe("native menu extension", () => {
  it("preserves every native item, role, disabled flag and action, appending one separated action", () => {
    const actions = { replaceMisspelling: vi.fn(), copyImageAt: vi.fn() },
      click = vi.fn();
    const original = nativeContextMenuTemplate(params, actions);
    const combined = nativeContextMenuTemplate(params, actions, {
      label: "Add to resource center",
      click,
    });
    expect(combined.map(({ click: _click, ...item }) => item).slice(0, -2)).toEqual(
      original.map(({ click: _click, ...item }) => item),
    );
    expect(combined.map((item) => item.role ?? item.label ?? item.type)).toEqual([
      "Copy Image",
      "separator",
      "cut",
      "copy",
      "paste",
      "selectAll",
      "separator",
      "Add to resource center",
    ]);
    (combined[0]!.click as () => void)();
    expect(actions.copyImageAt).toHaveBeenCalledWith(12, 34);
    (combined.at(-1)!.click as () => void)();
    expect(click).toHaveBeenCalledOnce();
  });
  it("keeps spelling suggestions and does not add image actions to text", () => {
    const actions = { replaceMisspelling: vi.fn(), copyImageAt: vi.fn() };
    const menu = nativeContextMenuTemplate(
      { ...params, mediaType: "none", misspelledWord: "helo", dictionarySuggestions: ["hello"] },
      actions,
    );
    expect(menu[0]?.label).toBe("hello");
    (menu[0]!.click as () => void)();
    expect(actions.replaceMisspelling).toHaveBeenCalledWith("hello");
    expect(menu.some((item) => item.label === "Copy Image")).toBe(false);
  });
  it("falls back after 150 ms and ignores late responses", async () => {
    vi.useFakeTimers();
    const query = vi.fn(),
      result = vi.fn();
    const session = new NativeContextMenuSession(query, result),
      pending = session.query(12, 34);
    const id = query.mock.calls[0]![0].requestId;
    await vi.advanceTimersByTimeAsync(150);
    expect(await pending).toEqual({ requestId: id, label: null });
    session.respond(id, "late");
    session.finish(id, true);
    expect(result).toHaveBeenCalledWith({ requestId: id, selected: false });
  });
  it("cancels superseded requests, rejects foreign IDs, and delivers selection once", async () => {
    const query = vi.fn(),
      result = vi.fn();
    const session = new NativeContextMenuSession(query, result);
    const old = session.query(1, 2),
      oldId = query.mock.calls[0]![0].requestId;
    const next = session.query(3, 4),
      id = query.mock.calls[1]![0].requestId;
    expect(await old).toEqual({ requestId: oldId, label: null });
    expect(session.isCurrent(oldId)).toBe(false);
    session.respond(oldId, "wrong");
    session.respond("foreign", "wrong");
    session.respond(id, "Collect");
    expect(await next).toEqual({ requestId: id, label: "Collect" });
    session.finish(id, true);
    session.finish(id);
    expect(result.mock.calls).toEqual([
      [{ requestId: oldId, selected: false }],
      [{ requestId: id, selected: true }],
    ]);
  });
  it("falls back on query failure and cancels an outstanding query on navigation", async () => {
    const session = new NativeContextMenuSession(() => {
      throw new Error("gone");
    }, vi.fn());
    expect((await session.query(0, 0)).label).toBeNull();
    session.cancel();
    const query = vi.fn(),
      result = vi.fn(),
      other = new NativeContextMenuSession(query, result);
    const pending = other.query(0, 0);
    other.cancel();
    expect((await pending).label).toBeNull();
    expect(other.isCurrent(query.mock.calls[0]![0].requestId)).toBe(false);
  });
});
