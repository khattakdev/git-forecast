// The status screen, rendered from real engine reports on the fixture repos
// with colour off, a fixed width and a fixed "now".

import { forecastStatus, type StatusReport } from "@git-forecast/core";
import pc from "picocolors";
import { describe, expect, it } from "vitest";
import { ago, clip } from "./format.js";
import { formatStatus } from "./status-screen.js";
import { ENV, fixtureWork } from "./test/fixtures.js";

const ctx = (now: number, width = 100) => ({
  c: pc.createColors(false),
  width,
  now,
});

async function report(name: string): Promise<StatusReport> {
  const saved = { ...process.env };
  Object.assign(process.env, {
    GIT_CONFIG_NOSYSTEM: ENV.GIT_CONFIG_NOSYSTEM,
    GIT_CONFIG_GLOBAL: ENV.GIT_CONFIG_GLOBAL,
  });
  try {
    return await forecastStatus({ cwd: fixtureWork(name) });
  } finally {
    process.env = saved;
  }
}

describe("formatStatus", () => {
  it("messy-local: changes, old stashes, blocked merge, stash hint", async () => {
    const r = await report("messy-local");
    const text = formatStatus(r, ctx(1767225600 + 40 * 86400));
    expect(text).toContain("feature → origin/main · 2 ahead, 1 behind");
    expect(text).toContain("Pushed to origin/feature · 1 commit not pushed");
    expect(text).toMatch(/modified\s+src\/b\.txt/);
    expect(text).toMatch(/untracked\s+scratch\.txt/);
    expect(text).toMatch(/wip a\s+1 month ago {2}old/);
    expect(text).toContain(
      "If you merged now: blocked by your changes to src/b.txt",
    );
    expect(text.split("\n").at(-1)).toMatch(
      /^Next: git stash, then git forecast sync/,
    );
  });

  it("squash-prs: PR numbers first, suffix not repeated", async () => {
    const text = formatStatus(await report("squash-prs"), ctx(1767225600));
    expect(text).toContain("origin/main moved 4 commits · PRs #12 #15 #18");
    expect(text).toMatch(/ {2}#12 {2}Add login page {2,}src\/login\.txt/);
    expect(text).toMatch(/ {7}Bump version/);
    expect(text).not.toContain("Add login page (#12)  ");
    expect(text.split("\n").at(-1)).toBe("Next: git forecast sync");
  });

  it("conflict-step-2: names the conflict", async () => {
    const text = formatStatus(await report("conflict-step-2"), ctx(1767225600));
    expect(text).toContain("If you merged now: conflict in app.txt");
    expect(text).toContain("Not pushed yet");
  });

  it("up to date, gone upstream, never fetched, stale fetch", () => {
    const base: StatusReport = {
      schemaVersion: 1,
      branch: "feature",
      base: "origin/main",
      ahead: 1,
      behind: 0,
      upstream: { name: "origin/feature", gone: true },
      local: { staged: [], unstaged: [], untracked: [] },
      stashes: [],
      incoming: [],
      merge: { outcome: "clean" },
      freshness: {},
    };
    const text = formatStatus(base, ctx(2_000_000_000));
    expect(text).toContain("never fetched (--fetch to update)");
    expect(text).toContain(
      "origin/feature was deleted on the remote (merged?)",
    );
    expect(text).not.toContain("If you merged now");
    expect(text.split("\n").at(-1)).toBe("Up to date with origin/main");

    const stale = formatStatus(
      { ...base, freshness: { fetchedAt: 2_000_000_000 - 3 * 86400 } },
      ctx(2_000_000_000),
    );
    expect(stale).toContain("fetched 3 days ago (--fetch to update)");
  });

  it("long incoming lists are cut to the newest 10", () => {
    const incoming = Array.from({ length: 13 }, (_, i) => ({
      sha: String(i),
      subject: `Change ${i + 1}`,
      files: [{ status: "M", path: `f${i}.txt` }],
    }));
    const r: StatusReport = {
      schemaVersion: 1,
      branch: "f",
      base: "origin/main",
      ahead: 0,
      behind: 13,
      local: { staged: [], unstaged: [], untracked: [] },
      stashes: [],
      incoming,
      merge: { outcome: "clean" },
      freshness: {},
    };
    const text = formatStatus(r, ctx(0));
    expect(text).toContain("… 3 earlier (--json for all)");
    expect(text).toContain("Change 13");
    expect(text).not.toContain("Change 3 ");
  });
});

describe("helpers", () => {
  it.each([
    [0, "just now"],
    [90, "1 minute ago"],
    [7200, "2 hours ago"],
    [86400 * 3, "3 days ago"],
    [86400 * 65, "2 months ago"],
    [86400 * 400, "1 year ago"],
  ])("ago(%d s) = %s", (diff, want) => {
    expect(ago(1000000 - diff, 1000000)).toBe(want);
  });

  it("clip", () => {
    expect(clip("abcdef", 4)).toBe("abc…");
    expect(clip("abc", 4)).toBe("abc");
  });
});
