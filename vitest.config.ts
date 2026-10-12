import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
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
  },
});
