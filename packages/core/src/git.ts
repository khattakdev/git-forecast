// The engine's only way to run Git. Every other module asks through here, so
// the safety rules live in one place:
//
// - execFile, not a shell: arguments go to Git as-is, never re-parsed, and it
//   behaves the same on Windows.
// - GIT_OPTIONAL_LOCKS=0: `git status` won't refresh the index (which takes a
//   lock and writes a file). Keeps checks read-only.
// - LC_ALL=C: messages in English everywhere, so we can recognise them.
// - GIT_TERMINAL_PROMPT=0: never wait for a password nobody will type.
// - `-c color.ui=false -c core.quotePath=false`: the user's config is kept
//   (it changes what a real merge does, so the forecast must see it), except
//   these two, which only change how output looks and would break parsing.

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { ForecastError } from "./types.js";

export interface RunGitOptions {
  /** Folder to run in, usually somewhere inside the repo. */
  cwd: string;
  /** Exit codes that are answers, not failures. Default `[0]`. */
  okExitCodes?: readonly number[];
  /** Kill Git after this long. Default 30 s. */
  timeoutMs?: number;
  /** For tests: the program to run instead of `git`. */
  gitBinary?: string;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DISPLAY_OVERRIDES = [
  "-c",
  "color.ui=false",
  "-c",
  "core.quotePath=false",
];
const MAX_OUTPUT = 64 * 1024 * 1024; // Node's default is 1 MiB; big logs exceed it.
const DEFAULT_TIMEOUT_MS = 30_000;

function commandText(args: readonly string[]): string {
  return `git ${args.join(" ")}`;
}

async function folderExists(dir: string): Promise<boolean> {
  return stat(dir).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

/**
 * Runs Git and returns its output. Throws ForecastError when Git can't run,
 * the folder isn't a repo, or the exit code isn't one of `okExitCodes`.
 */
export async function runGit(
  args: readonly string[],
  options: RunGitOptions,
): Promise<GitResult> {
  const {
    cwd,
    okExitCodes = [0],
    timeoutMs = DEFAULT_TIMEOUT_MS,
    gitBinary = "git",
  } = options;
  const command = commandText(args);

  const result = await new Promise<GitResult | NodeJS.ErrnoException>(
    (resolve) => {
      execFile(
        gitBinary,
        [...DISPLAY_OVERRIDES, ...args],
        {
          cwd,
          encoding: "utf8",
          maxBuffer: MAX_OUTPUT,
          timeout: timeoutMs,
          windowsHide: true,
          env: {
            ...process.env,
            GIT_OPTIONAL_LOCKS: "0",
            GIT_TERMINAL_PROMPT: "0",
            LC_ALL: "C",
          },
        },
        (error, stdout, stderr) => {
          if (!error) return resolve({ stdout, stderr, exitCode: 0 });
          // A number means Git ran and exited non-zero: that's an answer.
          if (typeof error.code === "number") {
            return resolve({ stdout, stderr, exitCode: error.code });
          }
          // Anything else means Git didn't run or didn't finish.
          resolve(Object.assign(error, { stderr }));
        },
      );
    },
  );

  if (result instanceof Error) {
    if (result.code === "ENOENT") {
      // Node says "spawn git ENOENT" both when Git is missing and when `cwd`
      // doesn't exist. Tell the two apart, or we'd send people to reinstall Git.
      if (!(await folderExists(cwd))) {
        throw new ForecastError(
          "git-failed",
          `${command}: folder not found: ${cwd}`,
          { cause: result },
        );
      }
      throw new ForecastError(
        "git-not-found",
        `Couldn't run ${gitBinary}. Is Git installed and on your PATH?`,
        { cause: result },
      );
    }
    const why =
      result.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        ? "output too large"
        : (result as { killed?: boolean }).killed
          ? `timed out after ${timeoutMs} ms`
          : result.message;
    throw new ForecastError("git-failed", `${command}: ${why}`, {
      cause: result,
    });
  }

  if (!okExitCodes.includes(result.exitCode)) {
    if (
      result.exitCode === 128 &&
      result.stderr.includes("not a git repository")
    ) {
      throw new ForecastError(
        "not-a-git-repo",
        `Not inside a Git repository: ${cwd}`,
      );
    }
    const detail = result.stderr.trim();
    throw new ForecastError(
      "git-failed",
      `${command} failed with exit code ${result.exitCode}${detail ? `: ${detail}` : ""}`,
    );
  }
  return result;
}

/** Shortcut: run Git, expect exit code 0, return stdout without the trailing newline. */
export async function gitOutput(
  args: readonly string[],
  options: Omit<RunGitOptions, "okExitCodes">,
): Promise<string> {
  const { stdout } = await runGit(args, options);
  return stdout.replace(/\r?\n$/, "");
}

// ---------------------------------------------------------------------------
// Version

export interface GitVersion {
  major: number;
  minor: number;
  patch: number;
  /** As Git printed it, e.g. "git version 2.39.5 (Apple Git-154)". */
  raw: string;
}

/** Reads `git --version` output. Null when it doesn't look like a version. */
export function parseGitVersion(raw: string): GitVersion | null {
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(raw.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
    raw: raw.trim(),
  };
}

export function isAtLeast(
  version: GitVersion,
  major: number,
  minor: number,
): boolean {
  return (
    version.major > major || (version.major === major && version.minor >= minor)
  );
}

let cachedVersion: Promise<GitVersion | null> | undefined;

/**
 * The installed Git's version, asked once per process. Null when the output
 * isn't recognised, so callers say "uncertain" instead of guessing.
 */
export function gitVersion(): Promise<GitVersion | null> {
  cachedVersion ??= gitOutput(["--version"], { cwd: process.cwd() }).then(
    parseGitVersion,
  );
  return cachedVersion;
}
