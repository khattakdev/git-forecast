// The built command end to end, on fixture repos.

import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cli,
  fixtureCopy,
  fixtureWork,
  git,
  scratch,
} from "./test/fixtures.js";

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

describe("git-forecast sync", () => {
  const head = (cwd: string) => git(cwd, ["rev-parse", "HEAD"]).trim();

  it("piped without a pick: prints the comparison, changes nothing", () => {
    const work = fixtureCopy("clean");
    const before = head(work);
    const r = cli(work, ["sync"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Result\s+clean, 2 steps\s+clean/);
    expect(head(work)).toBe(before);
  });

  it("--merge runs the real merge and says what's next", () => {
    const work = fixtureCopy("clean");
    const r = cli(work, ["sync", "--merge"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Merged origin/main.");
    expect(r.stdout).toContain("Next: git push -u origin feature");
    expect(r.stdout).toContain("Undo: git reset --keep ORIG_HEAD");
    expect(
      git(work, ["log", "-1", "--format=%P"]).trim().split(" "),
    ).toHaveLength(2);
  });

  it("--rebase on a pushed branch suggests --force-with-lease", () => {
    const work = fixtureCopy("pushed-branch");
    const r = cli(work, ["sync", "--rebase"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Next: git push --force-with-lease");
    expect(git(work, ["rev-list", "--count", "origin/main..HEAD"]).trim()).toBe(
      "3",
    );
  });

  it("--rebase that conflicts: exit 1, says how to continue or back out", () => {
    const work = fixtureCopy("conflict-step-2");
    const r = cli(work, ["sync", "--rebase"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("The rebase stopped on a conflict in app.txt.");
    expect(r.stdout).toContain("git rebase --continue");
    expect(r.stdout).toContain("Back out: git rebase --abort");
  });

  it("blocked by local changes: refuses without running Git", () => {
    const work = fixtureCopy("messy-local");
    const before = head(work);
    const r = cli(work, ["sync", "--merge"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("blocked by your uncommitted changes");
    expect(head(work)).toBe(before);
  });

  it("--autostash (flag or .gitforecast.json): syncs, then reports the re-apply conflict it warned about", () => {
    for (const viaConfig of [false, true]) {
      const work = fixtureCopy("messy-local");
      if (viaConfig)
        writeFileSync(
          path.join(work, ".gitforecast.json"),
          '{ "autostash": true }',
        );
      const r = cli(
        work,
        viaConfig ? ["sync", "--merge"] : ["sync", "--merge", "--autostash"],
      );
      // The screen warned first: "Re-applying them may conflict in: src/b.txt".
      expect(r.stdout).toContain("may conflict in: src/b.txt");
      expect(r.stdout).toContain("Merged origin/main.");
      expect(r.stdout).toContain(
        "Re-applying your stashed changes conflicted in src/b.txt.",
      );
      expect(r.code).toBe(1);
      expect(git(work, ["stash", "list"])).toContain("autostash");
    }
  });

  it("--autostash with no overlap re-applies cleanly", () => {
    const work = fixtureCopy("clean");
    writeFileSync(path.join(work, "scratch.txt"), "x\n");
    git(work, ["add", "scratch.txt"]);
    const r = cli(work, ["sync", "--rebase", "--autostash"]);
    expect(r.code).toBe(0);
    expect(git(work, ["status", "--porcelain"])).toContain("A  scratch.txt");
  });

  it("0 behind: nothing to sync, and --rebase doesn't rewrite anything", () => {
    // Found on a real repo: 0 behind with the base merged in earlier got a
    // rebase/merge table and a prompt.
    const work = fixtureCopy("clean");
    git(work, ["merge", "--quiet", "--no-edit", "origin/main"]);
    const before = head(work);
    for (const args of [["sync"], ["sync", "--rebase"]]) {
      const r = cli(work, args);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(
        "Nothing to sync: feature already has everything on origin/main.",
      );
      expect(r.stdout).not.toContain("[r] rebase");
      expect(r.stdout).not.toContain("Result");
      expect(r.stdout).toContain("Next: git push -u origin feature");
    }
    expect(head(work)).toBe(before);
  });

  it("--json prints the sync report; --rebase with --merge is an error", () => {
    const work = fixtureWork("conflict-step-2");
    expect(JSON.parse(cli(work, ["sync", "--json"]).stdout)).toMatchObject({
      rebase: { outcome: "conflict", stoppedAtStep: 2 },
    });
    expect(cli(work, ["sync", "--rebase", "--merge"]).code).toBe(1);
  });
});
