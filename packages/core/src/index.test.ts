import { describe, expect, it } from "vitest";
import { coreVersion } from "./index.js";

describe("core", () => {
  it("exposes its version", () => {
    expect(coreVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
