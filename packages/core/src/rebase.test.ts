// rebase.ts: which step of `git rebase <base>` stops, if any. Every hand-made
// case is judged by running the real `git rebase` (and `--autostash`) on a
// copy, in both the batch simulation and the one-process-per-step fallback.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseGitVersion } from "./git.js";
import { readRebase } from "./rebase.js";
import { readRepo } from "./repo.js";
import { readStatus } from "./status.js";
import { expected, fixtureNames, fixtureWork } from "./test/fixtures.js";
import { realRebase } from "./test/judge.js";
import { type Sandbox, sandbox } from "./test/repos.js";

let box: Sandbox;
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  box = sandbox("rebase");
  // Same empty Git config as the judge, so personal settings can't differ.
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

async function forecast(
  cwd: string,
  base?: string,
  mode: "batch" | "one-by-one" = "batch",
) {
  const repo = await readRepo(base ? { cwd, base } : { cwd });
  const status = await readStatus({ cwd, repo });
  return readRebase({ cwd, base: repo.base, local: status.local, mode });
}

/** The fixture answer key minus fields other modules own. */
function want(rebase: Record<string, unknown>) {
  const { rewritesPushedCommits, needsForcePush, changes, ...rest } = rebase;
  return rest;
}

describe("fixture repos", () => {
  it.each(fixtureNames)("%s: matches what real Git did", async (name) => {
    const result = await forecast(fixtureWork(name));
    expect(result.rebase).toMatchObject(want(expected(name).rebase));
  });

  it("messy-local: with --autostash the rebase is clean", async () => {
    const result = await forecast(fixtureWork("messy-local"));
    expect(result.ifStashed).toEqual(
      want(expected("messy-local").ifStashed.rebase),
    );
  });
});

describe("hand-made repos vs real git rebase", () => {
  const write = (repo: string, file: string, text: string) =>
    writeFileSync(path.join(repo, file), text);

  /** A repo on `feature`. `mine`/`theirs`: [file, content, subject] commits. */
  function build(
    name: string,
    mine: [string, string, string][],
    theirs: [string, string, string][],
  ): string {
    const repo = box.repo(name);
    box.commit(repo, "app.txt", "base\n", "Base");
    box.git(repo, ["switch", "--quiet", "-c", "feature"]);
    for (const [file, text, subject] of mine)
      box.commit(repo, file, text, subject);
    box.git(repo, ["switch", "--quiet", "main"]);
    for (const [file, text, subject] of theirs)
      box.commit(repo, file, text, subject);
    box.git(repo, ["switch", "--quiet", "feature"]);
    expect(box.git(repo, ["status", "--porcelain"])).toBe("");
    return repo;
  }

  const conflictAtTwo = (name: string) =>
    build(
      name,
      [
        ["one.txt", "1\n", "Step one"],
        ["app.txt", "mine\n", "Step two edits app"],
        ["three.txt", "3\n", "Step three"],
      ],
      [
        ["app.txt", "theirs\n", "Main edits app"],
        ["added.txt", "new\n", "Main adds a file"],
      ],
    );
  const cleanCase = (name: string) =>
    build(
      name,
      [
        ["one.txt", "1\n", "Step one"],
        ["two.txt", "2\n", "Step two"],
      ],
      [
        ["app.txt", "theirs\n", "Main edits app"],
        ["added.txt", "new\n", "Main adds a file"],
      ],
    );

  const scenarios: [string, (name: string) => string][] = [
    ["conflict at step 2 of 3", conflictAtTwo],
    ["clean", cleanCase],
    [
      // Step 2 only applies cleanly on top of step 1's result, so this fails
      // if the simulation doesn't carry each step's tree forward.
      "two of your commits edit the same file in turn",
      (name) =>
        build(
          name,
          [
            ["app.txt", "v1\n", "First edit"],
            ["app.txt", "v2\n", "Second edit"],
          ],
          [["other.txt", "o\n", "Main edits elsewhere"]],
        ),
    ],
    [
      "main renamed a file you edit",
      (name) => {
        const repo = box.repo(name);
        box.commit(repo, "config.txt", "a\nb\nc\nd\n", "Base");
        box.git(repo, ["switch", "--quiet", "-c", "feature"]);
        box.commit(repo, "config.txt", "a\nB\nc\nd\n", "Edit config");
        box.git(repo, ["switch", "--quiet", "main"]);
        box.git(repo, ["mv", "config.txt", "settings.txt"]);
        box.git(repo, ["commit", "--quiet", "-m", "Rename config"]);
        box.git(repo, ["switch", "--quiet", "feature"]);
        return repo;
      },
    ],
    [
      "a commit already on main is skipped",
      (name) => {
        const repo = build(
          name,
          [
            ["fix.txt", "fix\n", "Fix"],
            ["more.txt", "m\n", "More"],
          ],
          [],
        );
        box.git(repo, ["switch", "--quiet", "main"]);
        // -x changes the message, so it's a different commit with the same patch.
        box.git(repo, ["cherry-pick", "-x", "feature~1"]);
        box.commit(repo, "z.txt", "z\n", "Main moves on");
        box.git(repo, ["switch", "--quiet", "feature"]);
        return repo;
      },
    ],
    [
      "main merged into the branch earlier",
      (name) => {
        const repo = build(
          name,
          [["x.txt", "x\n", "X"]],
          [["m1.txt", "m\n", "M1"]],
        );
        box.git(repo, ["merge", "--quiet", "--no-edit", "main"]);
        box.commit(repo, "y.txt", "y\n", "Y");
        box.git(repo, ["switch", "--quiet", "main"]);
        box.commit(repo, "m2.txt", "m\n", "M2");
        box.git(repo, ["switch", "--quiet", "feature"]);
        return repo;
      },
    ],
    [
      // 0 behind, but main was merged into the branch earlier. Git skips its
      // "already up to date" shortcut when your history has merges: it
      // flattens and replays your commits, and here step 1 conflicts.
      "0 behind with main merged in earlier",
      (name) => {
        const repo = build(
          name,
          [["app.txt", "mine\n", "My edit"]],
          [["app.txt", "theirs\n", "Main edit"]],
        );
        expect(() => box.git(repo, ["merge", "main"])).toThrow(); // conflict
        writeFileSync(path.join(repo, "app.txt"), "resolved\n");
        box.git(repo, ["add", "app.txt"]);
        box.git(repo, ["commit", "--quiet", "--no-edit"]);
        box.commit(repo, "more.txt", "m\n", "More work");
        return repo;
      },
    ],
    [
      "only main moved (fast-forward)",
      (name) => build(name, [], [["m.txt", "m\n", "M"]]),
    ],
    ["nothing new on main", (name) => build(name, [["x.txt", "x\n", "X"]], [])],
  ];

  for (const mode of ["batch", "one-by-one"] as const) {
    it.each(scenarios)(`${mode}: %s`, async (label, make) => {
      const repo = make(`${mode}-${label}`.replace(/\W+/g, "-"));
      const result = await forecast(repo, "main", mode);
      expect(result.rebase).toEqual(realRebase(box, repo, "main"));
      expect(result.ifStashed).toBeUndefined();
    });
  }

  const locals: [string, (repo: string) => void][] = [
    [
      "staged change",
      (r) => {
        write(r, "one.txt", "s\n");
        box.git(r, ["add", "one.txt"]);
      },
    ],
    ["unstaged change", (r) => write(r, "one.txt", "u\n")],
    [
      "untracked where main adds a file",
      (r) => write(r, "added.txt", "mine\n"),
    ],
    ["untracked elsewhere", (r) => write(r, "scratch.txt", "x\n")],
  ];
  for (const [shape, make] of [
    ["clean", cleanCase],
    ["conflicting", conflictAtTwo],
  ] as const) {
    it.each(locals)(`${shape} rebase + %s`, async (label, setup) => {
      const repo = make(`${shape}-${label}`.replace(/\W+/g, "-"));
      setup(repo);
      const result = await forecast(repo, "main");
      expect(result.rebase).toEqual(realRebase(box, repo, "main"));
      if (result.rebase.outcome === "refused") {
        expect(result.ifStashed).toEqual(
          realRebase(box, repo, "main", { autostash: true }),
        );
      } else {
        expect(result.ifStashed).toBeUndefined();
      }
    });
  }
});

