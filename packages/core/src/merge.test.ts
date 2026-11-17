// merge.ts: would `git merge <base>` be clean, conflict, or be refused?
// Every hand-made case is judged by running the real `git merge` (and
// `git merge --autostash`) on a copy; the engine must agree.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readMerge } from "./merge.js";
import { readRepo } from "./repo.js";
import { readStatus } from "./status.js";
import { expected, fixtureNames, fixtureWork } from "./test/fixtures.js";
import { realMerge } from "./test/judge.js";
import { type Sandbox, sandbox } from "./test/repos.js";

let box: Sandbox;
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  box = sandbox("merge");
  // The engine reads the user's Git config on purpose. In tests, give it the
  // same empty config the judge uses, so a personal setting (rerere, say)
  // can't change the answer on one machine only.
  for (const key of ["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"]) {
    saved[key] = process.env[key];
    process.env[key] = box.env[key];
  }
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  box.remove();
});

async function forecast(cwd: string, base?: string) {
  const repo = await readRepo(base ? { cwd, base } : { cwd });
  const status = await readStatus({ cwd, repo });
  return readMerge({
    cwd,
    base: repo.base,
    ahead: status.ahead,
    behind: status.behind,
    local: status.local,
  });
}

describe("fixture repos", () => {
  it.each(fixtureNames)("%s: matches what real Git did", async (name) => {
    // needsForcePush is push.ts's job; changes is for the later details view.
    const { needsForcePush, changes, ...want } = expected(name).merge;
    const result = await forecast(fixtureWork(name));
    expect(result.merge).toEqual(want);
  });

  it("messy-local: with --autostash the merge is clean", async () => {
    const { needsForcePush, ...want } = expected("messy-local").ifStashed.merge;
    const result = await forecast(fixtureWork("messy-local"));
    expect(result.ifStashed).toEqual(want);
    expect(result.reapplyOverlap).toEqual(["src/b.txt"]);
  });
});

describe("local changes vs real git merge", () => {
  /**
   * main changes touched.txt and adds added.txt. `diverged`: feature has a
   * commit of its own (a real merge); otherwise main can fast-forward.
   */
  function start(name: string, diverged: boolean): string {
    const repo = box.repo(name);
    writeFileSync(path.join(repo, "touched.txt"), "base\n");
    box.commit(repo, "other.txt", "base\n", "Base");
    box.git(repo, ["add", "."]);
    box.git(repo, ["commit", "--quiet", "--amend", "--no-edit"]);
    box.git(repo, ["switch", "--quiet", "-c", "feature"]);
    if (diverged) box.commit(repo, "mine.txt", "mine\n", "Mine");
    box.git(repo, ["switch", "--quiet", "main"]);
    writeFileSync(path.join(repo, "added.txt"), "new\n");
    box.git(repo, ["add", "added.txt"]); // commit() only adds its own file
    box.commit(repo, "touched.txt", "main\n", "Main");
    box.git(repo, ["switch", "--quiet", "feature"]);
    // A stray file here once made every "untracked clash" case pass vacuously.
    expect(box.git(repo, ["status", "--porcelain"])).toBe("");
    return repo;
  }
  const write = (repo: string, file: string, text: string) =>
    writeFileSync(path.join(repo, file), text);
  const stage = (repo: string, file: string, text: string) => {
    write(repo, file, text);
    box.git(repo, ["add", file]);
  };

  const cases: [string, (repo: string) => void][] = [
    ["nothing local", () => {}],
    ["staged, a file main didn't touch", (r) => stage(r, "other.txt", "s\n")],
    ["staged, a file main touched", (r) => stage(r, "touched.txt", "s\n")],
    ["staged new file", (r) => stage(r, "brandnew.txt", "n\n")],
    ["unstaged, a file main didn't touch", (r) => write(r, "other.txt", "u\n")],
    ["unstaged, a file main touched", (r) => write(r, "touched.txt", "u\n")],
    [
      "untracked where main adds a file",
      (r) => write(r, "added.txt", "mine\n"),
    ],
    [
      "untracked, same content as main's",
      (r) => write(r, "added.txt", "new\n"),
    ],
    ["untracked elsewhere", (r) => write(r, "scratch.txt", "x\n")],
    [
      "staged elsewhere + untracked where main adds",
      (r) => {
        stage(r, "other.txt", "s\n");
        write(r, "added.txt", "mine\n");
      },
    ],
    [
      "unstaged touched + untracked where main adds",
      (r) => {
        write(r, "touched.txt", "u\n");
        write(r, "added.txt", "mine\n");
      },
    ],
    [
      "staged elsewhere + unstaged touched",
      (r) => {
        stage(r, "other.txt", "s\n");
        write(r, "touched.txt", "u\n");
      },
    ],
  ];

  for (const diverged of [true, false]) {
    const kind = diverged ? "real merge" : "fast-forward";
    it.each(cases)(`${kind}: %s`, async (label, setup) => {
      const repo = start(`${kind}-${label}`.replace(/\W+/g, "-"), diverged);
      setup(repo);
      const result = await forecast(repo, "main");

      expect(result.merge).toEqual(realMerge(box, repo, "main"));
      if (result.merge.outcome === "refused") {
        expect(result.ifStashed).toEqual(
          realMerge(box, repo, "main", { autostash: true }),
        );
      } else {
        expect(result.ifStashed).toBeUndefined();
      }
    });
  }

  it("conflict and a blocking change: refused wins; stashed shows the conflict", async () => {
    const repo = start("conflict-and-blocked", true);
    box.commit(repo, "other.txt", "feature side\n", "Feature edits other");
    box.git(repo, ["switch", "--quiet", "main"]);
    box.commit(repo, "other.txt", "main side\n", "Main edits other");
    box.git(repo, ["switch", "--quiet", "feature"]);
    write(repo, "touched.txt", "u\n");

    const result = await forecast(repo, "main");
    expect(result.merge).toEqual(realMerge(box, repo, "main"));
    expect(result.merge.outcome).toBe("refused");
    expect(result.ifStashed).toEqual(
      realMerge(box, repo, "main", { autostash: true }),
    );
    expect(result.ifStashed?.outcome).toBe("conflict");
    expect(result.reapplyOverlap).toEqual(["touched.txt"]);
  });

  it("already up to date: clean, even with staged changes", async () => {
    const repo = box.repo("up-to-date");
    box.commit(repo, "a.txt", "a\n", "Base");
    box.git(repo, ["switch", "--quiet", "-c", "feature"]);
    stage(repo, "a.txt", "staged\n");
    const result = await forecast(repo, "main");
    expect(result.merge).toEqual(realMerge(box, repo, "main"));
    expect(result.merge).toEqual({ outcome: "clean" });
  });
});

