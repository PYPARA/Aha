import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
export default defineConfig({
  resolve: { alias: { "~": fileURLToPath(new URL("./apps/web/src", import.meta.url)) } },
  test: {
    include: ["apps/**/*.test.{ts,tsx}", "packages/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    fileParallelism: false,
    // Match upstream server integration tests, including Git commands that
    // intentionally outlive the ordinary 30-second command deadline.
    testTimeout: 90000,
    hookTimeout: 90000,
    // Keep tests off the developer's real ~/Documents/Aha workbenches (3D, drawing):
    // turn dispatch reads them, so real projects would make deadlines machine-dependent.
    env: {
      AHA_DOCUMENTS_DIR:
        process.env.AHA_DOCUMENTS_DIR ??
        path.join(os.tmpdir(), `aha-vitest-documents-${process.pid}`),
    },
  },
});
