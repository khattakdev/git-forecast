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

import { type ExecException, execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { ForecastError } from "./types.js";

export interface RunGitOptions {
  /** Folder to run in, usually somewhere inside the repo. */
  cwd: string;
  /** Exit codes that are answers, not failures. Default `[0]`. */
  okExitCodes?: readonly number[];
  /** Kill Git after this long. Default 30 s. */
  timeoutMs?: number;
  /** Sent to Git's standard input (for `--stdin` commands). Use it instead
   *  of long argument lists, which Windows caps at about 32,000 characters. */
  input?: string;
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

/** The environment every Git call gets (see the top of this file). */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

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
    input,
  } = options;
  const command = commandText(args);

  // Either Git ran to the end (any exit code), or it didn't run/finish.
  // Tagged so TypeScript can tell the two apart without casts.
  type Outcome =
    | { ran: true; result: GitResult }
    | { ran: false; error: ExecException };

  const outcome = await new Promise<Outcome>((resolve) => {
    const child = execFile(
      gitBinary,
      [...DISPLAY_OVERRIDES, ...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT,
        timeout: timeoutMs,
        windowsHide: true,
        env: gitEnv(),
      },
      (error, stdout, stderr) => {
        if (!error) {
          return resolve({
            ran: true,
            result: { stdout, stderr, exitCode: 0 },
          });
        }
        // A number means Git ran and exited non-zero: that's an answer.
        if (typeof error.code === "number") {
          return resolve({
            ran: true,
            result: { stdout, stderr, exitCode: error.code },
          });
        }
        // Anything else means Git didn't run or didn't finish.
        resolve({ ran: false, error });
      },
    );
    // Always close stdin, so a command that reads it can't wait forever. If
    // Git exits before reading everything, writing fails with EPIPE; the exit
    // code above is the real answer, so that write error is ignored.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });

  if (!outcome.ran) {
    const { error } = outcome;
    if (error.code === "ENOENT") {
      // Node says "spawn git ENOENT" both when Git is missing and when `cwd`
      // doesn't exist. Tell the two apart, or we'd send people to reinstall Git.
      if (!(await folderExists(cwd))) {
        throw new ForecastError(
          "git-failed",
          `${command}: folder not found: ${cwd}`,
          { cause: error },
        );
      }
      throw new ForecastError(
        "git-not-found",
        `Couldn't run ${gitBinary}. Is Git installed and on your PATH?`,
        { cause: error },
      );
    }
    const why =
      error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        ? "output too large"
        : error.killed
          ? `timed out after ${timeoutMs} ms`
          : error.message;
    throw new ForecastError("git-failed", `${command}: ${why}`, {
      cause: error,
    });
  }

  const { result } = outcome;

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

/**
 * A Git process that stays open: write a line, read its answer, repeat.
 * For batch commands like `merge-tree --stdin`, where each question depends
 * on the previous answer, so all input can't be sent up front. Saves a
 * process start (~5 ms) per question.
 */
export interface GitProcess {
  /**
   * Sends `line` and resolves with the answer once `recordEnd(output)` finds
   * where it ends (an index into the output so far), or rejects if Git exits.
   */
  ask(line: string, recordEnd: (output: string) => number): Promise<string>;
  /** Closes stdin and waits for Git to exit. */
  close(): Promise<void>;
}

export function openGit(
  args: readonly string[],
  options: Pick<RunGitOptions, "cwd" | "gitBinary">,
): GitProcess {
  const { cwd, gitBinary = "git" } = options;
  const command = commandText(args);
  const child = spawn(gitBinary, [...DISPLAY_OVERRIDES, ...args], {
    cwd,
    windowsHide: true,
    env: gitEnv(),
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdin.on("error", () => {}); // EPIPE after an early exit; see exit below

  let output = "";
  let stderr = "";
  let waiting:
    | {
        recordEnd: (o: string) => number;
        resolve: (s: string) => void;
        reject: (e: Error) => void;
      }
    | undefined;
  let failure: Error | undefined;

  const settle = () => {
    if (!waiting) return;
    const end = waiting.recordEnd(output);
    if (end < 0) return;
    const answer = output.slice(0, end);
    output = output.slice(end);
    const { resolve } = waiting;
    waiting = undefined;
    resolve(answer);
  };
  const fail = (error: Error) => {
    failure ??= error;
    waiting?.reject(failure);
    waiting = undefined;
  };

  child.stdout.on("data", (chunk: string) => {
    output += chunk;
    settle();
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("error", (error) =>
    fail(
      new ForecastError("git-failed", `${command}: ${error.message}`, {
        cause: error,
      }),
    ),
  );
  const exited = new Promise<void>((resolve) => {
    child.on("close", (code) => {
      fail(
        new ForecastError(
          "git-failed",
          `${command} exited (code ${code})${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
        ),
      );
      resolve();
    });
  });

  return {
    ask(line, recordEnd) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        waiting = { recordEnd, resolve, reject };
        child.stdin.write(`${line}\n`);
        settle();
      });
    },
    async close() {
      child.stdin.end();
      await exited;
    },
  };
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
