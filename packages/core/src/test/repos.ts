// Test-only helpers for building small practice repos. Setup runs its own Git
// (not git.ts) with user and system config ignored, so commits always work
// and a bug in git.ts can't also break the setup and hide itself.
// Excluded from the published build (tsconfig.build.json).

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Sandbox {
  root: string;
  /** Runs setup Git in `cwd`; returns stdout. Throws on a non-zero exit. */
  git(cwd: string, args: string[]): string;
  /** Like `git`, but returns the exit code instead of throwing. */
  run(
    cwd: string,
    args: string[],
  ): { code: number; stdout: string; stderr: string };
  /** The environment setup Git runs with (user and system config ignored). */
  env: NodeJS.ProcessEnv;
  /** `git init` a new repo at root/name, with `main` as the first branch. */
  repo(name: string): string;
  /** Writes `file`, stages it and commits with `message`. */
  commit(repo: string, file: string, text: string, message: string): void;
  remove(): void;
}

export function sandbox(prefix: string): Sandbox {
  const root = mkdtempSync(path.join(os.tmpdir(), `git-forecast-${prefix}-`));
  const emptyConfig = path.join(root, ".empty-gitconfig");
  writeFileSync(emptyConfig, "");
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_EDITOR: "true",
  };
  const config = [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "init.defaultBranch=main",
  ];

  const git = (cwd: string, args: string[]) =>
    execFileSync("git", [...config, ...args], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

  const run = (cwd: string, args: string[]) => {
    const r = spawnSync("git", [...config, ...args], {
      cwd,
      env,
      encoding: "utf8",
    });
    return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
  };

  return {
    root,
    git,
    run,
    env,
    repo(name) {
      const dir = path.join(root, name);
      git(root, ["init", "--quiet", dir]);
      return dir;
    },
    commit(repo, file, text, message) {
      writeFileSync(path.join(repo, file), text);
      git(repo, ["add", file]);
      git(repo, ["commit", "--quiet", "-m", message]);
    },
    remove() {
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
