import { defineConfig } from "vitest/config";

/**
 * Principle II requires three correctness layers that are never conflated. They are separated
 * here by project and by npm script, so `test:unit`, `test:integration`, and `test:e2e` can never
 * silently run each other's suites.
 *
 * - unit         no model, no network
 * - integration  real schemas and the real statechart, stubbed platform edges
 * - e2e          a real private fixture repository, with only `ModelClient` substituted (R-015)
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "e2e",
          include: ["tests/e2e/**/*.e2e.ts"],
          environment: "node",
          // A real pull request round-trips through GitHub; the default 5s is far too short.
          testTimeout: 600_000,
          hookTimeout: 300_000,
          // The fixture repository, the installation's API allowance, and the runner slot are
          // exclusive resources (tasks.md, Principle VIII). No two e2e files may run at once.
          fileParallelism: false,
          maxConcurrency: 1,
        },
      },
    ],
  },
});
