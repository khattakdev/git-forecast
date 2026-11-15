// Git for the fixture scripts, isolated from whoever runs them.
//
// Not packages/core/src/git.ts on purpose: this is dev tooling, it must not
// depend on the code it is testing, and it needs extra isolation (no user or
// system config) that the engine must not have.

import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Drop inherited GIT_* variables (GIT_DIR, GIT_INDEX_FILE, ... set by hooks),
// then ignore user and system config so settings like rerere, rebase.autoStash,
// rebase.updateRefs or core.autocrlf can't change the outcome.
const baseEnv: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.toUpperCase().startsWith("GIT_"),
  ),
);
export const gitConfig: Record<string, string> = {
  "user.name": "Fixture Author",
  "user.email": "fixture@example.com",
  "init.defaultBranch": "main",
  "core.autocrlf": "false",
  "commit.gpgsign": "false",
  "merge.conflictStyle": "merge",
};
export const ENV: NodeJS.ProcessEnv = {
  ...baseEnv,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_COUNT: String(Object.keys(gitConfig).length),
  ...Object.fromEntries(
    Object.entries(gitConfig).flatMap(([key, value], i) => [
      [`GIT_CONFIG_KEY_${i}`, key],
      [`GIT_CONFIG_VALUE_${i}`, value],
    ]),
  ),
  GIT_EDITOR: "true",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
};

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs Git and returns its exit code instead of throwing on non-zero. */
export async function run(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      env: { ...ENV, ...env },
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code !== "number") throw error; // git missing, bad cwd, ...
    return { code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** Runs Git, throws on non-zero, returns trimmed stdout. */
export async function git(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await run(cwd, args, env);
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} exited ${result.code} in ${cwd}\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

/** Fixed, increasing timestamps so every build produces the same commits. */
export function makeClock(): () => NodeJS.ProcessEnv {
  let tick = 0;
  return () => {
    const date = `${1767225600 + tick++ * 60} +0000`; // 2026-01-01T00:00:00Z + n minutes
    return { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  };
}
