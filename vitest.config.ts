import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Builds the fixture repos once per run (not once per test file).
    globalSetup: ["packages/core/src/test/fixtures-setup.ts"],
    // Tests build real repos and run real git merge/rebase. Windows starts
    // processes far more slowly; the 5 s default timed out there in CI.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
