// Would `git merge <base>` be clean, conflict, or be refused, and what would
// `git merge --autostash` do instead?
//
// Git calls: `merge-tree` (the merge, without touching your files) and the
// rerere checks at once; then `diff-tree` (which files the merge changes);
// then `check-attr` (merge drivers, LFS) on those files via stdin.
//
// What those Git commands do:
// - `git merge-tree --write-tree A B`: does the same three-way merge as
//   `git merge`, but only in Git's object database. Your branch, index and
//   files stay untouched. Prints the resulting tree's ID and, with exit
//   code 1, the files that would conflict.
// - `git diff-tree -r X Y`: compares two trees (snapshots of the whole
//   project) and lists the files that differ. Here: HEAD vs the merge result,
//   which is exactly the set of files `git merge` would rewrite.
// - `git check-attr merge filter -- <files>`: reads .gitattributes for those
//   files. A custom `merge=` driver runs a program merge-tree can't run, and
//   `filter=lfs` means Git only sees small pointer files, so in both cases
//   we answer "uncertain" instead of guessing.
// - rerere ("reuse recorded resolution"): when on, Git remembers how you
//   resolved a conflict and replays it next time, so a conflict merge-tree
//   predicts may be resolved automatically. Also "uncertain".
//
// `merge-tree --write-tree` stores the result tree in Git's object database.
// Nothing points at it (no ref, index or working-tree change), and Git's
// routine cleanup deletes it. Same for every other check in this module.
//
// When does Git refuse? Measured with real Git (see merge.test.ts):
//
//   your uncommitted change         | real merge | fast-forward
//   staged, a file main didn't touch | refused    | fine
//   staged, a file main touched      | refused    | refused
//   unstaged, a file main touched    | refused    | refused
//   unstaged, elsewhere              | fine       | fine
//   untracked where main adds a file | refused    | refused
//
// A real merge checks staged changes first and stops there: when anything is
// staged, Git names only the staged files.
// `--autostash` stashes tracked changes only, so untracked files still block.

import { access } from "node:fs/promises";
import path from "node:path";
import { gitOutput, runGit } from "./git.js";
import type { LocalChanges, MergeForecast, UncertainReason } from "./types.js";

export interface ReadMergeOptions {
  cwd: string;
  base: string;
  /** From status.ts: commits on your branch / on base that the other lacks. */
  ahead: number;
  behind: number;
  local: LocalChanges;
}

export interface MergeParts {
  merge: MergeForecast;
  /** Only when `merge` is "refused": the outcome with `--autostash`. */
  ifStashed?: MergeForecast;
  /** Only with `ifStashed`: files changed both by you and by the merge. */
  reapplyOverlap?: string[];
}

/** Merge drivers built into Git; any other name is a custom driver. */
const BUILT_IN_DRIVERS = new Set([
  "set",
  "unset",
  "unspecified",
  "text",
  "binary",
  "union",
]);

export async function readMerge(
  options: ReadMergeOptions,
): Promise<MergeParts> {
  const { cwd, base, ahead, behind, local } = options;
  // Nothing on base you don't have: "Already up to date", never refused.
  if (behind === 0) return { merge: { outcome: "clean" } };

  const [tree, rerere] = await Promise.all([
    runGit(["merge-tree", "--write-tree", "-z", "--name-only", "HEAD", base], {
      cwd,
      okExitCodes: [0, 1], // 1 = conflicts, an answer
    }),
    rerereEnabled(cwd),
  ]);
  // -z output: <tree>\0<conflicted path>\0...\0\0<messages>
  const [treeId = "", ...rest] = tree.stdout.split("\0");
  const conflicted = rest.slice(0, rest.indexOf("")).sort();

  const changes = await changedFiles(cwd, treeId);
  const touched = [...changes.keys()];

  // What the merge itself does, ignoring your uncommitted changes.
  const own = await mergeOutcome(cwd, touched, conflicted, rerere);

  // Fast-forward (you have no commits of your own): only files the update
  // changes can block. A real merge: anything staged blocks, and Git stops
  // at that first check.
  const fastForward = ahead === 0;
  const touchedSet = new Set(touched);
  const isTouched = (file: string) => touchedSet.has(file);
  const untracked = local.untracked.filter((file) => changes.get(file) === "A");
  const stagedFirst = !fastForward && local.staged.length > 0;
  const tracked = stagedFirst
    ? local.staged
    : [...local.staged, ...local.unstaged].filter(isTouched);
  const blockedBy = unique(stagedFirst ? tracked : [...tracked, ...untracked]);
  if (blockedBy.length === 0) return { merge: own };

  return {
    merge: { outcome: "refused", blockedBy },
    ifStashed:
      untracked.length > 0
        ? { outcome: "refused", blockedBy: unique(untracked) }
        : own,
    reapplyOverlap: unique(
      [...local.staged, ...local.unstaged].filter(isTouched),
    ),
  };
}

