import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { coreVersion } from "./index.js";

describe("core", () => {
  it("coreVersion matches package.json (bump both when releasing)", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(coreVersion).toBe(pkg.version);
  });
});
