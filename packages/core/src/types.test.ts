// Contract test: the report types must be able to say everything real Git
// said in fixtures/expected/, using the same field names. The sample reports
// below are written by hand and checked with `satisfies`; once the engine
// exists, its real output replaces them. Fixture values are a subset of the
// engine's (it may add fields such as a commit SHA), hence toMatchObject.

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertNever,
  ForecastError,
  type MergeForecast,
  type RebaseForecast,
  SCHEMA_VERSION,
  type StatusReport,
  type SyncReport,
} from "./index.js";

const EXPECTED = new URL("../../../fixtures/expected/", import.meta.url);

// biome-ignore lint/suspicious/noExplicitAny: fixture JSON is untyped by design
function fixture(name: string): any {
  return JSON.parse(readFileSync(new URL(`${name}.json`, EXPECTED), "utf8"));
}

const conflictStep2 = {
  schemaVersion: SCHEMA_VERSION,
  status: {
    schemaVersion: SCHEMA_VERSION,
    branch: "feature",
    base: "origin/main",
    ahead: 3,
    behind: 1,
    local: { staged: [], unstaged: [], untracked: [] },
    stashes: [],
    incoming: [
      {
        sha: "891258d",
        subject: "Reword greeting in app",
        files: [{ status: "M", path: "app.txt" }],
      },
    ],
    merge: { outcome: "conflict", conflictedFiles: ["app.txt"] },
    freshness: { fetchedAt: 1767225600 },
  },
  merge: { outcome: "conflict", conflictedFiles: ["app.txt"] },
  rebase: {
    outcome: "conflict",
    totalSteps: 3,
    stoppedAtStep: 2,
    stoppedAtCommit: "Change greeting in app",
    stoppedAtSha: "ebd9015",
    conflictedFiles: ["app.txt"],
  },
  recommendation: { pick: "merge", because: "history-shape" },
} satisfies SyncReport;

const messyLocal = {
  schemaVersion: SCHEMA_VERSION,
  branch: "feature",
  base: "origin/main",
  ahead: 2,
  behind: 1,
  upstream: { name: "origin/feature", ahead: 1, behind: 0 },
  local: {
    staged: [],
    unstaged: ["notes.txt", "src/b.txt"],
    untracked: ["scratch.txt"],
  },
  stashes: [
    { subject: "On feature: wip a", time: 1767225600 },
    { subject: "On feature: old experiment", time: 1748736000 },
  ],
  incoming: [],
  merge: { outcome: "refused", blockedBy: ["src/b.txt"] },
  freshness: {},
} satisfies StatusReport;

describe("report types match the fixture answer key", () => {
  it("conflict-step-2: merge and rebase use the fixture's names", () => {
    const expected = fixture("conflict-step-2");
    expect(conflictStep2.merge).toMatchObject(expected.merge);
    expect(conflictStep2.rebase).toMatchObject(expected.rebase);
    expect(conflictStep2.status).toMatchObject({
      branch: expected.branch,
      base: expected.base,
      ahead: expected.ahead,
      behind: expected.behind,
    });
  });

  it("messy-local: local state, stashes, upstream and a refused merge", () => {
    const expected = fixture("messy-local");
    expect(messyLocal).toMatchObject({
      upstream: expected.upstream,
      local: expected.local,
      stashes: expected.stashes,
      merge: expected.merge,
    });
  });

  it("pushed-branch: force-push facts fit on the clean outcomes", () => {
    const expected = fixture("pushed-branch");
    const merge: MergeForecast = { outcome: "clean", needsForcePush: false };
    const rebase: RebaseForecast = {
      outcome: "clean",
      totalSteps: 3,
      rewritesPushedCommits: 2,
      needsForcePush: true,
    };
    expect(merge).toMatchObject(expected.merge);
    expect(rebase).toMatchObject(expected.rebase);
  });

  it("every fixture outcome is one the types allow", () => {
    const allowed = ["clean", "conflict", "refused", "uncertain"];
    const files = readdirSync(EXPECTED).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const file of files) {
      const expected = fixture(file.replace(/\.json$/, ""));
      const results = [expected.merge, expected.rebase];
      if (expected.ifStashed) {
        results.push(expected.ifStashed.merge, expected.ifStashed.rebase);
      }
      for (const result of results) {
        expect(allowed, `${file}: ${result.outcome}`).toContain(result.outcome);
      }
    }
  });
});

describe("helpers", () => {
  // Exhaustive switch: adding an outcome to MergeForecast breaks the build
  // here until it is handled.
  function summary(m: MergeForecast): string {
    switch (m.outcome) {
      case "clean":
        return "clean";
      case "conflict":
        return `${m.conflictedFiles.length} files conflict`;
      case "refused":
        return `blocked by ${m.blockedBy.join(", ")}`;
      case "uncertain":
        return `uncertain: ${m.reason}`;
      default:
        return assertNever(m);
    }
  }

  it("handles every merge outcome", () => {
    expect(summary({ outcome: "refused", blockedBy: ["a.txt"] })).toBe(
      "blocked by a.txt",
    );
    expect(summary({ outcome: "uncertain", reason: "git-lfs" })).toBe(
      "uncertain: git-lfs",
    );
  });

  it("assertNever throws on data that bypassed the types", () => {
    const bogus = { outcome: "stale" } as unknown as never;
    expect(() => assertNever(bogus)).toThrow(/stale/);
  });

  it("ForecastError carries a code", () => {
    const error = new ForecastError("not-a-git-repo", "no .git found");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("not-a-git-repo");
    expect(error.name).toBe("ForecastError");
  });
});
