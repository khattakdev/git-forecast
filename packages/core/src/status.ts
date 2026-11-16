// Ahead/behind (vs base and vs upstream), uncommitted files and stashes.
// Four Git calls, all at once:
//
// - `status --porcelain=v2 -z --branch -uall`: local files plus the
//   upstream's ahead/behind from its `# branch.ab` header.
//   -uall lists files inside untracked folders (default shows just `dir/`);
//   -z keeps any file name exact (tabs and newlines included).
// - `rev-list --left-right --count <base>...HEAD`: prints "behind<TAB>ahead".
// - `stash list`: time and subject of each stash, newest first.
// - `rev-parse --git-path MERGE_HEAD ...`: where Git marks an unfinished
//   merge/cherry-pick/revert. Needed because once every conflict is fixed
//   (but not committed) status shows no conflict lines, yet the merge is
//   still underway.

import { access } from "node:fs/promises";
import path from "node:path";
import { gitOutput } from "./git.js";
import type { RepoInfo } from "./repo.js";
import {
  ForecastError,
  type LocalChanges,
  type Stash,
  type StatusReport,
  type UpstreamStatus,
} from "./types.js";

/** The StatusReport fields this module owns. */
export type StatusParts = Pick<
  StatusReport,
  "ahead" | "behind" | "upstream" | "local" | "stashes"
>;

export interface ReadStatusOptions {
  cwd: string;
  repo: RepoInfo;
}

const OPERATIONS = [
  {
    file: "MERGE_HEAD",
    name: "merge",
    fix: "Finish it (git commit) or abort it (git merge --abort)",
  },
  {
    file: "CHERRY_PICK_HEAD",
    name: "cherry-pick",
    fix: "Finish it (git cherry-pick --continue) or abort it (git cherry-pick --abort)",
  },
  {
    file: "REVERT_HEAD",
    name: "revert",
    fix: "Finish it (git revert --continue) or abort it (git revert --abort)",
  },
] as const;

export async function readStatus({
  cwd,
  repo,
}: ReadStatusOptions): Promise<StatusParts> {
  const [status, counts, stashList, opPaths] = await Promise.all([
    gitOutput(["status", "--porcelain=v2", "-z", "--branch", "-uall"], { cwd }),
    gitOutput(["rev-list", "--left-right", "--count", `${repo.base}...HEAD`], {
      cwd,
    }),
    gitOutput(["stash", "list", "--format=%ct%x09%gs"], { cwd }),
    gitOutput(
      ["rev-parse", ...OPERATIONS.flatMap((op) => ["--git-path", op.file])],
      { cwd },
    ),
  ]);

  await checkNoOperation(cwd, opPaths.split("\n"));
  const parsed = parseStatus(status);
  if (parsed.conflicted.length > 0) {
    // Conflicts without a merge/cherry-pick/revert marker: e.g. a
    // `git stash pop` that conflicted.
    throw new ForecastError(
      "operation-in-progress",
      `Unresolved conflicts in ${parsed.conflicted.join(", ")}. Resolve them (edit, then git add) first.`,
    );
  }

  // Left side of base...HEAD is commits only on base: how far behind you are.
  const [behind = 0, ahead = 0] = counts.split(/\s+/).map(Number);

  const result: StatusParts = {
    ahead,
    behind,
    local: parsed.local,
    stashes: parseStashes(stashList),
  };
  const upstream = upstreamStatus(repo, parsed.upstreamCounts);
  if (upstream) result.upstream = upstream;
  return result;
}

async function checkNoOperation(cwd: string, paths: string[]): Promise<void> {
  for (const [i, op] of OPERATIONS.entries()) {
    const file = paths[i];
    if (!file) continue;
    const exists = await access(path.resolve(cwd, file)).then(
      () => true,
      () => false,
    );
    if (exists) {
      throw new ForecastError(
        "operation-in-progress",
        `A ${op.name} is in progress. ${op.fix} first.`,
      );
    }
  }
}

function upstreamStatus(
  repo: RepoInfo,
  counts: { ahead: number; behind: number } | undefined,
): UpstreamStatus | undefined {
  if (!repo.upstream) return undefined;
  const { name } = repo.upstream;
  // Git omits `# branch.ab` when the upstream branch no longer exists.
  if (repo.upstream.gone || !counts) return { name, gone: true };
  return { name, ...counts };
}

interface ParsedStatus {
  local: LocalChanges;
  conflicted: string[];
  upstreamCounts?: { ahead: number; behind: number };
}

/** Text after the first `n` space-separated fields (a path may contain spaces). */
function afterFields(record: string, n: number): string {
  let at = 0;
  for (let i = 0; i < n; i++) at = record.indexOf(" ", at) + 1;
  return record.slice(at);
}

/** Parses `git status --porcelain=v2 -z --branch`. Lists come back sorted. */
export function parseStatus(output: string): ParsedStatus {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  const conflicted: string[] = [];
  let upstreamCounts: ParsedStatus["upstreamCounts"];

  const records = output.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? "";
    const kind = record[0];
    // XY: X = staged side, Y = unstaged side; "." means unchanged.
    const x = record[2];
    const y = record[3];

    if (kind === "#") {
      const ab = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (ab) upstreamCounts = { ahead: Number(ab[1]), behind: Number(ab[2]) };
    } else if (kind === "1" || kind === "2") {
      // "1": 8 fields then the path. "2" (rename/copy): 9 fields, the path,
      // then the old path as the next record.
      const file = afterFields(record, kind === "1" ? 8 : 9);
      if (kind === "2") i++; // skip the old path
      if (x !== ".") staged.push(file);
      if (y !== ".") unstaged.push(file);
    } else if (kind === "u") {
      conflicted.push(afterFields(record, 10));
    } else if (kind === "?") {
      untracked.push(record.slice(2));
    }
    // "!" (ignored) isn't requested; empty records are the trailing NUL.
  }

  return {
    local: {
      staged: staged.sort(),
      unstaged: unstaged.sort(),
      untracked: untracked.sort(),
    },
    conflicted: conflicted.sort(),
    ...(upstreamCounts ? { upstreamCounts } : {}),
  };
}

/** `%ct<TAB>%gs` per line; the subject itself may contain tabs. */
function parseStashes(output: string): Stash[] {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      return {
        time: Number(line.slice(0, tab)),
        subject: line.slice(tab + 1),
      };
    });
}
