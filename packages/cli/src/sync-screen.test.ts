// The sync screen, rendered from real engine reports on the fixture repos.

import { forecastSync, type SyncReport } from "@git-forecast/core";
import pc from "picocolors";
import { describe, expect, it } from "vitest";
import { formatDetails, formatSync } from "./sync-screen.js";
import { ENV, fixtureWork } from "./test/fixtures.js";

const ctx = (width = 100) => ({
  c: pc.createColors(false),
  width,
  now: 1767225600,
});

async function report(name: string): Promise<SyncReport> {
  const saved = { ...process.env };
  Object.assign(process.env, {
    GIT_CONFIG_NOSYSTEM: ENV.GIT_CONFIG_NOSYSTEM,
    GIT_CONFIG_GLOBAL: ENV.GIT_CONFIG_GLOBAL,
  });
  try {
    return await forecastSync({ cwd: fixtureWork(name) });
  } finally {
    process.env = saved;
  }
}
const row = (text: string, label: string) =>
  text.split("\n").find((l) => l.startsWith(label)) ?? "";

describe("formatSync", () => {
  it("conflict-step-2: the rebase step and the merge conflict side by side", async () => {
    const text = formatSync(await report("conflict-step-2"), ctx(), {
      autostash: false,
    });
    expect(row(text, "Result")).toMatch(
      /stops at step 2 of 3\s+conflict in app\.txt/,
    );
    expect(text).toContain('"Change greeting in app"');
    expect(row(text, "History")).toMatch(/straight line\s+adds a merge commit/);
    expect(text).toMatch(/Recommended: (rebase|merge) · /);
    expect(text.split("\n").every((l) => l === l.trimEnd())).toBe(true);
  });

  it("pushed-branch: rebase rewrites pushed commits and needs a force push", async () => {
    const text = formatSync(await report("pushed-branch"), ctx(), {
      autostash: false,
    });
    expect(row(text, "Rewrites")).toMatch(/3 commits \(2 pushed\)\s+nothing/);
    expect(row(text, "Force push")).toMatch(/needed\s+not needed/);
  });

  it("messy-local: blocked, with the --autostash outcome and hint", async () => {
    const text = formatSync(await report("messy-local"), ctx(), {
      autostash: false,
    });
    expect(row(text, "Result")).toMatch(
      /blocked by your changes\s+blocked by your changes to src\/b\.txt/,
    );
    expect(text).toContain(
      "With --autostash: rebase clean, 2 steps, merge clean",
    );
    expect(text).toContain("git forecast sync --autostash");
  });

  it("messy-local with --autostash: the stashed outcomes and the overlap", async () => {
    const text = formatSync(await report("messy-local"), ctx(), {
      autostash: true,
    });
    expect(row(text, "Result")).toMatch(/clean, 2 steps\s+clean/);
    expect(text).toContain("Re-applying them may conflict in: src/b.txt");
    expect(text).not.toContain("are in the way");
  });

  it("narrow terminal: one option after the other", async () => {
    const text = formatSync(await report("pushed-branch"), ctx(50), {
      autostash: false,
    });
    expect(text).toMatch(/^rebase\n {2}Result {6}clean, 3 steps/m);
    expect(text).toMatch(/^merge\n {2}Result {6}clean/m);
  });

  it("team rule wins and says so", async () => {
    const r = await report("clean");
    const text = formatSync(
      { ...r, recommendation: { pick: "merge", because: "team-rule" } },
      ctx(),
      { autostash: false },
    );
    expect(text).toContain(
      "Recommended: merge · team rule in .gitforecast.json",
    );
  });

  it("details list every incoming file and the stopping step", async () => {
    const text = formatDetails(await report("conflict-step-2"), ctx());
    expect(text).toContain("origin/main moved 1 commit:");
    expect(text).toMatch(/M {4}app\.txt/);
    expect(text).toContain("step 2 of 3 stops");
  });
});
