// Which step of `git rebase <base>` would stop on a conflict, if any.
// Design and measurements: docs/rebase-design.md.
//
// Simulation: one long-running `git merge-tree --stdin` replays your commits
// as trees (no commits are created). Result trees are stored as unreferenced
// objects that Git's cleanup removes. Falls back to one merge-tree process
// per step if batch mode is rejected.

import { attributeProblem, rerereEnabled, unique } from "./checks.js";
import {
  type GitVersion,
  gitOutput,
  gitVersion,
  isAtLeast,
  openGit,
  runGit,
} from "./git.js";
import type { LocalChanges, RebaseForecast } from "./types.js";

export interface ReadRebaseOptions {
  cwd: string;
  base: string;
  local: LocalChanges;
  /** "auto" (default): batch, falling back per step. Tests force one path,
   *  so a broken batch mode can't hide behind the fallback. */
  mode?: Mode;
  /** For tests: pretend to be this Git version. */
  version?: GitVersion | null;
}

export interface RebaseParts {
  rebase: RebaseForecast;
  /** Only when `rebase` is "refused": the outcome with `--autostash`. */
  ifStashed?: RebaseForecast;
}

type Mode = "auto" | "batch" | "one-by-one";

/** One replayed step: clean (with the new tree) or the conflicted files. */
/** One replayed step: clean (with the new tree), or the conflicted files and
 *  the tree it was replayed onto ("ours", needed to name moved files). */
type Step =
  | { clean: true; tree: string }
  | { clean: false; files: string[]; ours: string };

export async function readRebase(
  options: ReadRebaseOptions,
): Promise<RebaseParts> {
  const { cwd, base, local } = options;
  const version =
    options.version !== undefined ? options.version : await gitVersion();

  const [list, branchFiles, baseAdds, rerere, baseTree] = await Promise.all([
    // What git rebase replays: your commits, minus merges and minus patches
    // already on base.
    gitOutput(
      [
        "rev-list",
        "--reverse",
        "--right-only",
        "--cherry-pick",
        "--no-merges",
        `${base}...HEAD`,
      ],
      { cwd },
    ),
    // Files your branch changes (for the merge-driver / LFS check).
    gitOutput(["diff", "--name-only", "-z", `${base}...HEAD`], { cwd }),
    // Files base has that HEAD doesn't: an untracked file there blocks the
    // checkout git rebase starts with.
    gitOutput(
      [
        "diff",
        "--name-only",
        "-z",
        "--no-renames",
        "--diff-filter=A",
        "HEAD",
        base,
      ],
      {
        cwd,
      },
    ),
    rerereEnabled(cwd),
    gitOutput(["rev-parse", `${base}^{tree}`], { cwd }),
  ]);
  const commits = list.split("\n").filter(Boolean);
  const added = new Set(baseAdds.split("\0").filter(Boolean));
  const untrackedClash = local.untracked.filter((file) => added.has(file));
  const trackedChanges = local.staged.length + local.unstaged.length > 0;

  const own = await (async (): Promise<RebaseForecast> => {
    if (!version || !isAtLeast(version, 2, 40)) {
      return {
        outcome: "uncertain",
        reason: "git-too-old",
        detail: `step-by-step rebase needs Git 2.40+; found ${version?.raw ?? "an unknown version"}`,
      };
    }
    return simulate(
      cwd,
      commits,
      baseTree,
      branchFiles,
      rerere,
      options.mode ?? "auto",
    );
  })();

  // Measured: any tracked change, or an untracked file in base's way, makes
  // git rebase refuse. --autostash stashes tracked changes only.
  if (!trackedChanges && untrackedClash.length === 0) return { rebase: own };
  return {
    rebase: { outcome: "refused" },
    ifStashed: untrackedClash.length > 0 ? { outcome: "refused" } : own,
  };
}

async function simulate(
  cwd: string,
  commits: string[],
  baseTree: string,
  branchFiles: string,
  rerere: boolean,
  mode: Mode,
): Promise<RebaseForecast> {
  const totalSteps = commits.length;
  const steps = await replay(cwd, commits, baseTree, mode);
  if (steps === undefined) {
    return {
      outcome: "uncertain",
      reason: "git-too-old",
      detail: "this Git can't run merge-tree with a given merge base",
    };
  }

  const stop = steps.findIndex((step) => !step.clean);
  const stopped = steps[stop];
  const conflicted = stopped && !stopped.clean ? stopped.files : [];
  const touched = unique([
    ...branchFiles.split("\0").filter(Boolean),
    ...conflicted,
  ]);
  const uncertain = await attributeProblem(cwd, touched);
  if (uncertain) return uncertain;

  const sha = commits[stop];
  if (sha === undefined) return { outcome: "clean", totalSteps };
  if (rerere) {
    return {
      outcome: "uncertain",
      reason: "rerere",
      detail: `rerere may replay a recorded resolution for ${conflicted.join(", ")}`,
    };
  }
  // %h abbreviates the way git rebase does when it names things.
  const [short = "", subject = ""] = (
    await gitOutput(["log", "-1", "--format=%h%x00%s", sha], { cwd })
  ).split("\0");
  const ours = stopped && !stopped.clean ? stopped.ours : "";
  return {
    outcome: "conflict",
    totalSteps,
    stoppedAtStep: stop + 1,
    stoppedAtCommit: subject,
    stoppedAtSha: sha,
    conflictedFiles: unique(
      conflicted.map((file) => rebaseName(file, { sha, short, subject, ours })),
    ),
  };
}

