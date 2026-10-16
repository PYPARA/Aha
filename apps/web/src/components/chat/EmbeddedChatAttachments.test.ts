import { expect, it, vi } from "vitest";
import { EmbeddedChatAttachments } from "./EmbeddedChatAttachments";
it("keeps a delayed crop targeted to the captured receiver even after switching conversations", async () => {
  const bridge = new EmbeddedChatAttachments();
  const a = vi.fn(async (_files: File[]) => {}),
    b = vi.fn(async (_files: File[]) => {});
  const unregister = bridge.register("a", a);
  let release!: (files: File[]) => void;
  const files = new Promise<File[]>((resolve) => {
    release = resolve;
  });
  const pending = bridge.attach("a", () => files);
  unregister();
  bridge.register("b", b);
  expect(bridge.isPending("a")).toBe(true);
  release([new File(["pixels"], "frame.png", { type: "image/png" })]);
  await pending;
  expect(a).toHaveBeenCalledOnce();
  expect(b).not.toHaveBeenCalled();
  expect(bridge.isPending("a")).toBe(false);
});
it("reports failures, supports retry and serializes repeated attachment intake", async () => {
  const bridge = new EmbeddedChatAttachments();
  await expect(bridge.attach("missing", async () => [])).rejects.toThrow("loading");
  const receive = vi.fn(async (_files: File[]) => {});
  receive.mockRejectedValueOnce(new Error("attachment limit"));
  bridge.register("a", receive);
  await expect(bridge.attach("a", async () => [])).rejects.toThrow("attachment limit");
  await bridge.attach("a", async () => []);
  expect(receive).toHaveBeenCalledTimes(2);
  expect(bridge.isPending("a")).toBe(false);
});
