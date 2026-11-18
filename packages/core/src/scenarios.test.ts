// Real-world shapes beyond the fixtures, found by a real-Git comparison run
// on Nov 17: renames, deletes, add/add, binary files, file vs folder, mode
// changes, PRs merged with a merge commit, long branches. Each one runs the
// whole engine (forecastSync) and compares it with the REAL git merge and
// git rebase on copies of the same repo.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forecastSync } from "./forecast.js";
import { readRebase } from "./rebase.js";
import { realMerge, realRebase } from "./test/judge.js";
import { type Sandbox, sandbox } from "./test/repos.js";

let box: Sandbox;
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  box = sandbox("scenarios");
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

let built = 0;

/** file → content, or null to delete it. */
type Files = Record<string, string | null>;

function apply(repo: string, files: Files, message: string): void {
  for (const [file, text] of Object.entries(files)) {
    if (text === null) {
      box.git(repo, ["rm", "--quiet", file]);
    } else {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      writeFileSync(path.join(repo, file), text);
      box.git(repo, ["add", file]);
    }
  }
  box.git(repo, ["commit", "--quiet", "--allow-empty", "-m", message]);
}

/** A repo on `feature` (branched after `base`), with `main` moved by `theirs`. */
function build(
  name: string,
  base: Files,
  mine: [Files, string][],
  theirs: [Files, string][],
): string {
  const repo = box.repo(`${name}-${++built}`); // unique: a scenario may be built twice
  apply(repo, base, "Base");
  box.git(repo, ["switch", "--quiet", "-c", "feature"]);
  for (const [files, message] of mine) apply(repo, files, message);
  box.git(repo, ["switch", "--quiet", "main"]);
  for (const [files, message] of theirs) apply(repo, files, message);
  box.git(repo, ["switch", "--quiet", "feature"]);
  expect(box.git(repo, ["status", "--porcelain"])).toBe("");
  return repo;
}

const lines = (n: number, tag: string) =>
  `${Array.from({ length: n }, (_, i) => `${tag}${i}`).join("\n")}\n`;
const app = "a\nb\nc\nd\ne\n";

