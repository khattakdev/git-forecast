// repo.ts finds the branch, its upstream and the base to compare against.
// First against the shared fixture repos (answer key: fixtures/expected/),
// then against small repos for the awkward cases found by experiment.

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkBase, readRepo } from "./repo.js";
import { type Sandbox, sandbox } from "./test/repos.js";
import { ForecastError, type ForecastErrorCode } from "./types.js";

let box: Sandbox;
beforeAll(() => {
  box = sandbox("repo");
});
afterAll(() => box.remove());

async function errorCode(
  promise: Promise<unknown>,
): Promise<ForecastErrorCode> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ForecastError);
  return (error as ForecastError).code;
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
  const expectedDir = fileURLToPath(
    new URL("../../../fixtures/expected/", import.meta.url),
  );
  const builder = fileURLToPath(
    new URL("../../../fixtures/build.ts", import.meta.url),
  );
  const names = readdirSync(expectedDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
  let fixtures: string;

  beforeAll(() => {
    // Same builder CI runs; --check also confirms real Git still agrees.
    fixtures = path.join(box.root, "fixtures");
    execFileSync(process.execPath, [builder, "--check", "--out", fixtures], {
      stdio: "ignore",
    });
  }, 120_000);

  it.each(names)("%s: branch, base and upstream match", async (name) => {
    const expected = JSON.parse(
      readFileSync(path.join(expectedDir, `${name}.json`), "utf8"),
    );
    const info = await readRepo({ cwd: path.join(fixtures, name, "work") });
    expect(info.branch).toBe(expected.branch);
    expect(info.base).toBe(expected.base);
    expect(info.upstream?.name).toBe(expected.upstream?.name);
    if (expected.upstream) expect(info.upstream?.gone).toBe(false);
  });
});

