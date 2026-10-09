import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";
export default mergeConfig(
  viteConfig,
  defineConfig({
    resolve: { alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) } },
    test: {
      include: ["src/**/*.browser.tsx"],
      fileParallelism: false,
      maxWorkers: 1,
      browser: {
        enabled: true,
        provider: playwright(),
        instances: [{ browser: "chromium" }],
        headless: true,
        api: { host: "127.0.0.1", port: 51230 },
      },
      testTimeout: 60000,
      hookTimeout: 60000,
    },
  }),
);
