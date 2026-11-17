// Test-only judge: runs the REAL `git merge` on a copy of a repo and reports
// what happened, in the engine's shape. Expected results come from Git, not
// from reasoning (CLAUDE.md). Same rules as fixtures/build.ts's judgeMerge.

import { cpSync, existsSync } from "node:fs";
import path from "node:path";
import type { MergeForecast } from "../types.js";
import type { Sandbox } from "./repos.js";

let copies = 0;

export function realMerge(
  box: Sandbox,
  repo: string,
  base: string,
  { autostash = false } = {},
): MergeForecast {
  const copy = path.join(box.root, `judge-${++copies}`);
  cpSync(repo, copy, { recursive: true });
  const args = [
    "merge",
    "--no-edit",
    ...(autostash ? ["--autostash"] : []),
    base,
  ];
  const result = box.run(copy, args);
  if (result.code === 0) return { outcome: "clean" };

  const gitDir = path.join(copy, ".git");
  if (existsSync(path.join(gitDir, "MERGE_HEAD"))) {
    const conflicted = box
      .git(copy, ["diff", "--name-only", "--diff-filter=U"])
      .split("\n")
      .filter(Boolean)
      .sort();
    return { outcome: "conflict", conflictedFiles: conflicted };
  }
  // Refused: Git lists the files in its way as indented lines.
  const blockedBy = result.stderr
    .split("\n")
    .filter((line) => /^\s+\S/.test(line))
    .map((line) => line.trim())
    .sort();
  if (blockedBy.length > 0) return { outcome: "refused", blockedBy };
  throw new Error(`git merge failed in an unexpected way:\n${result.stderr}`);
}
