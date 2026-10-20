// Focused core regressions retained from Synara v1.0.7; unrelated upstream suites are excluded.
import { RotatingFileSink } from "@synara/shared/logging";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const tempRoots: string[] = [];
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-rotating-log-"));
  tempRoots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
describe("RotatingFileSink", () => {
  it("keeps one descriptor open and reopens it across rotations", () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, "server-child.log");
    const openSpy = vi.spyOn(fs, "openSync");
    const appendSpy = vi.spyOn(fs, "appendFileSync");
    try {
      const sink = new RotatingFileSink({
        filePath: logPath,
        maxBytes: 10,
        maxFiles: 2,
        keepFileOpen: true,
      });
      sink.write("12345");
      sink.write("67890");
      expect(openSpy).toHaveBeenCalledTimes(1);
      sink.write("abc");
      sink.write("def");
      sink.write("ghijk");
      sink.write("lmnop");
      sink.close();
      sink.close();
      expect(appendSpy).not.toHaveBeenCalled();
      // One open per active file: the initial one plus one after each rotation.
      expect(openSpy).toHaveBeenCalledTimes(3);
      expect(fs.readFileSync(logPath, "utf8")).toBe("ghijklmnop");
      expect(fs.readFileSync(path.join(dir, "server-child.log.1"), "utf8")).toBe("abcdef");
      expect(fs.readFileSync(path.join(dir, "server-child.log.2"), "utf8")).toBe("1234567890");
      // A write after close() reopens the file; this one also rotates.
      sink.write("x");
      sink.close();
      expect(fs.readFileSync(logPath, "utf8")).toBe("x");
      expect(fs.readFileSync(path.join(dir, "server-child.log.1"), "utf8")).toBe("ghijklmnop");
    } finally {
      openSpy.mockRestore();
      appendSpy.mockRestore();
    }
  });
});
