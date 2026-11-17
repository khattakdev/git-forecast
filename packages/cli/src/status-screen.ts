// `git forecast`: the status screen (docs/screens.md).

import type {
  IncomingCommit,
  MergeForecast,
  StatusReport,
} from "@git-forecast/core";
import { ago, clip, list, plural, type ScreenContext } from "./format.js";

const MAX_INCOMING = 10;
const OLD_STASH_SECONDS = 30 * 86400;
const STALE_FETCH_SECONDS = 86400;

export function formatStatus(report: StatusReport, ctx: ScreenContext): string {
  const { c } = ctx;
  const out: string[] = [];
  out.push(headline(report, ctx));
  out.push(upstreamLine(report, ctx));

  const { staged, unstaged, untracked } = report.local;
  if (staged.length + unstaged.length + untracked.length > 0) {
    out.push("", c.bold("Your changes"));
    for (const f of staged) out.push(`  ${c.green("staged    ")} ${f}`);
    for (const f of unstaged) out.push(`  ${c.yellow("modified  ")} ${f}`);
    for (const f of untracked) out.push(`  ${c.dim("untracked ")} ${f}`);
  }

  if (report.stashes.length > 0) {
    out.push("", c.bold("Stashes"));
    const width = Math.min(
      30,
      Math.max(...report.stashes.map((s) => stashName(s.subject).length)),
    );
    for (const stash of report.stashes) {
      const old =
        ctx.now - stash.time > OLD_STASH_SECONDS ? `  ${c.yellow("old")}` : "";
      out.push(
        `  ${clip(stashName(stash.subject), 30).padEnd(width)}  ${c.dim(ago(stash.time, ctx.now))}${old}`,
      );
    }
  }

  if (report.incoming.length > 0) {
    const prs = report.incoming.flatMap((i) =>
      i.pr === undefined ? [] : [`#${i.pr}`],
    );
    const title = `${report.base} moved ${plural(report.incoming.length, "commit")}`;
    out.push(
      "",
      c.bold(title) + (prs.length > 0 ? c.dim(` · PRs ${prs.join(" ")}`) : ""),
    );
    out.push(...incomingLines(report.incoming, ctx));
  }

  if (report.behind > 0)
    out.push("", `If you merged now: ${mergeLine(report.merge, ctx)}`);
  out.push("", nextStep(report, ctx));
  return out.join("\n");
}

export function headline(report: StatusReport, ctx: ScreenContext): string {
  const { c } = ctx;
  const behind =
    report.behind > 0
      ? c.yellow(`${report.behind} behind`)
      : c.green("0 behind");
  const { fetchedAt } = report.freshness;
  let fetched: string;
  if (fetchedAt === undefined)
    fetched = c.dim("never fetched (--fetch to update)");
  else if (ctx.now - fetchedAt > STALE_FETCH_SECONDS) {
    fetched =
      c.yellow(`fetched ${ago(fetchedAt, ctx.now)}`) +
      c.dim(" (--fetch to update)");
  } else fetched = c.dim(`fetched ${ago(fetchedAt, ctx.now)}`);
  return `${c.cyan(report.branch)} → ${report.base} · ${report.ahead} ahead, ${behind} · ${fetched}`;
}

function upstreamLine(report: StatusReport, { c }: ScreenContext): string {
  const up = report.upstream;
  if (!up) return c.dim("Not pushed yet");
  if ("gone" in up)
    return c.yellow(`${up.name} was deleted on the remote (merged?)`);
  const parts = [`Pushed to ${up.name}`];
  parts.push(
    up.ahead > 0
      ? c.yellow(`${plural(up.ahead, "commit")} not pushed`)
      : c.green("all pushed"),
  );
  if (up.behind > 0) parts.push(c.yellow(`${up.behind} new on ${up.name}`));
  return parts.join(" · ");
}

function incomingLines(
  incoming: IncomingCommit[],
  ctx: ScreenContext,
): string[] {
  const { c } = ctx;
  const shown = incoming.slice(-MAX_INCOMING); // newest are most relevant
  const subjects = shown.map((i) =>
    i.pr === undefined ? i.subject : i.subject.replace(/\s*\(#\d+\)\s*$/, ""),
  );
  const subjectWidth = Math.min(40, Math.max(...subjects.map((s) => s.length)));
  const lines = shown.map((commit, n) => {
    const pr = commit.pr === undefined ? "" : `#${commit.pr}`;
    const subject = clip(subjects[n] ?? "", subjectWidth).padEnd(subjectWidth);
    const files = list(commit.files.map((f) => f.path));
    const room = ctx.width - 2 - 5 - subjectWidth - 2;
    return `  ${pr.padEnd(5)}${subject}  ${c.dim(clip(files, Math.max(10, room)))}`;
  });
  if (incoming.length > shown.length) {
    lines.unshift(
      c.dim(`  … ${incoming.length - shown.length} earlier (--json for all)`),
    );
  }
  return lines;
}

export function mergeLine(merge: MergeForecast, { c }: ScreenContext): string {
  switch (merge.outcome) {
    case "clean":
      return c.green("clean");
    case "conflict":
      return c.red(`conflict in ${list(merge.conflictedFiles)}`);
    case "refused":
      return c.yellow(`blocked by your changes to ${list(merge.blockedBy)}`);
    case "uncertain":
      return c.yellow(`not sure: ${merge.detail ?? merge.reason}`);
  }
}

function nextStep(report: StatusReport, { c }: ScreenContext): string {
  if (report.behind === 0) {
    const up = report.upstream;
    if (up && !("gone" in up) && up.ahead > 0)
      return `${c.dim("Next:")} git push`;
    return c.green(`Up to date with ${report.base}`);
  }
  if (report.merge.outcome === "refused") {
    return `${c.dim("Next:")} git stash, then git forecast sync ${c.dim("(or git forecast sync --autostash)")}`;
  }
  return `${c.dim("Next:")} git forecast sync`;
}

/** "On feature: wip a" → "wip a"; "WIP on main: 1a2b3c msg" stays readable. */
function stashName(subject: string): string {
  return subject.replace(/^On [^:]+: /, "");
}
