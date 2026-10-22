import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/integration/setup.ts"],
    fileParallelism: false,
    // Some flows (plan auto-requests, whole-batch walks) take several seconds and hit the 5s default under load
    testTimeout: 30000,
  },
});