describe("awkward cases", () => {
  /** origin.git with main + develop, and a clone of it called `name`. */
  function cloneSetup(name: string, cloneArgs: string[] = []): string {
    const origin = path.join(box.root, `${name}-origin.git`);
    const seed = box.repo(`${name}-seed`);
    box.commit(seed, "a.txt", "a\n", "First");
    box.git(box.root, ["init", "--quiet", "--bare", origin]);
    box.git(seed, ["push", "--quiet", origin, "main", "main:develop"]);
    const work = path.join(box.root, name);
    box.git(box.root, ["clone", "--quiet", ...cloneArgs, origin, work]);
    return work;
  }

  it("normal clone, on main", async () => {
    const work = cloneSetup("normal");
    expect(await readRepo({ cwd: work })).toEqual({
      branch: "main",
      base: "origin/main",
      baseFrom: "remote-head",
      upstream: { name: "origin/main", remote: "origin", gone: false },
    });
  });

  it("works from a subfolder", async () => {
    const work = cloneSetup("subfolder");
    const sub = path.join(work, "deep", "er");
    mkdirSync(sub, { recursive: true });
    expect((await readRepo({ cwd: sub })).branch).toBe("main");
  });

  it("new branch with no upstream; slash in the name", async () => {
    const work = cloneSetup("no-upstream");
    box.git(work, ["switch", "--quiet", "-c", "step-6/x"]);
    const info = await readRepo({ cwd: work });
    expect(info.branch).toBe("step-6/x");
    expect(info.upstream).toBeUndefined();
    expect(info.base).toBe("origin/main");
  });

  it("upstream deleted on the remote → gone", async () => {
    const work = cloneSetup("gone");
    box.git(work, ["switch", "--quiet", "-c", "feature"]);
    box.git(work, ["push", "--quiet", "-u", "origin", "feature"]);
    box.git(work, ["push", "--quiet", "origin", "--delete", "feature"]);
    box.git(work, ["fetch", "--quiet", "--prune"]);
    const info = await readRepo({ cwd: work });
    expect(info.upstream).toEqual({
      name: "origin/feature",
      remote: "origin",
      gone: true,
    });
  });

  it("follows origin/HEAD even when it isn't main", async () => {
    const work = cloneSetup("develop-head");
    box.git(work, ["remote", "set-head", "origin", "develop"]);
    const info = await readRepo({ cwd: work });
    expect(info).toMatchObject({
      base: "origin/develop",
      baseFrom: "remote-head",
    });
  });

  it("no origin/HEAD → falls back to origin/main", async () => {
    const work = cloneSetup("no-head");
    box.git(work, ["remote", "set-head", "origin", "--delete"]);
    const info = await readRepo({ cwd: work });
    expect(info).toMatchObject({ base: "origin/main", baseFrom: "fallback" });
  });

  it("remote not called origin", async () => {
    const work = cloneSetup("other-remote", ["--origin", "upstream"]);
    const info = await readRepo({ cwd: work });
    expect(info.base).toBe("upstream/main");
    expect(info.upstream?.remote).toBe("upstream");
  });

  it("several remotes, no upstream → prefers origin", async () => {
    const work = cloneSetup("two-remotes");
    // A second remote pointing at this test's own bare repo. (It once reused
    // another test's repo, so it failed when run alone with -t.)
    const ownOrigin = path.join(box.root, "two-remotes-origin.git");
    box.git(work, ["remote", "add", "aaa", ownOrigin]);
    box.git(work, ["fetch", "--quiet", "aaa"]);
    box.git(work, ["switch", "--quiet", "-c", "feature"]);
    expect((await readRepo({ cwd: work })).base).toBe("origin/main");
  });

  it("branch tracking a local branch → base still from a remote", async () => {
    const work = cloneSetup("local-track");
    box.git(work, ["switch", "--quiet", "-c", "child", "--track", "main"]);
    const info = await readRepo({ cwd: work });
    expect(info.upstream).toEqual({ name: "main", remote: ".", gone: false });
    expect(info.base).toBe("origin/main");
  });

  describe("--base", () => {
    it("uses a valid base as given", async () => {
      const work = cloneSetup("base-flag");
      const info = await readRepo({ cwd: work, base: "origin/develop" });
      expect(info).toMatchObject({ base: "origin/develop", baseFrom: "flag" });
    });

    it("unknown base → no-base-branch", async () => {
      const work = cloneSetup("base-bad");
      expect(await errorCode(readRepo({ cwd: work, base: "nope" }))).toBe(
        "no-base-branch",
      );
    });

    it("a base that looks like an option is a name, not a flag", async () => {
      const work = cloneSetup("base-option");
      expect(
        await errorCode(readRepo({ cwd: work, base: "--output=pwned" })),
      ).toBe("no-base-branch");
    });

    it("an option-like base never reaches Git", async () => {
      // In a missing folder, running Git gives git-failed. no-base-branch
      // proves we refused before running Git at all.
      const missing = path.join(box.root, "missing");
      expect(await errorCode(checkBase("--output=pwned", missing))).toBe(
        "no-base-branch",
      );
      expect(await errorCode(checkBase("main", missing))).toBe("git-failed");
    });
  });

  describe("errors", () => {
    it("detached HEAD → detached-head", async () => {
      const work = cloneSetup("detached");
      box.git(work, ["switch", "--quiet", "--detach"]);
      expect(await errorCode(readRepo({ cwd: work }))).toBe("detached-head");
    });

    it("mid-rebase → detached-head that names the rebase", async () => {
      const work = cloneSetup("mid-rebase");
      box.git(work, ["switch", "--quiet", "-c", "f2"]);
      box.commit(work, "a.txt", "f2\n", "F2 edit");
      box.git(work, ["switch", "--quiet", "main"]);
      box.commit(work, "a.txt", "main\n", "Main edit");
      box.git(work, ["switch", "--quiet", "f2"]);
      expect(() => box.git(work, ["rebase", "main"])).toThrow(); // conflict
      const error = await errorOf(readRepo({ cwd: work }));
      expect(error.code).toBe("detached-head");
      expect(error.message).toMatch(/rebase/);
      expect(error.message).toMatch(/f2/);
    });

    it("no commits yet → no-commits", async () => {
      const repo = box.repo("unborn");
      expect(await errorCode(readRepo({ cwd: repo }))).toBe("no-commits");
    });

    it("no remotes → no-base-branch", async () => {
      const repo = box.repo("local-only");
      box.commit(repo, "a.txt", "a\n", "First");
      const error = await errorOf(readRepo({ cwd: repo }));
      expect(error.code).toBe("no-base-branch");
      expect(error.message).toMatch(/--base/);
    });
  });
});
