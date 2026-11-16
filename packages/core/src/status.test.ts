// status.ts: ahead/behind (base and upstream), uncommitted files, stashes.
// The fixtures' answer key was measured with different commands (git diff,
// git diff --cached, git ls-files) than the engine uses (git status
// --porcelain=v2), so agreement here is real evidence, not an echo.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readRepo } from "./repo.js";
import { readStatus } from "./status.js";
import { expected, fixtureNames, fixtureWork } from "./test/fixtures.js";
import { type Sandbox, sandbox } from "./test/repos.js";
import { ForecastError } from "./types.js";

let box: Sandbox;
beforeAll(() => {
  box = sandbox("status");
});
afterAll(() => box.remove());

async function statusOf(cwd: string) {
  return readStatus({ cwd, repo: await readRepo({ cwd }) });
}

async function errorOf(promise: Promise<unknown>): Promise<ForecastError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ForecastError);
  return error as ForecastError;
}

describe("fixture repos", () => {
  it.each(fixtureNames)("%s: matches what real Git recorded", async (name) => {
    const want = expected(name);
    const status = await statusOf(fixtureWork(name));
    expect(status.ahead).toBe(want.ahead);
    expect(status.behind).toBe(want.behind);
    expect(status.upstream).toEqual(want.upstream);
    if (want.local) expect(status.local).toEqual(want.local);
    if (want.stashes) expect(status.stashes).toEqual(want.stashes);
  });
});

