// What landed on the base branch that you don't have yet: one entry per
// change on main, oldest first, with its PR number and the files it touched.
//
// One Git call:
//   git log HEAD..<base> --reverse --first-parent -m -M --name-status -z
//           --format=%x01%H%x00%s
//
// - HEAD..<base>: commits on base your branch doesn't have. Same list as
//   <merge-base>..<base> (tested, also after merging main into your branch),
//   without the extra merge-base call.
// - --first-parent -m: a PR merged with a merge commit is ONE entry (the
//   merge) listing every file the PR changed, compared with main before it.
//   Plain `git log` shows the PR's inner commits plus a merge with no files.
//   Current Git already shows a merge's first-parent diff when
//   --first-parent is given (see `git help log`, --diff-merges), so -m is
//   redundant there and no test here fails without it. It stays for older
//   Git, where `log -m --first-parent` is the documented way to get that diff.
// - -M: rename detection on, whatever the user's diff.renames says.
// - -z: NUL between fields, so file names come back exact.

import { gitOutput } from "./git.js";
import type { FileChange, IncomingCommit } from "./types.js";

export interface ReadIncomingOptions {
  cwd: string;
  /** e.g. "origin/main", from repo.ts. */
  base: string;
}

const COMMIT = "\x01"; // %x01 starts each commit; it won't appear in a subject.

export async function readIncoming({
  cwd,
  base,
}: ReadIncomingOptions): Promise<IncomingCommit[]> {
  const output = await gitOutput(
    [
      "log",
      "--reverse",
      "--first-parent",
      "-m",
      "-M",
      "--name-status",
      "-z",
      `--format=${COMMIT}%H%x00%s`,
      `HEAD..${base}`,
    ],
    { cwd },
  );
  return parseLog(output);
}

/**
 * Parses the log above. Per commit: `\x01<sha>\0<subject>\0`, then (after a
 * newline) status/path records: `M\0path\0`, or `R100\0from\0to\0`.
 */
export function parseLog(output: string): IncomingCommit[] {
  return output
    .split(COMMIT)
    .filter(Boolean)
    .map((chunk) => {
      const [sha = "", subject = "", ...rest] = chunk.split("\0");
      const files: FileChange[] = [];
      for (let i = 0; i < rest.length; ) {
        // Git puts a newline between a commit's header and its file list.
        const status = (rest[i] ?? "").replace(/^\n/, "");
        if (status === "") {
          i++;
          continue;
        }
        // Renames (R) and copies (C) carry two paths: from, then to.
        if (status[0] === "R" || status[0] === "C") {
          files.push({
            status,
            from: rest[i + 1] ?? "",
            path: rest[i + 2] ?? "",
          });
          i += 3;
        } else {
          files.push({ status, path: rest[i + 1] ?? "" });
          i += 2;
        }
      }
      const pr = parsePrNumber(subject);
      return pr === undefined
        ? { sha, subject, files }
        : { sha, subject, pr, files };
    });
}

/**
 * The PR number in a commit subject, or undefined. Two forms, as GitHub
 * writes them:
 * - squash merge: "Add login page (#12)", only at the very end, so
 *   "Explain #7 in README (#15)" is 15 and a revert's own number wins;
 * - merge commit: "Merge pull request #21 from team/branch".
 */
export function parsePrNumber(subject: string): number | undefined {
  const match =
    /\(#(\d+)\)\s*$/.exec(subject) ??
    /^Merge pull request #(\d+) from /.exec(subject);
  return match ? Number(match[1]) : undefined;
}
