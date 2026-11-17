// Test-only judge: runs the REAL `git merge` / `git rebase` on a copy of a repo and reports
// what happened, in the engine's shape. Expected results come from Git, not
// from reasoning (CLAUDE.md). Same rules as fixtures/build.ts's judgeMerge.

import { cpSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { MergeForecast, RebaseForecast } from "../types.js";
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

/** Runs the REAL `git rebase` on a copy. Same rules as fixtures/build.ts. */
export function realRebase(
  box: Sandbox,
  repo: string,
  base: string,
  { autostash = false } = {},
): RebaseForecast {
  const copy = path.join(box.root, `judge-${++copies}`);
  cpSync(repo, copy, { recursive: true });
  const headBefore = box.git(copy, ["rev-parse", "HEAD"]).trim();
  const args = ["rebase", ...(autostash ? ["--autostash"] : []), base];
  const result = box.run(copy, args);
  if (result.code === 0) {
    const count = box.git(copy, ["rev-list", "--count", `${base}..HEAD`]);
    return { outcome: "clean", totalSteps: Number(count) };
  }
  const state = path.join(copy, ".git", "rebase-merge");
  if (!existsSync(state)) {
    const headAfter = box.git(copy, ["rev-parse", "HEAD"]).trim();
    if (headAfter !== headBefore)
      throw new Error("rebase moved HEAD and stopped");
    return { outcome: "refused" };
  }
  const read = (file: string) =>
    readFileSync(path.join(state, file), "utf8").trim();
  const conflicted = box
    .git(copy, ["diff", "--name-only", "--diff-filter=U"])
    .split("\n")
    .filter(Boolean)
    .sort();
  if (conflicted.length === 0) {
    throw new Error(`git rebase stopped without a conflict:\n${result.stderr}`);
  }
  return {
    outcome: "conflict",
    totalSteps: Number(read("end")),
    stoppedAtStep: Number(read("msgnum")),
    stoppedAtCommit: box
      .git(copy, ["log", "-1", "--format=%s", "REBASE_HEAD"])
      .trim(),
    stoppedAtSha: box.git(copy, ["rev-parse", "REBASE_HEAD"]).trim(),
    conflictedFiles: conflicted,
  };
}