describe("uncertain", () => {
  it("Git older than 2.40", async () => {
    const repo = box.repo("old-git");
    box.commit(repo, "a.txt", "a\n", "Base");
    box.git(repo, ["switch", "--quiet", "-c", "feature"]);
    box.commit(repo, "b.txt", "b\n", "Mine");
    const result = await readRebase({
      cwd: repo,
      base: "main",
      local: { staged: [], unstaged: [], untracked: [] },
      version: parseGitVersion("git version 2.39.5 (Apple Git-154)"),
    });
    expect(result.rebase).toMatchObject({
      outcome: "uncertain",
      reason: "git-too-old",
    });
  });

  it("a custom merge driver on a file the branch changes", async () => {
    const repo = box.repo("driver");
    writeFileSync(
      path.join(repo, ".gitattributes"),
      "data.json merge=jsonmerge\n",
    );
    box.commit(repo, "data.json", "{}\n", "Base");
    box.git(repo, ["add", "."]);
    box.git(repo, ["commit", "--quiet", "--amend", "--no-edit"]);
    box.git(repo, ["switch", "--quiet", "-c", "feature"]);
    box.commit(repo, "data.json", '{"a":1}\n', "Mine");
    box.git(repo, ["switch", "--quiet", "main"]);
    box.commit(repo, "data.json", '{"b":2}\n', "Theirs");
    box.git(repo, ["switch", "--quiet", "feature"]);
    expect((await forecast(repo, "main")).rebase).toMatchObject({
      outcome: "uncertain",
      reason: "custom-merge-driver",
    });
  });

  it("rerere on, with a conflict", async () => {
    const repo = box.repo("rerere");
    box.commit(repo, "a.txt", "base\n", "Base");
    box.git(repo, ["switch", "--quiet", "-c", "feature"]);
    box.commit(repo, "a.txt", "mine\n", "Mine");
    box.git(repo, ["switch", "--quiet", "main"]);
    box.commit(repo, "a.txt", "theirs\n", "Theirs");
    box.git(repo, ["switch", "--quiet", "feature"]);
    box.git(repo, ["config", "rerere.enabled", "true"]);
    expect((await forecast(repo, "main")).rebase).toMatchObject({
      outcome: "uncertain",
      reason: "rerere",
    });
  });
});
