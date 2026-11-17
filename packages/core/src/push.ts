// Would you need a force push afterwards? Only for a branch with an upstream
// (not gone). Two counts, run at once:
//
// - <base>..<upstream>: commits on your upstream that base doesn't have. A
//   rebase gives your commits new IDs, so these all go missing from the
//   rebased branch: that is what a force push would replace.
// - <upstream> ^HEAD ^<base>: commits on your upstream that neither your
//   branch nor base has (a teammate pushed to your branch). Even after a
//   merge, a plain push is then rejected.
//
// Matches how fixtures/build.ts measures it: `rev-list --count HEAD..@{u}`
// after the real rebase/merge, and whether a real `git push` is rejected.

import { gitOutput } from "./git.js";
import type { MergeForecast, RebaseForecast, UpstreamStatus } from "./types.js";

export interface PushFacts {
  /** For a clean rebase: commits on the upstream the rebased branch won't contain. */
  rewritesPushedCommits: number;
  rebaseNeedsForcePush: boolean;
  mergeNeedsForcePush: boolean;
}

export interface ReadPushOptions {
  cwd: string;
  base: string;
  upstream?: UpstreamStatus;
  /** From status.ts: commits on base you don't have. 0 → rebase is a no-op. */
  behind: number;
}

export async function readPush(
  options: ReadPushOptions,
): Promise<PushFacts | undefined> {
  const { cwd, base, upstream, behind } = options;
  if (!upstream || "gone" in upstream) return undefined;
  const count = async (args: string[]) =>
    Number(await gitOutput(["rev-list", "--count", ...args], { cwd }));
  const [notInBase, notInMerge] = await Promise.all([
    count([`${base}..${upstream.name}`]),
    count([upstream.name, "^HEAD", `^${base}`]),
  ]);
  // Nothing new on base: `git rebase` says "up to date" and changes nothing,
  // so only commits you haven't pulled are missing.
  const rewrites = behind > 0 ? notInBase : upstream.behind;
  return {
    rewritesPushedCommits: rewrites,
    rebaseNeedsForcePush: rewrites > 0,
    mergeNeedsForcePush: notInMerge > 0,
  };
}

/** Adds the push facts to a clean merge forecast; other outcomes unchanged. */
export function withMergePush(
  merge: MergeForecast,
  push: PushFacts | undefined,
): MergeForecast {
  if (!push || merge.outcome !== "clean") return merge;
  return { ...merge, needsForcePush: push.mergeNeedsForcePush };
}

/** Adds the push facts to a clean rebase forecast; other outcomes unchanged. */
export function withRebasePush(
  rebase: RebaseForecast,
  push: PushFacts | undefined,
): RebaseForecast {
  if (!push || rebase.outcome !== "clean") return rebase;
  return {
    ...rebase,
    rewritesPushedCommits: push.rewritesPushedCommits,
    needsForcePush: push.rebaseNeedsForcePush,
  };
}
