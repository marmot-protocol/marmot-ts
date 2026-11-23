import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("../", import.meta.url)),
  test: {
    environment: "node",
    include: ["conformance/**/*.test.{ts,mjs}"],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    retry: 0,
    testTimeout: 60_000,
  },
});
