// incoming.ts: what landed on the base branch that you don't have yet.
// The answer key (squash-prs, rename) was recorded with a plain `git log`;
// for straight-line history that must match the engine's --first-parent view.
// Merge-commit histories aren't in the fixtures, so hand-made repos cover them.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePrNumber, readIncoming } from "./incoming.js";
import { readRepo } from "./repo.js";
import { expected, fixtureNames, fixtureWork } from "./test/fixtures.js";
import { type Sandbox, sandbox } from "./test/repos.js";

let box: Sandbox;
beforeAll(() => {
  box = sandbox("incoming");
});
afterAll(() => box.remove());

async function incomingOf(cwd: string) {
  const { base } = await readRepo({ cwd });
  return readIncoming({ cwd, base });
}

describe("parsePrNumber", () => {
  it.each([
    ["Add login page (#12)", 12],
    ["Explain #7 in README (#15)", 15],
    ['Revert "Add login page (#12)" (#18)', 18],
    ["Merge pull request #21 from team/pr21", 21],
    ["Fix the build (#12)   ", 12],
  ])("%j → %d", (subject, pr) => {
    expect(parsePrNumber(subject)).toBe(pr);
  });

  it.each([
    "Bump version",
    "Fix #12",
    "Fix (#abc)",
    "(#12) at the start doesn't count",
    "Merge branch 'main' into feature",
  ])("%j → none", (subject) => {
    expect(parsePrNumber(subject)).toBeUndefined();
  });
});

describe("fixture repos", () => {
  it.each(fixtureNames)("%s: one entry per commit behind", async (name) => {
    const incoming = await incomingOf(fixtureWork(name));
    // Every fixture's main is a straight line, so each commit is one entry.
    expect(incoming).toHaveLength(expected(name).behind);
    for (const commit of incoming) expect(commit.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it.each(fixtureNames.filter((name) => expected(name).incoming))(
    "%s: subjects and files match what real Git recorded",
    async (name) => {
      const incoming = await incomingOf(fixtureWork(name));
      expect(
        incoming.map(({ subject, files }) => ({ subject, files })),
      ).toEqual(expected(name).incoming);
    },
  );

  it("squash-prs: PR numbers from the subjects", async () => {
    const incoming = await incomingOf(fixtureWork("squash-prs"));
    expect(incoming.map((c) => c.pr)).toEqual([12, 15, undefined, 18]);
    expect("pr" in (incoming[2] ?? {})).toBe(false); // left out, not undefined
  });
});

describe("hand-made repos", () => {
  /** A repo on `feature`, branched from main after one base commit. */
  function start(name: string): string {
    const repo = box.repo(name);
    box.commit(repo, "base.txt", "base\n", "Base");
    box.git(repo, ["switch", "--quiet", "-c", "feature"]);
    box.commit(repo, "mine.txt", "mine\n", "My work");
    box.git(repo, ["switch", "--quiet", "main"]);
    return repo;
  }
  const finish = (repo: string) =>
    box.git(repo, ["switch", "--quiet", "feature"]);
  const read = (repo: string) => readIncoming({ cwd: repo, base: "main" });

  it("a PR merged with a merge commit is one entry with all its files", async () => {
    const repo = start("merge-commit");
    box.git(repo, ["switch", "--quiet", "-c", "pr21"]);
    box.commit(repo, "b.txt", "b\n", "PR commit 1");
    box.commit(repo, "c.txt", "c\n", "PR commit 2");
    box.git(repo, ["switch", "--quiet", "main"]);
    box.git(repo, [
      "merge",
      "--quiet",
      "--no-ff",
      "pr21",
      "-m",
      "Merge pull request #21 from team/pr21",
    ]);
    box.commit(repo, "d.txt", "d\n", "Direct fix (#22)");
    finish(repo);

    const incoming = await read(repo);
    expect(incoming.map(({ sha, ...rest }) => rest)).toEqual([
      {
        subject: "Merge pull request #21 from team/pr21",
        pr: 21,
        files: [
          { status: "A", path: "b.txt" },
          { status: "A", path: "c.txt" },
        ],
      },
      {
        subject: "Direct fix (#22)",
        pr: 22,
        files: [{ status: "A", path: "d.txt" }],
      },
    ]);
  });

  it("commits you already merged into your branch don't come back", async () => {
    const repo = start("already-merged");
    box.commit(repo, "early.txt", "e\n", "Early (#1)");
    finish(repo);
    box.git(repo, [
      "merge",
      "--quiet",
      "main",
      "-m",
      "Merge main into feature",
    ]);
    box.git(repo, ["switch", "--quiet", "main"]);
    box.commit(repo, "late.txt", "l\n", "Late (#2)");
    finish(repo);

    expect((await read(repo)).map((c) => c.subject)).toEqual(["Late (#2)"]);
  });

  it("renames, and names with spaces", async () => {
    const repo = start("rename");
    mkdirSync(path.join(repo, "new dir"));
    box.git(repo, ["mv", "base.txt", "new dir/renamed base.txt"]);
    box.git(repo, ["commit", "--quiet", "-m", "Move base"]);
    finish(repo);

    expect((await read(repo)).map((c) => c.files)).toEqual([
      [{ status: "R100", from: "base.txt", path: "new dir/renamed base.txt" }],
    ]);
  });

  // Windows doesn't allow a tab in a file name.
  it.skipIf(process.platform === "win32")("a tab in a file name", async () => {
    const repo = start("tab-name");
    writeFileSync(path.join(repo, "tab\tname.txt"), "t\n");
    box.git(repo, ["add", "."]);
    box.git(repo, ["commit", "--quiet", "-m", "Odd name"]);
    finish(repo);

    expect((await read(repo)).map((c) => c.files)).toEqual([
      [{ status: "A", path: "tab\tname.txt" }],
    ]);
  });

  it("nothing new on main → empty list", async () => {
    const repo = start("nothing-new");
    finish(repo);
    expect(await read(repo)).toEqual([]);
  });
});
