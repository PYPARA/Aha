import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";
export default mergeConfig(
  viteConfig,
  defineConfig({
    // Prebundle direct hook dependencies so restored caches cannot reload tests mid-run.
    optimizeDeps: {
      include: ["react-dom/client", "zustand/vanilla/shallow", "@lexical/react/useLexicalEditable"],
    },
    resolve: {
      alias: {
        "~": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    test: {
      include: ["src/**/*.browser.tsx"],
      fileParallelism: false,
      maxWorkers: 1,
      browser: {
        enabled: true,
        provider: playwright(),
        instances: [{ browser: "chromium" }],
        headless: true,
        screenshotDirectory: fileURLToPath(
          new URL("../../.tmp/validation/browser", import.meta.url),
        ),
        api: { host: "127.0.0.1", port: 51230 },
      },
      testTimeout: 60000,
      hookTimeout: 60000,
      // Upstream-derived suites assert English copy; Aha's own suites pick Chinese explicitly.
      env: { VITE_AHA_DEFAULT_LANGUAGE: "system" },
    },
  }),
);
