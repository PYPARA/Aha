// Focused core regressions retained from Synara v1.0.7; unrelated upstream suites are excluded.
// FILE: providerUsageSnapshot.test.ts
// Purpose: Verifies provider usage scans stay bounded for large local archives.
// Layer: Server provider usage tests
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRecentClaudeUsageSamples } from "./providerUsageSnapshot";
const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
function assistantLine(input: {
  timestamp: string;
  totalTokens: number;
  sessionId?: string;
  messageId?: string;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: input.timestamp,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    message: {
      ...(input.messageId ? { id: input.messageId } : {}),
      model: "claude-opus-4-5",
      usage: { input_tokens: input.totalTokens, output_tokens: 0 },
    },
  });
}
const recentIso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600000).toISOString();
async function makeProjectsRoot(): Promise<{
  root: string;
  projectDir: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-claude-projects-"));
  tempDirs.push(root);
  const projectDir = path.join(root, "project-a");
  await fs.mkdir(projectDir);
  return { root, projectDir };
}
function line(hoursAgo: number, totalTokens: number, messageId: string): string {
  return `${assistantLine({
    timestamp: recentIso(hoursAgo),
    totalTokens,
    sessionId: "session-a",
    messageId,
  })}\n`;
}
function totalTokens(
  samples: ReadonlyArray<{
    totalTokens: number;
  }>,
): number {
  return samples.reduce((total, sample) => total + sample.totalTokens, 0);
}
// Bumps mtime past filesystem timestamp granularity so a rewrite is always observable.
async function touchLater(file: string): Promise<void> {
  const later = new Date(Date.now() + 5000);
  await fs.utimes(file, later, later);
}
describe("readRecentClaudeUsageSamples", () => {
  it("does not reopen unchanged transcripts on a later pass", async () => {
    const { root, projectDir } = await makeProjectsRoot();
    await fs.writeFile(path.join(projectDir, "a.jsonl"), line(2, 40, "m1") + line(1, 60, "m2"));
    await fs.writeFile(path.join(projectDir, "b.jsonl"), line(3, 5, "m3"));
    const first = await readRecentClaudeUsageSamples(root);
    expect(totalTokens(first)).toBe(105);
    const open = vi.spyOn(fs, "open");
    const second = await readRecentClaudeUsageSamples(root);
    expect(open).not.toHaveBeenCalled();
    expect(second).toEqual(first);
  });
  it("keeps deduping appended records across the verified cache boundary", async () => {
    const { root, projectDir } = await makeProjectsRoot();
    const file = path.join(projectDir, "a.jsonl");
    const prefix = line(2, 40, "m1");
    await fs.writeFile(file, prefix);
    await readRecentClaudeUsageSamples(root);
    // The repeated m1 record is the SDK writing another content block of the same message.
    await fs.appendFile(file, line(2, 40, "m1") + line(1, 60, "m2"));
    await touchLater(file);
    const samples = await readRecentClaudeUsageSamples(root);
    expect(samples.map((sample) => sample.totalTokens)).toEqual([40, 60]);
  });
  it("reparses a transcript that was truncated or replaced", async () => {
    const { root, projectDir } = await makeProjectsRoot();
    const file = path.join(projectDir, "a.jsonl");
    await fs.writeFile(file, line(3, 40, "m1") + line(2, 60, "m2"));
    expect(totalTokens(await readRecentClaudeUsageSamples(root))).toBe(100);
    await fs.writeFile(file, line(1, 7, "m3"));
    await touchLater(file);
    expect(totalTokens(await readRecentClaudeUsageSamples(root))).toBe(7);
    // A larger file whose first record keeps its length: only the new inode reveals the rewrite.
    const replacement = path.join(projectDir, "replacement.tmp");
    await fs.writeFile(replacement, line(1, 9, "m4") + line(1, 11, "m5"));
    await fs.rename(replacement, file);
    await touchLater(file);
    expect(totalTokens(await readRecentClaudeUsageSamples(root))).toBe(20);
  });
  it("reparses an in-place rewrite that grows past the previous newline", async () => {
    const { root, projectDir } = await makeProjectsRoot();
    const file = path.join(projectDir, "a.jsonl");
    await fs.writeFile(file, line(2, 100, "m1"));
    const original = await fs.stat(file);
    expect(totalTokens(await readRecentClaudeUsageSamples(root))).toBe(100);
    await fs.writeFile(file, line(2, 200, "m1") + line(1, 20, "m2"));
    await touchLater(file);
    expect((await fs.stat(file)).ino).toBe(original.ino);
    expect((await readRecentClaudeUsageSamples(root)).map((sample) => sample.totalTokens)).toEqual([
      200, 20,
    ]);
  });
  it("defers a partial trailing record until its newline arrives", async () => {
    const { root, projectDir } = await makeProjectsRoot();
    const file = path.join(projectDir, "a.jsonl");
    const pending = line(1, 60, "m2");
    const splitAt = Math.floor(pending.length / 2);
    await fs.writeFile(file, line(2, 40, "m1") + pending.slice(0, splitAt));
    expect(totalTokens(await readRecentClaudeUsageSamples(root))).toBe(40);
    await fs.appendFile(file, pending.slice(splitAt));
    await touchLater(file);
    expect(totalTokens(await readRecentClaudeUsageSamples(root))).toBe(100);
  });
  it("skips transcripts last written more than 30 days ago without opening them", async () => {
    const { root, projectDir } = await makeProjectsRoot();
    const stale = path.join(projectDir, "stale.jsonl");
    await fs.writeFile(stale, line(24 * 40, 500, "old"));
    const staleTime = new Date(Date.now() - 31 * 24 * 3600000);
    await fs.utimes(stale, staleTime, staleTime);
    await fs.writeFile(path.join(projectDir, "fresh.jsonl"), line(1, 5, "new"));
    const open = vi.spyOn(fs, "open");
    expect(totalTokens(await readRecentClaudeUsageSamples(root))).toBe(5);
    expect(open.mock.calls.map(([file]) => path.basename(String(file)))).toEqual(["fresh.jsonl"]);
  });
});
