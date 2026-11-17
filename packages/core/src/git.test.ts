// git.ts is the engine's only way to run Git. These tests build tiny repos in
// a temp folder with their own isolated Git calls (not git.ts), so a bug in
// git.ts can't hide itself by also breaking the setup.

import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  gitOutput,
  gitVersion,
  isAtLeast,
  parseGitVersion,
  runGit,
} from "./git.js";
import { type Sandbox, sandbox } from "./test/repos.js";
import { ForecastError } from "./types.js";

let box: Sandbox;
let tmp: string;

beforeAll(() => {
  box = sandbox("gitts");
  tmp = box.root;
});
afterAll(() => box.remove());

const setup = (cwd: string, args: string[]) => box.git(cwd, args);
const newRepo = (name: string) => box.repo(name);
const commitFile = (repo: string, file: string, text: string, msg: string) =>
  box.commit(repo, file, text, msg);

async function forecastError(
  promise: Promise<unknown>,
): Promise<ForecastError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ForecastError);
  return error as ForecastError;
}

describe("parseGitVersion", () => {
  it.each([
    ["git version 2.56.0", { major: 2, minor: 56, patch: 0 }],
    ["git version 2.45.1.windows.1", { major: 2, minor: 45, patch: 1 }],
    ["git version 2.39.5 (Apple Git-154)", { major: 2, minor: 39, patch: 5 }],
    ["git version 2.40.0\n", { major: 2, minor: 40, patch: 0 }],
  ])("reads %j", (raw, expected) => {
    expect(parseGitVersion(raw)).toMatchObject(expected);
  });

  it("returns null for text it doesn't recognise", () => {
    expect(parseGitVersion("hello")).toBeNull();
    expect(parseGitVersion("")).toBeNull();
  });

  it("compares versions", () => {
    const apple = parseGitVersion("git version 2.39.5 (Apple Git-154)");
    const modern = parseGitVersion("git version 2.40.0");
    const three = parseGitVersion("git version 3.0.0");
    expect(apple && isAtLeast(apple, 2, 40)).toBe(false);
    expect(modern && isAtLeast(modern, 2, 40)).toBe(true);
    expect(three && isAtLeast(three, 2, 40)).toBe(true);
  });
});

describe("gitVersion", () => {
  it("reads the installed Git's version", async () => {
    const version = await gitVersion();
    expect(version?.major).toBeGreaterThanOrEqual(2);
  });
});

describe("runGit", () => {
  it("returns stdout and exit code", async () => {
    const repo = newRepo("basic");
    commitFile(repo, "a.txt", "one\n", "First commit");
    const result = await runGit(["log", "-1", "--format=%s"], { cwd: repo });
    expect(result).toMatchObject({ exitCode: 0, stdout: "First commit\n" });
    expect(await gitOutput(["log", "-1", "--format=%s"], { cwd: repo })).toBe(
      "First commit",
    );
  });

  it("not a repo → not-a-git-repo", async () => {
    const dir = mkdtempSync(path.join(tmp, "plain-"));
    // GIT_CEILING_DIRECTORIES stops Git searching above tmp, in case the
    // system temp folder sits inside some repo.
    const prev = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = tmp;
    try {
      const error = await forecastError(runGit(["rev-parse"], { cwd: dir }));
      expect(error.code).toBe("not-a-git-repo");
    } finally {
      if (prev === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = prev;
    }
  });

  it("Git missing → git-not-found", async () => {
    const error = await forecastError(
      runGit(["--version"], {
        cwd: tmp,
        gitBinary: "git-forecast-no-such-git",
      }),
    );
    expect(error.code).toBe("git-not-found");
  });

  it("missing folder is not mistaken for missing Git", async () => {
    const error = await forecastError(
      runGit(["--version"], { cwd: path.join(tmp, "does-not-exist") }),
    );
    expect(error.code).toBe("git-failed");
    expect(error.message).toMatch(/does-not-exist/);
  });

  describe("exit codes", () => {
    let repo: string;
    beforeAll(() => {
      repo = newRepo("conflict");
      commitFile(repo, "a.txt", "base\n", "Base");
      setup(repo, ["switch", "--quiet", "-c", "feature"]);
      commitFile(repo, "a.txt", "feature\n", "Feature edit");
      setup(repo, ["switch", "--quiet", "main"]);
      commitFile(repo, "a.txt", "main\n", "Main edit");
    });
    const mergeTree = ["merge-tree", "--write-tree", "--name-only"];

    it("an allowed non-zero code is an answer, not an error", async () => {
      const result = await runGit([...mergeTree, "main", "feature"], {
        cwd: repo,
        okExitCodes: [0, 1],
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toMatch(/^a\.txt$/m);
    });

    it("a code the caller didn't allow → git-failed with details", async () => {
      const error = await forecastError(
        runGit([...mergeTree, "main", "feature"], { cwd: repo }),
      );
      expect(error.code).toBe("git-failed");
      expect(error.message).toMatch(/merge-tree/);
      expect(error.message).toMatch(/exit code 1/);
    });

    it("128 from a bad command → git-failed", async () => {
      const error = await forecastError(
        runGit(["rev-parse", "--verify", "no-such-branch"], { cwd: repo }),
      );
      expect(error.code).toBe("git-failed");
    });
  });

  it("sends input to Git's standard input", async () => {
    const repo = newRepo("stdin");
    const { stdout } = await runGit(["hash-object", "--stdin"], {
      cwd: repo,
      input: "hello\n",
    });
    // Same ID as `echo hello | git hash-object --stdin`.
    expect(stdout.trim()).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("closes stdin when there is no input, so --stdin can't hang", async () => {
    const repo = newRepo("stdin-empty");
    const { stdout } = await runGit(["hash-object", "--stdin"], {
      cwd: repo,
      timeoutMs: 5_000,
    });
    expect(stdout.trim()).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"); // empty
  });

  it("ignores display settings that would break parsing", async () => {
    const repo = newRepo("display");
    setup(repo, ["config", "color.ui", "always"]);
    setup(repo, ["config", "core.quotePath", "true"]);
    commitFile(repo, "a.txt", "x\n", "Colourful");
    writeFileSync(path.join(repo, "héllo.txt"), "x\n");

    const log = await gitOutput(["log", "-1", "--oneline"], { cwd: repo });
    expect(log).not.toContain("\u001b[");
    const status = await gitOutput(["status", "--porcelain"], { cwd: repo });
    expect(status).toBe("?? héllo.txt");
  });
});
