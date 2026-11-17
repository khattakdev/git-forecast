// Checks shared by merge.ts and rebase.ts: things that make a merge-tree
// answer untrustworthy (custom merge drivers, Git LFS, rerere).

import { access } from "node:fs/promises";
import path from "node:path";
import { gitOutput, runGit } from "./git.js";
import type { Uncertain, UncertainReason } from "./types.js";

/** Merge drivers built into Git; any other name is a custom driver. */
const BUILT_IN_DRIVERS = new Set([
  "set",
  "unset",
  "unspecified",
  "text",
  "binary",
  "union",
]);

/**
 * A custom merge driver or Git LFS on any file the merge touches makes the
 * result unknowable from merge-tree. Errs towards "uncertain": a driver only
 * runs when both sides changed a file, but we flag any touched file.
 * Attributes are read from the working tree's .gitattributes files.
 */
export async function attributeProblem(
  cwd: string,
  files: string[],
): Promise<Uncertain | undefined> {
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
export async function rerereEnabled(cwd: string): Promise<boolean> {
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

export function unique(files: string[]): string[] {
  return [...new Set(files)].sort();
}