/**
 * When a file and a folder of the same name clash, Git moves the file aside
 * as `<path>~<label>`. merge-tree labels the sides with the IDs we gave it;
 * git rebase labels them "HEAD" (the branch being built) and
 * "<short id> (<subject>)" (the commit being replayed). Use Git's names, so
 * the forecast lists the same files `git rebase` leaves conflicted.
 */
function rebaseName(
  file: string,
  side: { sha: string; short: string; subject: string; ours: string },
): string {
  if (file.endsWith(`~${side.sha}`)) {
    return `${file.slice(0, -side.sha.length)}${side.short} (${side.subject})`;
  }
  if (side.ours && file.endsWith(`~${side.ours}`)) {
    return `${file.slice(0, -side.ours.length)}HEAD`;
  }
  return file;
}

/**
 * Replays `commits` onto `baseTree`, stopping after the first conflict.
 * Undefined when this Git can't do it at all.
 */
async function replay(
  cwd: string,
  commits: string[],
  baseTree: string,
  mode: Mode,
): Promise<Step[] | undefined> {
  if (commits.length === 0) return [];
  if (mode === "batch") return replayBatch(cwd, commits, baseTree);
  if (mode === "auto") {
    const steps = await replayBatch(cwd, commits, baseTree).catch(
      () => undefined,
    );
    if (steps) return steps;
  }
  return replayOneByOne(cwd, commits, baseTree);
}

/** D1: one `merge-tree --stdin` process, one line per step. */
async function replayBatch(
  cwd: string,
  commits: string[],
  baseTree: string,
): Promise<Step[]> {
  const git = openGit(
    ["merge-tree", "--stdin", "--name-only", "--no-messages"],
    { cwd },
  );
  try {
    const steps: Step[] = [];
    let tree = baseTree;
    for (const commit of commits) {
      // Record: <1 clean | 0 conflict>\0<tree>\0<conflicted path>\0...\0
      const record = await git.ask(
        `${commit}^ -- ${tree} ${commit}`,
        recordEnd,
      );
      const [status, next = "", ...files] = record.split("\0");
      if (status === "1") {
        steps.push({ clean: true, tree: next });
        tree = next;
      } else if (status === "0") {
        steps.push({
          clean: false,
          files: unique(files.filter(Boolean)),
          ours: tree,
        });
        break;
      } else {
        throw new Error(
          `unexpected merge-tree record: ${JSON.stringify(record)}`,
        );
      }
    }
    return steps;
  } finally {
    await git.close();
  }
}

/** Where a batch record ends: after the empty field that follows its paths. */
function recordEnd(output: string): number {
  let at = 0;
  for (let field = 0; ; field++) {
    const nul = output.indexOf("\0", at);
    if (nul < 0) return -1;
    if (field >= 2 && nul === at) return nul + 1;
    at = nul + 1;
  }
}

/** D2 fallback: one `merge-tree --merge-base` process per step. */
async function replayOneByOne(
  cwd: string,
  commits: string[],
  baseTree: string,
): Promise<Step[] | undefined> {
  const steps: Step[] = [];
  let tree = baseTree;
  for (const commit of commits) {
    const result = await runGit(
      [
        "merge-tree",
        "--write-tree",
        "-z",
        "--name-only",
        "--no-messages",
        `--merge-base=${commit}^`,
        tree,
        commit,
      ],
      { cwd, okExitCodes: [0, 1, 128, 129] },
    );
    if (result.exitCode > 1) return undefined; // option or tree argument unsupported
    const [next = "", ...files] = result.stdout.split("\0");
    if (result.exitCode === 0) {
      steps.push({ clean: true, tree: next });
      tree = next;
    } else {
      steps.push({
        clean: false,
        files: unique(files.filter(Boolean)),
        ours: tree,
      });
      break;
    }
  }
  return steps;
}