describe("hand-made repos", () => {
  /** A bare origin with one commit, and a clone of it at root/name. */
  function cloneSetup(name: string): string {
    const origin = path.join(box.root, `${name}-origin.git`);
    const seed = box.repo(`${name}-seed`);
    box.commit(seed, "base.txt", "base\n", "Base");
    box.git(box.root, ["init", "--quiet", "--bare", origin]);
    box.git(seed, ["push", "--quiet", origin, "main"]);
    const work = path.join(box.root, name);
    box.git(box.root, ["clone", "--quiet", origin, work]);
    return work;
  }

  it("every kind of local change, sorted", async () => {
    const work = cloneSetup("kinds");
    // "1-old.txt": after a rename Git sends the old name as its own record;
    // starting it with "1" makes it look like a change record if not skipped.
    for (const file of [
      "both.txt",
      "1-old.txt",
      "gone.txt",
      "with space.txt",
    ]) {
      writeFileSync(path.join(work, file), `${file}\n`);
    }
    box.git(work, ["add", "."]);
    box.git(work, ["commit", "--quiet", "-m", "Files"]);
    box.git(work, ["push", "--quiet"]);

    writeFileSync(path.join(work, "both.txt"), "staged\n");
    box.git(work, ["add", "both.txt"]);
    writeFileSync(path.join(work, "both.txt"), "staged, then edited\n");
    box.git(work, ["mv", "1-old.txt", "new-name.txt"]);
    rmSync(path.join(work, "gone.txt"));
    writeFileSync(path.join(work, "with space.txt"), "edited\n");
    mkdirSync(path.join(work, "newdir", "deep"), { recursive: true });
    writeFileSync(path.join(work, "newdir", "deep", "u.txt"), "u\n");
    writeFileSync(path.join(work, "héllo.txt"), "h\n");
    writeFileSync(path.join(work, ".git", "info", "exclude"), "*.log\n");
    writeFileSync(path.join(work, "debug.log"), "ignored\n");

    expect((await statusOf(work)).local).toEqual({
      staged: ["both.txt", "new-name.txt"],
      unstaged: ["both.txt", "gone.txt", "with space.txt"],
      untracked: ["héllo.txt", "newdir/deep/u.txt"],
    });
  });

  it("ahead and behind are not swapped", async () => {
    const work = cloneSetup("ab");
    const other = path.join(box.root, "ab-other");
    box.git(box.root, [
      "clone",
      "--quiet",
      path.join(box.root, "ab-origin.git"),
      other,
    ]);
    box.commit(other, "theirs.txt", "1\n", "Theirs 1");
    box.commit(other, "theirs2.txt", "2\n", "Theirs 2");
    box.commit(other, "theirs3.txt", "3\n", "Theirs 3");
    box.git(other, ["push", "--quiet"]);
    box.git(work, ["fetch", "--quiet"]);
    box.commit(work, "mine.txt", "m\n", "Mine");

    const status = await statusOf(work);
    expect(status).toMatchObject({ ahead: 1, behind: 3 });
    expect(status.upstream).toEqual({
      name: "origin/main",
      ahead: 1,
      behind: 3,
    });
  });

  it("no upstream → none reported", async () => {
    const work = cloneSetup("no-upstream");
    box.git(work, ["switch", "--quiet", "-c", "feature"]);
    expect((await statusOf(work)).upstream).toBeUndefined();
  });

  it("upstream deleted on the remote → gone, no counts", async () => {
    const work = cloneSetup("gone");
    box.git(work, ["switch", "--quiet", "-c", "feature"]);
    box.git(work, ["push", "--quiet", "-u", "origin", "feature"]);
    box.git(work, ["push", "--quiet", "origin", "--delete", "feature"]);
    box.git(work, ["fetch", "--quiet", "--prune"]);
    expect((await statusOf(work)).upstream).toEqual({
      name: "origin/feature",
      gone: true,
    });
  });

  it("stashes: newest first, with subject and time", async () => {
    const work = cloneSetup("stashes");
    writeFileSync(path.join(work, "base.txt"), "one\n");
    box.git(work, ["stash", "push", "--quiet", "-m", "first"]);
    writeFileSync(path.join(work, "base.txt"), "two\n");
    box.git(work, ["stash", "push", "--quiet", "-m", "second\tafter a tab"]);
    const { stashes } = await statusOf(work);
    // Git turns the tab into a space when it saves the message, so a stash
    // subject never contains the tab status.ts splits on.
    expect(stashes.map((s) => s.subject)).toEqual([
      "On main: second after a tab",
      "On main: first",
    ]);
    for (const s of stashes) expect(s.time).toBeGreaterThan(1_600_000_000);
  });

  describe("operation in progress", () => {
    /** main and feature both change base.txt; returns the clone. */
    function conflicting(name: string): string {
      const work = cloneSetup(name);
      box.git(work, ["switch", "--quiet", "-c", "feature"]);
      box.commit(work, "base.txt", "feature\n", "Feature edit");
      box.git(work, ["switch", "--quiet", "main"]);
      box.commit(work, "base.txt", "main\n", "Main edit");
      return work;
    }

    it("merge with conflicts", async () => {
      const work = conflicting("merging");
      expect(() => box.git(work, ["merge", "feature"])).toThrow();
      const error = await errorOf(statusOf(work));
      expect(error.code).toBe("operation-in-progress");
      expect(error.message).toMatch(/merge/);
    });

    it("merge with conflicts fixed but not committed", async () => {
      const work = conflicting("merge-resolved");
      expect(() => box.git(work, ["merge", "feature"])).toThrow();
      writeFileSync(path.join(work, "base.txt"), "resolved\n");
      box.git(work, ["add", "base.txt"]);
      const error = await errorOf(statusOf(work));
      expect(error.code).toBe("operation-in-progress");
      expect(error.message).toMatch(/merge/);
    });

    it("conflicts with no merge marker (stash pop)", async () => {
      const work = cloneSetup("stash-pop");
      writeFileSync(path.join(work, "base.txt"), "stashed\n");
      box.git(work, ["stash", "push", "--quiet"]);
      box.commit(work, "base.txt", "committed\n", "Change base");
      expect(() => box.git(work, ["stash", "pop"])).toThrow();
      const error = await errorOf(statusOf(work));
      expect(error.code).toBe("operation-in-progress");
      expect(error.message).toMatch(/base\.txt/);
    });

    it("cherry-pick with conflicts", async () => {
      const work = conflicting("picking");
      expect(() => box.git(work, ["cherry-pick", "feature"])).toThrow();
      const error = await errorOf(statusOf(work));
      expect(error.code).toBe("operation-in-progress");
      expect(error.message).toMatch(/cherry-pick/);
    });
  });
});