/** Files the merge result changes compared with HEAD → their status letter. */
async function changedFiles(
  cwd: string,
  tree: string,
): Promise<Map<string, string>> {
  const out = await gitOutput(
    ["diff-tree", "-r", "-z", "--no-renames", "--name-status", "HEAD", tree],
    { cwd },
  );
  const changes = new Map<string, string>();
  const parts = out.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    changes.set(parts[i + 1] ?? "", parts[i] ?? "");
  }
  return changes;
}

async function mergeOutcome(
  cwd: string,
  touched: string[],
  conflicted: string[],
  rerere: boolean,
): Promise<MergeForecast> {
  const uncertain = await attributeProblem(
    cwd,
    unique([...touched, ...conflicted]),
  );
  if (uncertain) return uncertain;
  if (conflicted.length === 0) return { outcome: "clean" };
  if (rerere) {
    return {
      outcome: "uncertain",
      reason: "rerere",
      detail: `rerere may replay a recorded resolution for ${conflicted.join(", ")}`,
    };
  }
  return { outcome: "conflict", conflictedFiles: conflicted };
}

/**
 * A custom merge driver or Git LFS on any file the merge touches makes the
 * result unknowable from merge-tree. Errs towards "uncertain": a driver only
 * runs when both sides changed a file, but we flag any touched file.
 * Attributes are read from the working tree's .gitattributes files.
 */
async function attributeProblem(
  cwd: string,
  files: string[],
): Promise<MergeForecast | undefined> {
  if (files.length === 0) return undefined;
  const out = await gitOutput(
    ["check-attr", "--stdin", "-z", "merge", "filter"],
    {
      cwd,
      input: `${files.join("\0")}\0`,
    },
  );
  // -z output: <path>\0<attribute>\0<value>\0 ...
  const parts = out.split("\0");
  const found: { reason: UncertainReason; file: string }[] = [];
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const [file = "", attribute, value = ""] = parts.slice(i, i + 3);
    if (attribute === "filter" && value === "lfs")
      found.push({ reason: "git-lfs", file });
    if (attribute === "merge" && !BUILT_IN_DRIVERS.has(value)) {
      found.push({ reason: "custom-merge-driver", file });
    }
  }
  // LFS files also declare `merge=lfs`; "git-lfs" is the precise reason.
  const first = found.find((f) => f.reason === "git-lfs") ?? found[0];
  if (!first) return undefined;
  const files_ = unique(
    found.filter((f) => f.reason === first.reason).map((f) => f.file),
  );
  return {
    outcome: "uncertain",
    reason: first.reason,
    detail:
      first.reason === "git-lfs"
        ? `Git LFS files: ${files_.join(", ")}`
        : `custom merge driver on ${files_.join(", ")}`,
  };
}

/** rerere.enabled, or (when unset) an existing rr-cache folder, as Git does. */
async function rerereEnabled(cwd: string): Promise<boolean> {
  const [config, cachePath] = await Promise.all([
    runGit(["config", "--type=bool", "--get", "rerere.enabled"], {
      cwd,
      okExitCodes: [0, 1], // 1 = not set
    }),
    gitOutput(["rev-parse", "--git-path", "rr-cache"], { cwd }),
  ]);
  if (config.exitCode === 0) return config.stdout.trim() === "true";
  return access(path.resolve(cwd, cachePath)).then(
    () => true,
    () => false,
  );
}

function unique(files: string[]): string[] {
  return [...new Set(files)].sort();
}
