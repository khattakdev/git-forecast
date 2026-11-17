// The built command end to end, on fixture repos.

import { mkdtempSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cli, fixtureCopy, fixtureWork, scratch } from "./test/fixtures.js";

describe("git-forecast", () => {
  it("-v and -h", () => {
    expect(cli(scratch, ["-v"]).stdout).toMatch(
      /^git-forecast \d+\.\d+\.\d+ \(core /,
    );
    expect(cli(scratch, ["-h"]).stdout).toContain("git forecast sync");
  });

  it("prints the status screen, exit 0", () => {
    const r = cli(fixtureWork("conflict-step-2"));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("If you merged now: conflict in app.txt");
    expect(r.stdout).not.toContain("\u001b["); // NO_COLOR
  });

  it("--json prints only the report", () => {
    const r = cli(fixtureWork("messy-local"), ["--json"]);
    const report = JSON.parse(r.stdout);
    expect(report).toMatchObject({
      branch: "feature",
      merge: { outcome: "refused", blockedBy: ["src/b.txt"] },
    });
  });

  it("--base compares against another branch", () => {
    const r = cli(fixtureWork("clean"), ["--json", "--base", "feature"]);
    expect(JSON.parse(r.stdout)).toMatchObject({
      base: "feature",
      ahead: 0,
      behind: 0,
    });
  });

  it("not a repo → exit 2 with the reason", () => {
    const dir = mkdtempSync(path.join(scratch, "plain-"));
    const r = cli(dir);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Not inside a Git repository");
  });

  it("--json errors are JSON too", () => {
    const dir = mkdtempSync(path.join(scratch, "plain-json-"));
    const r = cli(dir, ["--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toMatchObject({
      error: { code: "not-a-git-repo" },
    });
  });

  it("unknown flags and commands → exit 1", () => {
    expect(cli(scratch, ["--nope"]).code).toBe(1);
    expect(cli(scratch, ["frobnicate"]).code).toBe(1);
  });

  it("--fetch updates the fetch time", () => {
    const work = fixtureCopy("pushed-branch");
    const r = cli(work, ["--fetch", "--json"]);
    expect(r.code).toBe(0);
    const { fetchedAt } = JSON.parse(r.stdout).freshness;
    expect(Math.abs(fetchedAt - Date.now() / 1000)).toBeLessThan(60);
  });
});