describe("uncertain", () => {
  /** Both sides edit `file`; `attributes` is committed in the base. */
  function bothEdit(name: string, file: string, attributes: string): string {
    const repo = box.repo(name);
    writeFileSync(path.join(repo, ".gitattributes"), attributes);
    box.commit(repo, file, "base\n", "Base");
    box.git(repo, ["add", "."]);
    box.git(repo, ["commit", "--quiet", "--amend", "--no-edit"]);
    box.git(repo, ["switch", "--quiet", "-c", "feature"]);
    box.commit(repo, file, "feature\n", "Feature edit");
    box.git(repo, ["switch", "--quiet", "main"]);
    box.commit(repo, file, "main\n", "Main edit");
    box.git(repo, ["switch", "--quiet", "feature"]);
    return repo;
  }

  it("a custom merge driver on a touched file", async () => {
    const repo = bothEdit("driver", "data.json", "data.json merge=jsonmerge\n");
    const { merge } = await forecast(repo, "main");
    expect(merge).toMatchObject({
      outcome: "uncertain",
      reason: "custom-merge-driver",
    });
    expect(merge.outcome === "uncertain" && merge.detail).toMatch(/data\.json/);
  });

  it("built-in drivers (union) are not custom", async () => {
    const repo = bothEdit("union", "list.txt", "list.txt merge=union\n");
    expect((await forecast(repo, "main")).merge.outcome).not.toBe("uncertain");
  });

  it("a Git LFS file", async () => {
    const repo = bothEdit(
      "lfs",
      "big.bin",
      "*.bin filter=lfs diff=lfs merge=lfs -text\n",
    );
    expect((await forecast(repo, "main")).merge).toMatchObject({
      outcome: "uncertain",
      reason: "git-lfs",
    });
  });

  it("rerere on, with a conflict", async () => {
    const repo = bothEdit("rerere", "a.txt", "");
    box.git(repo, ["config", "rerere.enabled", "true"]);
    expect((await forecast(repo, "main")).merge).toMatchObject({
      outcome: "uncertain",
      reason: "rerere",
    });
  });

  it("rerere on, but clean: nothing to replay, so not uncertain", async () => {
    const repo = box.repo("rerere-clean");
    box.commit(repo, "a.txt", "a\n", "Base");
    box.git(repo, ["switch", "--quiet", "-c", "feature"]);
    box.commit(repo, "mine.txt", "m\n", "Mine");
    box.git(repo, ["switch", "--quiet", "main"]);
    box.commit(repo, "theirs.txt", "t\n", "Theirs");
    box.git(repo, ["switch", "--quiet", "feature"]);
    box.git(repo, ["config", "rerere.enabled", "true"]);
    expect((await forecast(repo, "main")).merge).toEqual({ outcome: "clean" });
  });
});
