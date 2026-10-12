import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  responses: [] as Array<{ status: number; headers: Record<string, string>; chunks: Buffer[] }>,
  calls: [] as Array<{ url: URL; options: Record<string, unknown> }>,
}));
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]),
}));
async function mockedTransport() {
  const { EventEmitter } = await import("node:events");
  return {
    request: (
      url: URL,
      options: Record<string, unknown>,
      callback: (response: EventEmitter) => void,
    ) => {
      state.calls.push({ url, options });
      const request = new EventEmitter() as EventEmitter & { end: () => void };
      request.end = () =>
        queueMicrotask(() => {
          const result = state.responses.shift()!;
          const incoming = Object.assign(new EventEmitter(), {
            statusCode: result.status,
            headers: result.headers,
            destroy: () => {},
          });
          callback(incoming);
          queueMicrotask(() => {
            for (const chunk of result.chunks) incoming.emit("data", chunk);
            incoming.emit("end");
          });
        });
      return request;
    },
  };
}
vi.mock("node:http", mockedTransport);
vi.mock("node:https", mockedTransport);
import { downloadImage } from "./imageApi";
beforeEach(() => {
  state.calls = [];
  state.responses = [];
});
describe("returned image URL downloads", () => {
  it("saves bytes through a pinned public connection without provider Authorization", async () => {
    state.responses.push({ status: 200, headers: {}, chunks: [Buffer.from("image-bytes")] });
    expect(
      Buffer.from(
        await downloadImage(
          "https://cdn.example/result?signature=test",
          new AbortController().signal,
        ),
      ).toString(),
    ).toBe("image-bytes");
    const options = state.calls[0]!.options;
    expect(options.headers).toBeUndefined();
    const lookup = options.lookup as (
      _host: string,
      _options: unknown,
      callback: (error: null, address: string, family: number) => void,
    ) => void;
    const callback = vi.fn();
    lookup("cdn.example", {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
    expect(options.family).toBe(4);
  });
  it("validates every redirect and never contacts a private target", async () => {
    state.responses.push({
      status: 302,
      headers: { location: "http://127.0.0.1/private" },
      chunks: [],
    });
    await expect(
      downloadImage("https://cdn.example/result", new AbortController().signal),
    ).rejects.toMatchObject({ code: "unsafe_image_url" });
    expect(state.calls).toHaveLength(1);
  });
  it("enforces the download limit and bounded redirects", async () => {
    state.responses.push({
      status: 200,
      headers: { "content-length": String(65 * 1024 * 1024) },
      chunks: [],
    });
    await expect(
      downloadImage("https://cdn.example/result", new AbortController().signal),
    ).rejects.toMatchObject({ code: "response_too_large" });
    state.responses = Array.from({ length: 4 }, () => ({
      status: 302,
      headers: { location: "/again" },
      chunks: [],
    }));
    await expect(
      downloadImage("https://cdn.example/result", new AbortController().signal),
    ).rejects.toMatchObject({ code: "image_download_failed" });
    expect(state.calls).toHaveLength(5);
  });
});
