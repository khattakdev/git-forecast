// `git forecast sync`: show rebase and merge side by side, recommend one,
// then run the pick with real Git (live output) and say what's next.

import { access } from "node:fs/promises";
import path from "node:path";
import {
  forecastSync,
  gitOutput,
  runGitLive,
  type SyncReport,
} from "@git-forecast/core";
import type { Flags } from "./cli.js";
import type { ScreenContext } from "./format.js";
import { askKey, type Key } from "./prompt.js";
import { effective, formatDetails, formatSync } from "./sync-screen.js";

type Pick = "rebase" | "merge";

export async function runSync(
  flags: Flags,
  ctx: ScreenContext,
): Promise<number> {
  const { c } = ctx;
  if (flags.rebase && flags.merge) {
    console.error(`${c.red("git-forecast:")} pick one of --rebase and --merge`);
    return 1;
  }
  const cwd = process.cwd();
  const report = await forecastSync(
    flags.base ? { cwd, base: flags.base } : { cwd },
  );
  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  const autostash = flags.autostash ?? report.config.autostash ?? false;
  console.log(formatSync(report, ctx, { autostash }));
  const shown = effective(report, { autostash });
  const blocked = (pick: Pick) => shown[pick].outcome === "refused";

  let pick: Pick | undefined = flags.rebase
    ? "rebase"
    : flags.merge
      ? "merge"
      : undefined;
  if (pick === undefined) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return 0; // piped or CI: print only
    pick = await choose(report, ctx, blocked);
    if (pick === undefined) return 0;
  } else if (blocked(pick)) {
    console.error(
      `\n${c.red("git-forecast:")} ${pick} is blocked by your uncommitted changes. Run git stash first, or add --autostash.`,
    );
    return 1;
  }
  return run(pick, report, ctx, autostash);
}

async function choose(
  report: SyncReport,
  ctx: ScreenContext,
  blocked: (p: Pick) => boolean,
): Promise<Pick | undefined> {
  const { c } = ctx;
  const keys: Key[] = [];
  const labels: string[] = [];
  for (const [key, pick] of [
    ["r", "rebase"],
    ["m", "merge"],
  ] as const) {
    if (!blocked(pick)) {
      keys.push(key);
      labels.push(`${c.cyan(`[${key}]`)} ${pick}`);
    }
  }
  keys.push("d", "q");
  labels.push(`${c.cyan("[d]")} details`, `${c.cyan("[q]")} quit`);
  for (;;) {
    process.stdout.write(`\n${labels.join("  ")} `);
    const key = await askKey(keys);
    process.stdout.write(`${key}\n`);
    if (key === "q") return undefined;
    if (key === "d") {
      console.log(`\n${formatDetails(report, ctx)}`);
      continue;
    }
    return key === "r" ? "rebase" : "merge";
  }
}

async function run(
  pick: Pick,
  report: SyncReport,
  ctx: ScreenContext,
  autostash: boolean,
): Promise<number> {
  const { c } = ctx;
  const base = report.status.base;
  const args = pick === "rebase" ? ["rebase"] : ["merge"];
  if (autostash) args.push("--autostash");
  args.push(base);
  const cwd = process.cwd();
  console.log(`\n${c.dim("$")} git ${args.join(" ")}`);
  const code = await runGitLive(args, { cwd });

  if (code === 0) {
    console.log(
      `\n${c.green(`${pick === "rebase" ? "Rebased onto" : "Merged"} ${base}.`)}`,
    );
    // --autostash: Git re-applies your changes after the sync; that can
    // conflict (the screen warned which files). Git keeps the stash then.
    const reapplied = autostash ? await conflictedFiles(cwd) : [];
    if (reapplied.length > 0) {
      console.log(
        c.yellow(
          `Re-applying your stashed changes conflicted in ${reapplied.join(", ")}.`,
        ),
      );
      console.log(
        `${c.dim("Next:")} fix those files, then git stash drop ${c.dim("(Git kept your stash, see git stash list)")}`,
      );
      return 1;
    }
    console.log(`${c.dim("Next:")} ${pushCommand(pick, report)}`);
    console.log(
      `${c.dim("Undo:")} git reset --keep ORIG_HEAD ${c.dim("(refuses rather than lose uncommitted work)")}`,
    );
    return 0;
  }

  const stopped = await inProgress(cwd, pick);
  if (stopped) {
    const files = await conflictedFiles(cwd);
    console.log(
      `\n${c.yellow(`The ${pick} stopped on a conflict${files.length ? ` in ${files.join(", ")}` : ""}.`)}`,
    );
    console.log(
      `${c.dim("Next:")} fix the files, git add them, then git ${pick} --continue`,
    );
    console.log(`${c.dim("Back out:")} git ${pick} --abort`);
  } else {
    console.log(
      `\n${c.red(`git ${pick} didn't run (exit ${code}); nothing changed.`)}`,
    );
  }
  return 1;
}

function pushCommand(pick: Pick, report: SyncReport): string {
  const up = report.status.upstream;
  if (!up || "gone" in up) return `git push -u origin ${report.status.branch}`;
  const forecast = report[pick];
  return forecast.outcome === "clean" && forecast.needsForcePush
    ? "git push --force-with-lease"
    : "git push";
}

async function conflictedFiles(cwd: string): Promise<string[]> {
  const out = await gitOutput(["diff", "--name-only", "--diff-filter=U"], {
    cwd,
  });
  return out.split("\n").filter(Boolean);
}

/** Did Git leave a rebase or merge in progress? */
async function inProgress(cwd: string, pick: Pick): Promise<boolean> {
  const marker = pick === "rebase" ? "rebase-merge" : "MERGE_HEAD";
  const where = await gitOutput(["rev-parse", "--git-path", marker], { cwd });
  return access(path.resolve(cwd, where)).then(
    () => true,
    () => false,
  );
}
