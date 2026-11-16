// Answers three questions every other module starts from: which branch you're
// on, where it was pushed (upstream), and what to compare it against (base).
//
// Choices made by experiment with real Git (see the PR for the table):
// - `symbolic-ref --quiet --short HEAD`, not `rev-parse --abbrev-ref HEAD`:
//   the latter prints "HEAD" and succeeds when detached, and fails in a repo
//   with no commits.
// - `for-each-ref` with %(upstream…), not `rev-parse @{u}`: it never fails,
//   and reports a deleted remote branch as "[gone]" instead of an error.
// - The remote isn't assumed to be "origin", and `<remote>/HEAD` may be
//   missing (older Git didn't set it on fetch), so main/master are fallbacks.
//
// Three Git calls: two at once, then one that needs the branch name.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { gitOutput, runGit } from "./git.js";
import { ForecastError } from "./types.js";

export interface RepoInfo {
  /** Current branch, e.g. "feature". */
  branch: string;
  /** What to compare against, e.g. "origin/main". */
  base: string;
  /** "flag": --base. "remote-head": <remote>/HEAD. "fallback": guessed main/master. */
  baseFrom: "flag" | "remote-head" | "fallback";
  /** Absent when the branch has no upstream configured. */
  upstream?: {
    /** e.g. "origin/feature", or "main" when it tracks a local branch. */
    name: string;
    /** e.g. "origin"; "." when it tracks a local branch. */
    remote: string;
    /** The upstream branch was deleted on the remote (after a fetch --prune). */
    gone: boolean;
  };
}

export interface ReadRepoOptions {
  cwd: string;
  /** From `--base`: compare against this instead of the remote's default. */
  base?: string;
}

/** What each remote has of HEAD → x, main and master. */
interface RemoteDefaults {
  head?: string;
  main: boolean;
  master: boolean;
}

const SEP = "\0"; // `%00` in the format: can't appear in ref or remote names.

export async function readRepo(options: ReadRepoOptions): Promise<RepoInfo> {
  const { cwd } = options;

  const [head, remoteRefs] = await Promise.all([
    // Exit 1 = HEAD isn't a branch (detached).
    runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd,
      okExitCodes: [0, 1],
    }),
    gitOutput(
      [
        "for-each-ref",
        `--format=%(refname)%00%(symref)`,
        "refs/remotes/*/HEAD",
        "refs/remotes/*/main",
        "refs/remotes/*/master",
      ],
      { cwd },
    ),
  ]);
  if (head.exitCode === 1) throw await detachedHeadError(cwd);
  const branch = head.stdout.trim();

  // Branch names can't contain glob characters, so this matches only our branch.
  const upstreamLine = await gitOutput(
    [
      "for-each-ref",
      "--format=%(upstream:short)%00%(upstream:remotename)%00%(upstream:track)",
      `refs/heads/${branch}`,
    ],
    { cwd },
  );
  if (upstreamLine === "") {
    // symbolic-ref knew the name, but the branch ref doesn't exist yet.
    throw new ForecastError(
      "no-commits",
      `Branch ${branch} has no commits yet. Make a first commit, then run git forecast again.`,
    );
  }
  const [upName = "", upRemote = "", upTrack = ""] = upstreamLine.split(SEP);
  const upstream: RepoInfo["upstream"] = upName
    ? { name: upName, remote: upRemote, gone: upTrack === "[gone]" }
    : undefined;

  const base = options.base
    ? { base: await checkBase(options.base, cwd), baseFrom: "flag" as const }
    : pickBase(parseRemoteDefaults(remoteRefs), upstream?.remote);

  return upstream ? { branch, ...base, upstream } : { branch, ...base };
}

function parseRemoteDefaults(output: string): Map<string, RemoteDefaults> {
  const remotes = new Map<string, RemoteDefaults>();
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [refname = "", symref = ""] = line.split(SEP);
    // refs/remotes/<remote>/<leaf>; a remote name may itself contain "/".
    const rest = refname.slice("refs/remotes/".length);
    const slash = rest.lastIndexOf("/");
    const remote = rest.slice(0, slash);
    const leaf = rest.slice(slash + 1);
    const entry = remotes.get(remote) ?? { main: false, master: false };
    if (leaf === "HEAD" && symref) {
      entry.head = symref.slice("refs/remotes/".length);
    } else if (leaf === "main") entry.main = true;
    else if (leaf === "master") entry.master = true;
    remotes.set(remote, entry);
  }
  return remotes;
}

function pickBase(
  remotes: Map<string, RemoteDefaults>,
  upstreamRemote: string | undefined,
): Pick<RepoInfo, "base" | "baseFrom"> {
  // The remote you push to, then "origin", then the only remote there is.
  const preferred = [upstreamRemote, "origin"].filter(
    (r): r is string => r !== undefined && remotes.has(r),
  );
  const remote =
    preferred[0] ?? (remotes.size === 1 ? [...remotes.keys()][0] : undefined);
  const found = remote === undefined ? undefined : remotes.get(remote);

  if (remote !== undefined && found) {
    if (found.head) return { base: found.head, baseFrom: "remote-head" };
    if (found.main) return { base: `${remote}/main`, baseFrom: "fallback" };
    if (found.master) return { base: `${remote}/master`, baseFrom: "fallback" };
  }

  const why =
    remotes.size > 1
      ? `Several remotes (${[...remotes.keys()].join(", ")}) and none is clearly the one to compare with.`
      : "No remote default branch found (no remote, or it was never fetched).";
  throw new ForecastError(
    "no-base-branch",
    `${why} Pass --base <branch>, or run: git remote set-head origin --auto`,
  );
}

/**
 * Confirms a --base names a commit. Returns it as given, for display.
 * Exported for tests only.
 */
export async function checkBase(base: string, cwd: string): Promise<string> {
  // Git branch names can't start with "-". Refusing it here means Git can't
  // read the value as an option (e.g. --output=file), on any Git version.
  // Today the `^{commit}` suffix already makes Git treat it as a name; this
  // check doesn't rely on that.
  if (!base.startsWith("-")) {
    const result = await runGit(
      ["rev-parse", "--verify", "--quiet", `${base}^{commit}`],
      { cwd, okExitCodes: [0, 1] },
    );
    if (result.exitCode === 0) return base;
  }
  throw new ForecastError(
    "no-base-branch",
    `--base ${base}: no branch or commit by that name.`,
  );
}

/** Detached HEAD, worded for the most common cause: a rebase in progress. */
async function detachedHeadError(cwd: string): Promise<ForecastError> {
  const dirs = (
    await gitOutput(
      ["rev-parse", "--git-path", "rebase-merge", "--git-path", "rebase-apply"],
      { cwd },
    )
  ).split("\n");
  for (const dir of dirs) {
    const headName = await readFile(
      path.resolve(cwd, dir, "head-name"),
      "utf8",
    ).catch(() => undefined);
    if (headName) {
      const branch = headName.trim().replace(/^refs\/heads\//, "");
      return new ForecastError(
        "detached-head",
        `A rebase of ${branch} is in progress. Finish it (git rebase --continue) or abort it (git rebase --abort) first.`,
      );
    }
  }
  return new ForecastError(
    "detached-head",
    "You're not on a branch (detached HEAD). Switch to one first: git switch <branch>",
  );
}
