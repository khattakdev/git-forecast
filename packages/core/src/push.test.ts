// push.ts: force push needed after a merge or rebase? Judged by running the
// real merge/rebase on a copy and then a real `git push --dry-run`.

import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readPush, withMergePush, withRebasePush } from "./push.js";
import { readRepo } from "./repo.js";
import { readStatus } from "./status.js";
import { expected, fixtureWork } from "./test/fixtures.js";
import { realPush } from "./test/judge.js";
import { type Sandbox, sandbox } from "./test/repos.js";

let box: Sandbox;
beforeAll(() => {
  box = sandbox("push");
});
afterAll(() => box.remove());

async function facts(cwd: string) {
  const repo = await readRepo({ cwd });
  const status = await readStatus({ cwd, repo });
  return readPush({
    cwd,
    base: repo.base,
    upstream: status.upstream,
    behind: status.behind,
  });
}

describe("fixture repos", () => {
  it("pushed-branch: rebase rewrites 2 pushed commits; merge needs no force", async () => {
    const push = await facts(fixtureWork("pushed-branch"));
    const want = expected("pushed-branch");
    expect(withRebasePush({ outcome: "clean", totalSteps: 3 }, push)).toEqual(
      want.rebase,
    );
    expect(withMergePush({ outcome: "clean" }, push)).toEqual(want.merge);
  });

  it("messy-local: the --autostash outcomes carry the push facts too", async () => {
    const push = await facts(fixtureWork("messy-local"));
    const want = expected("messy-local").ifStashed;
    expect(withRebasePush({ outcome: "clean", totalSteps: 2 }, push)).toEqual(
      want.rebase,
    );
    expect(withMergePush({ outcome: "clean" }, push)).toEqual(want.merge);
  });

  it("no upstream → no push facts", async () => {
    expect(await facts(fixtureWork("clean"))).toBeUndefined();
  });
});

describe("hand-made repos vs real git push", () => {
  /** origin with main; `work` on feature, pushed with `pushed` commits. */
  function setup(
    name: string,
    opts: {
      pushed: number;
      local: number;
      mainMoves: boolean;
      teammate?: boolean;
      upstreamToMain?: boolean;
    },
  ) {
    const origin = path.join(box.root, `${name}.git`);
    const seed = box.repo(`${name}-seed`);
    box.commit(seed, "a.txt", "a\n", "Base");
    box.git(box.root, ["init", "--quiet", "--bare", origin]);
    box.git(seed, ["push", "--quiet", origin, "main"]);
    const work = path.join(box.root, name);
    box.git(box.root, ["clone", "--quiet", origin, work]);
    box.git(work, ["switch", "--quiet", "-c", "feature"]);
    for (let i = 1; i <= opts.pushed; i++)
      box.commit(work, `p${i}.txt`, `${i}\n`, `Pushed ${i}`);
    box.git(work, ["push", "--quiet", "-u", "origin", "feature"]);
    for (let i = 1; i <= opts.local; i++)
      box.commit(work, `l${i}.txt`, `${i}\n`, `Local ${i}`);
    if (opts.teammate) {
      const mate = path.join(box.root, `${name}-mate`);
      box.git(box.root, [
        "clone",
        "--quiet",
        "--branch",
        "feature",
        origin,
        mate,
      ]);
      box.commit(mate, "mate.txt", "m\n", "Teammate");
      box.git(mate, ["push", "--quiet"]);
    }
    if (opts.mainMoves) {
      box.commit(seed, "m.txt", "m\n", "Main moves");
      box.git(seed, ["push", "--quiet", origin, "main"]);
    }
    if (opts.upstreamToMain) {
      // Someone moved your remote branch to main's tip (nothing of their own).
      box.git(seed, ["push", "--quiet", "--force", origin, "main:feature"]);
    }
    box.git(work, ["fetch", "--quiet"]);
    return work;
  }

  const cases = {
    "pushed 2, 1 local, main moved": { pushed: 2, local: 1, mainMoves: true },
    "pushed nothing of your own yet": { pushed: 0, local: 2, mainMoves: true },
    "a teammate pushed to your branch": {
      pushed: 1,
      local: 0,
      mainMoves: true,
      teammate: true,
    },
    "main didn't move, a teammate pushed": {
      pushed: 1,
      local: 0,
      mainMoves: false,
      teammate: true,
    },
    "main didn't move, all pushed": { pushed: 2, local: 0, mainMoves: false },
    "your remote branch was moved to main's tip": {
      pushed: 0,
      local: 1,
      mainMoves: true,
      upstreamToMain: true,
    },
  };

  it.each(Object.entries(cases))("%s", async (label, opts) => {
    const work = setup(label.replace(/\W+/g, "-"), opts);
    const push = await facts(work);
    const base = "origin/main";
    const rebase = realPush(box, work, base, "rebase");
    const merge = realPush(box, work, base, "merge");
    expect(rebase).toBeDefined();
    expect(merge).toBeDefined();
    expect(push).toMatchObject({
      rewritesPushedCommits: rebase?.rewrites,
      rebaseNeedsForcePush: rebase?.needsForcePush,
      mergeNeedsForcePush: merge?.needsForcePush,
    });
  });

  it("gone upstream → no push facts", async () => {
    const work = setup("gone", { pushed: 1, local: 0, mainMoves: false });
    box.git(work, ["push", "--quiet", "origin", "--delete", "feature"]);
    box.git(work, ["fetch", "--quiet", "--prune"]);
    expect(await facts(work)).toBeUndefined();
  });
});
