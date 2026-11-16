import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Builds the fixture repos once per run (not once per test file).
    globalSetup: ["packages/core/src/test/fixtures-setup.ts"],
  },
});
