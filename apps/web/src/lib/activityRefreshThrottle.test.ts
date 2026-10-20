import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";

import { createActivityRefreshThrottle } from "./activityRefreshThrottle";

afterEach(() => vi.useRealTimers());

it("refreshes a burst immediately and reads its final workspace state in the trailing pass", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const client = new QueryClient();
  let workspaceState = "initial";
  const observed: string[] = [];
  const refresh = createActivityRefreshThrottle(() => observed.push(workspaceState));

  refresh(client, ["/repo", "/repo", ""]);
  expect(observed).toEqual(["initial"]);
  await vi.advanceTimersByTimeAsync(100);
  workspaceState = "last edit";
  refresh(client, ["/repo"]);
  expect(observed).toEqual(["initial"]);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(observed).toEqual(["initial", "last edit"]);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(observed).toEqual(["initial", "last edit"]);
});

it("keeps independent workspaces and query clients responsive during another workspace's burst", () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const first = new QueryClient();
  const second = new QueryClient();
  const read = vi.fn();
  const refresh = createActivityRefreshThrottle(read);

  refresh(first, ["/first"]);
  refresh(first, ["/first"]);
  refresh(first, ["/second"]);
  refresh(second, ["/first"]);
  expect(read.mock.calls).toEqual([
    [first, "/first"],
    [first, "/second"],
    [second, "/first"],
  ]);
});