const scenarios: [string, () => string][] = [
  [
    "different lines of the same file",
    () =>
      build(
        "lines",
        { "app.txt": app },
        [[{ "app.txt": "A\nb\nc\nd\ne\n" }, "Mine"]],
        [[{ "app.txt": "a\nb\nc\nd\nE\n" }, "Theirs"]],
      ),
  ],
  [
    "main renames a file you edit",
    () =>
      build(
        "rename",
        { "config.txt": lines(20, "c") },
        [
          [
            { "config.txt": lines(20, "c").replace("c3", "MINE") },
            "Edit config",
          ],
        ],
        [
          [
            { "config.txt": null, "src/settings.txt": lines(20, "c") },
            "Move config",
          ],
        ],
      ),
  ],
  [
    "main deletes a file you edit",
    () =>
      build(
        "delete",
        { "app.txt": app },
        [[{ "app.txt": "a\nb\nMINE\nd\ne\n" }, "Edit app"]],
        [[{ "app.txt": null }, "Delete app"]],
      ),
  ],
  [
    "both sides add the same file",
    () =>
      build(
        "add-add",
        { "app.txt": app },
        [[{ "new.txt": "mine\n" }, "Add new"]],
        [[{ "new.txt": "theirs\n" }, "Add new too"]],
      ),
  ],
  [
    "a binary file changed on both sides",
    () =>
      build(
        "binary",
        { "logo.bin": "\0\u0001base" },
        [[{ "logo.bin": "\0\u0001mine" }, "Mine"]],
        [[{ "logo.bin": "\0\u0001theirs" }, "Theirs"]],
      ),
  ],
  [
    "your file vs main's folder of the same name",
    () =>
      build(
        "file-vs-dir",
        { "app.txt": app },
        [[{ thing: "file\n" }, "Add thing file"]],
        [[{ "thing/inner.txt": "dir\n" }, "Add thing dir"]],
      ),
  ],
  [
    "your folder vs main's file of the same name",
    () =>
      build(
        "dir-vs-file",
        { "app.txt": app },
        [[{ "thing/inner.txt": "dir\n" }, "Add thing dir"]],
        [[{ thing: "file\n" }, "Add thing file"]],
      ),
  ],
  [
    "a long branch that conflicts at step 17 of 30",
    () =>
      build(
        "long",
        {
          "app.txt": "a\nb\nc\n",
          ...Object.fromEntries(
            Array.from({ length: 30 }, (_, i) => [`f${i}.txt`, "0\n"]),
          ),
        },
        Array.from({ length: 30 }, (_, i): [Files, string] => [
          i === 16 ? { "app.txt": "a\nMINE\nc\n" } : { [`f${i}.txt`]: "1\n" },
          `Step ${i + 1}`,
        ]),
        [[{ "app.txt": "a\nTHEIRS\nc\n" }, "Theirs"]],
      ),
  ],
  [
    "main makes a file executable that you edit",
    () => {
      const repo = build(
        "mode",
        { "run.sh": "echo hi\n" },
        [[{ "run.sh": "echo mine\n" }, "Mine"]],
        [],
      );
      box.git(repo, ["switch", "--quiet", "main"]);
      // The index stores the mode, so this works on Windows too.
      box.git(repo, ["update-index", "--chmod=+x", "run.sh"]);
      box.git(repo, ["commit", "--quiet", "-m", "Make run.sh executable"]);
      // --chmod changed only the index; make the folder match before switching.
      box.git(repo, ["reset", "--quiet", "--hard"]);
      box.git(repo, ["switch", "--quiet", "feature"]);
      return repo;
    },
  ],
  [
    "a PR merged on main with a merge commit",
    () => {
      const repo = build(
        "pr-merge",
        { "app.txt": app },
        [[{ "m.txt": "m\n" }, "Mine"]],
        [],
      );
      box.git(repo, ["switch", "--quiet", "-c", "pr", "main"]);
      apply(repo, { "p1.txt": "1\n" }, "PR 1");
      apply(repo, { "app.txt": "a\nb\nPR\nd\ne\n" }, "PR 2");
      box.git(repo, ["switch", "--quiet", "main"]);
      box.git(repo, [
        "merge",
        "--quiet",
        "--no-ff",
        "pr",
        "-m",
        "Merge pull request #7 from x/pr",
      ]);
      box.git(repo, ["switch", "--quiet", "feature"]);
      return repo;
    },
  ],
];

describe("forecastSync vs real git merge and git rebase", () => {
  it.each(scenarios)("%s", async (label, make) => {
    const repo = make();
    const sync = await forecastSync({ cwd: repo, base: "main" });
    expect(sync.merge, "merge").toEqual(realMerge(box, repo, "main"));
    expect(sync.rebase, "rebase").toEqual(realRebase(box, repo, "main"));
  });

  it.each(["your file vs main's folder", "your folder vs main's file"])(
    "%s: the one-process-per-step fallback names files the same way",
    async (start) => {
      const repo =
        scenarios.find(([label]) => label.startsWith(start))?.[1]() ?? "";
      const rebase = await readRebase({
        cwd: repo,
        base: "main",
        local: { staged: [], unstaged: [], untracked: [] },
        mode: "one-by-one",
      });
      expect(rebase.rebase).toEqual(realRebase(box, repo, "main"));
    },
  );

  it("the merge-commit PR is one incoming entry with all its files and its number", async () => {
    const repo = scenarios.find(([label]) =>
      label.startsWith("a PR merged"),
    )?.[1]();
    const sync = await forecastSync({ cwd: repo ?? "", base: "main" });
    expect(sync.status.incoming.map(({ sha, ...rest }) => rest)).toEqual([
      {
        subject: "Merge pull request #7 from x/pr",
        pr: 7,
        files: [
          { status: "M", path: "app.txt" },
          { status: "A", path: "p1.txt" },
        ],
      },
    ]);
  });
});
