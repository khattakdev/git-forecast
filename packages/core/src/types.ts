// The shapes the engine returns. The CLI, `--json` and later front ends all
// read these, so changing a field is a breaking change: bump SCHEMA_VERSION.
//
// Conventions:
// - Results are discriminated unions on `outcome`. Switch on it and end with
//   `assertNever` so a new outcome breaks the build until it's handled.
// - When the engine can't be sure, it says `"uncertain"` with a reason code.
//   It never guesses. (No report at all → `ForecastError` instead.)
// - Field names match fixtures/expected/*.json, so tests compare directly.
// - Paths are repo-relative with `/` on every OS, as Git prints them.
// - Times are Unix seconds, as Git's `%ct`. Front ends format them.

/** Version of the report shapes. Bump on any rename, removal or change of meaning. */
export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Uncertainty

/** Why the engine won't predict an outcome. Front ends word the message. */
export type UncertainReason =
  /** Git older than 2.40: no `merge-tree --merge-base`, so no step-by-step rebase. */
  | "git-too-old"
  /** A file uses a custom merge driver from .gitattributes, which merge-tree can't run. */
  | "custom-merge-driver"
  /** Git LFS pointers: the real file contents aren't what merge-tree sees. */
  | "git-lfs"
  /** rerere is on, so Git may replay a recorded resolution we can't predict. */
  | "rerere"
  /** A rebase step after the first conflict depends on how you resolve it. */
  | "after-first-conflict";

export interface Uncertain {
  outcome: "uncertain";
  reason: UncertainReason;
  /** Specifics for humans, e.g. which file has the merge driver. */
  detail?: string;
}

// ---------------------------------------------------------------------------
// Building blocks

/** One line of `git diff --name-status -M`. `from` is set for renames and copies. */
export interface FileChange {
  /** Git's status letter, with a similarity score for renames/copies: "M", "A", "D", "R100", ... */
  status: string;
  path: string;
  from?: string;
}

export type UpstreamStatus =
  | {
      /** e.g. "origin/feature" */
      name: string;
      /** Commits on your branch that aren't on the upstream yet (unpushed). */
      ahead: number;
      /** Commits on the upstream you don't have locally. */
      behind: number;
    }
  | {
      name: string;
      /** The upstream branch was deleted on the remote (often: its PR was
       *  merged). Nothing to count against, so no ahead/behind. */
      gone: true;
    };

/** Uncommitted state, as `git diff --cached`, `git diff` and `git ls-files --others` see it. */
export interface LocalChanges {
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

export interface Stash {
  /** As `git stash list` shows it, e.g. "On feature: wip a". */
  subject: string;
  /** When it was made, Unix seconds. */
  time: number;
}

/** A commit that landed on the base branch since you branched off. */
export interface IncomingCommit {
  sha: string;
  subject: string;
  /** PR number from the subject: a trailing "(#123)" (squash merge) or
   *  "Merge pull request #123 from …" (merge commit). Absent when neither. */
  pr?: number;
  files: FileChange[];
}

// ---------------------------------------------------------------------------
// Forecasts

export type MergeForecast =
  | {
      outcome: "clean";
      /** Only when the branch has an upstream: would a plain push be rejected? */
      needsForcePush?: boolean;
    }
  | { outcome: "conflict"; conflictedFiles: string[] }
  | {
      /** Git would refuse to start: your uncommitted changes are in the way. */
      outcome: "refused";
      blockedBy: string[];
    }
  | Uncertain;

export type RebaseForecast =
  | {
      outcome: "clean";
      /** Commits that would be replayed. */
      totalSteps: number;
      /** Only with an upstream: commits already pushed that the rebase rewrites. */
      rewritesPushedCommits?: number;
      /** Only with an upstream: would a plain push be rejected afterwards? */
      needsForcePush?: boolean;
    }
  | {
      /** Stops at the first conflicting step. Later steps are unknowable
       *  until you resolve it (see "after-first-conflict"). */
      outcome: "conflict";
      totalSteps: number;
      /** 1-based, like Git's own "Rebasing (2/3)". */
      stoppedAtStep: number;
      /** Subject of the commit being replayed when it stopped. */
      stoppedAtCommit: string;
      stoppedAtSha: string;
      conflictedFiles: string[];
    }
  | {
      /** Git would refuse to start: rebase needs a clean working tree. */
      outcome: "refused";
    }
  | Uncertain;

export interface Recommendation {
  pick: "rebase" | "merge";
  /** "team-rule": .gitforecast.json says so. "history-shape": base branch's recent merges. */
  because: "team-rule" | "history-shape";
}

// ---------------------------------------------------------------------------
// Reports

/** Everything `git forecast` shows. */
export interface StatusReport {
  schemaVersion: typeof SCHEMA_VERSION;
  /** Your current branch, e.g. "feature". */
  branch: string;
  /** What you're compared against, e.g. "origin/main". */
  base: string;
  /** Commits on your branch that aren't on base. */
  ahead: number;
  /** Commits on base you don't have. */
  behind: number;
  /** Absent when the branch was never pushed. */
  upstream?: UpstreamStatus;
  local: LocalChanges;
  /** Newest first, as `git stash list`. */
  stashes: Stash[];
  /** Oldest first. */
  incoming: IncomingCommit[];
  /** Preview: what `git merge <base>` would do right now. */
  merge: MergeForecast;
  freshness: {
    /** Last `git fetch`, Unix seconds. Absent if the repo was never fetched. */
    fetchedAt?: number;
  };
}

/** Everything `git forecast sync` shows: both options side by side. */
export interface SyncReport {
  schemaVersion: typeof SCHEMA_VERSION;
  status: StatusReport;
  merge: MergeForecast;
  rebase: RebaseForecast;
  recommendation: Recommendation;
  /** Only when your uncommitted changes make Git refuse: what `--autostash`
   *  would do instead. Matches `ifStashed` in fixtures/expected/. */
  ifStashed?: StashedForecast;
}

/** The forecast with `git merge/rebase --autostash`. Git stashes tracked
 *  changes (not untracked files), syncs, then re-applies the stash. */
export interface StashedForecast {
  /** Can still be "refused": untracked files aren't stashed. */
  merge: MergeForecast;
  rebase: RebaseForecast;
  /** Files changed both by you and by the sync. Re-applying the stash may
   *  conflict on these; Git then keeps the stash for you to resolve. */
  reapplyOverlap: string[];
}

// ---------------------------------------------------------------------------
// Errors and helpers

/** Reasons there's no report at all. The CLI maps these to exit code 2. */
export type ForecastErrorCode =
  | "git-not-found"
  | "git-failed"
  | "not-a-git-repo"
  | "detached-head"
  /** On a branch that has no commits yet (a brand-new repo). */
  | "no-commits"
  /** A merge, cherry-pick or revert was started and not finished. */
  | "operation-in-progress"
  | "no-base-branch";

/** Thrown when the engine can't produce a report at all. Partial unknowns
 *  are `"uncertain"` inside a report instead. */
export class ForecastError extends Error {
  readonly code: ForecastErrorCode;

  constructor(
    code: ForecastErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ForecastError";
    this.code = code;
  }
}

/**
 * Ends an exhaustive `switch`: TypeScript only accepts the call when every
 * case is handled, and it throws if data that bypassed the types gets here.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}
