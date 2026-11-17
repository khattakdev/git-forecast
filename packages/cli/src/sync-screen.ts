// `git forecast sync`: rebase and merge side by side (docs/screens.md).

import type {
  MergeForecast,
  RebaseForecast,
  SyncReport,
} from "@git-forecast/core";
import { clip, list, plural, type ScreenContext } from "./format.js";
import { headline, mergeLine } from "./status-screen.js";

/** Below this width the two options are printed one after the other. */
export const SIDE_BY_SIDE_MIN = 72;

export interface SyncView {
  /** --autostash in effect (flag or .gitforecast.json). */
  autostash: boolean;
}

/** The outcomes that would actually happen, given the autostash choice. */
export function effective(
  report: SyncReport,
  view: SyncView,
): { merge: MergeForecast; rebase: RebaseForecast } {
  return view.autostash && report.ifStashed ? report.ifStashed : report;
}

export function formatSync(
  report: SyncReport,
  ctx: ScreenContext,
  view: SyncView,
): string {
  const { c } = ctx;
  const out = [headline(report.status, ctx), ""];
  const shown = effective(report, view);

  if (report.ifStashed && view.autostash) {
    out.push(
      c.dim(
        "With --autostash: your changes are stashed, then re-applied after the sync.",
      ),
    );
    if (report.ifStashed.reapplyOverlap.length > 0) {
      out.push(
        c.yellow(
          `Re-applying them may conflict in: ${list(report.ifStashed.reapplyOverlap)}`,
        ),
      );
    }
    out.push("");
  }

  const ahead = report.status.ahead;
  const rows: [string, string[], string[]][] = [
    ["Result", rebaseResult(shown.rebase, ctx), [mergeLine(shown.merge, ctx)]],
    [
      "Rewrites",
      [rebaseRewrites(shown.rebase, ahead, ctx)],
      [c.green("nothing")],
    ],
    [
      "Force push",
      [forcePush(shown.rebase, report, ctx)],
      [forcePush(shown.merge, report, ctx)],
    ],
    [
      "History",
      [ahead === 0 ? "fast-forward" : "straight line"],
      [ahead === 0 ? "fast-forward" : "adds a merge commit"],
    ],
  ];
  out.push(
    ...(ctx.width >= SIDE_BY_SIDE_MIN
      ? sideBySide(rows, ctx)
      : stacked(rows, ctx)),
  );

  if (report.ifStashed && !view.autostash) {
    const stashed = report.ifStashed;
    out.push(
      "",
      c.yellow("Your uncommitted changes are in the way."),
      `With --autostash: rebase ${rebaseResult(stashed.rebase, ctx).join(" ")}, merge ${mergeLine(stashed.merge, ctx)}`,
      `${c.dim("Run")} git stash ${c.dim("first, or")} git forecast sync --autostash`,
    );
  }

  out.push("", recommendation(report, ctx));
  return out.join("\n");
}

function rebaseResult(rebase: RebaseForecast, { c }: ScreenContext): string[] {
  switch (rebase.outcome) {
    case "clean":
      return [c.green(`clean, ${plural(rebase.totalSteps, "step")}`)];
    case "conflict":
      return [
        c.red(`stops at step ${rebase.stoppedAtStep} of ${rebase.totalSteps}`),
        c.dim(`"${rebase.stoppedAtCommit}"`),
        c.red(`conflict in ${list(rebase.conflictedFiles)}`),
      ];
    case "refused":
      return [c.yellow("blocked by your changes")];
    case "uncertain":
      return [c.yellow(`not sure: ${rebase.detail ?? rebase.reason}`)];
  }
}

function rebaseRewrites(
  rebase: RebaseForecast,
  ahead: number,
  { c }: ScreenContext,
): string {
  if (ahead === 0) return c.green("nothing");
  const pushed =
    rebase.outcome === "clean" && rebase.rewritesPushedCommits
      ? ` (${rebase.rewritesPushedCommits} pushed)`
      : "";
  const text = `${plural(ahead, "commit")}${pushed}`;
  return pushed ? c.yellow(text) : text;
}

function forcePush(
  result: MergeForecast | RebaseForecast,
  report: SyncReport,
  { c }: ScreenContext,
): string {
  const up = report.status.upstream;
  if (!up || "gone" in up) return c.dim("not pushed yet");
  if (result.outcome !== "clean") return c.dim("—");
  return result.needsForcePush ? c.yellow("needed") : c.green("not needed");
}

function recommendation(report: SyncReport, { c }: ScreenContext): string {
  const { pick, because } = report.recommendation;
  const why =
    because === "team-rule"
      ? "team rule in .gitforecast.json"
      : pick === "merge"
        ? `${report.status.base}'s recent history uses merge commits`
        : `${report.status.base}'s history is a straight line`;
  return `${c.bold("Recommended:")} ${c.cyan(pick)} ${c.dim(`· ${why}`)}`;
}

/** Visible length, ignoring colour codes. */
function visible(text: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes
  return text.replace(/\u001b\[[0-9;]*m/g, "").length;
}

function sideBySide(
  rows: [string, string[], string[]][],
  ctx: ScreenContext,
): string[] {
  const label = 14;
  const col = Math.min(36, Math.floor((ctx.width - label) / 2));
  const pad = (text: string) =>
    text + " ".repeat(Math.max(1, col - visible(text)));
  const out = [
    `${" ".repeat(label)}${ctx.c.bold(pad("rebase"))}${ctx.c.bold("merge")}`,
  ];
  for (const [name, left, right] of rows) {
    const height = Math.max(left.length, right.length);
    for (let i = 0; i < height; i++) {
      const l = left[i] ?? "";
      const r = right[i] ?? "";
      out.push(
        `${(i === 0 ? name : "").padEnd(label)}${pad(visible(l) > col - 1 ? clip(l, col - 1) : l)}${r}`.trimEnd(),
      );
    }
  }
  return out;
}

function stacked(
  rows: [string, string[], string[]][],
  { c }: ScreenContext,
): string[] {
  const out: string[] = [];
  for (const [title, side] of [
    ["rebase", 1],
    ["merge", 2],
  ] as const) {
    out.push(c.bold(title));
    for (const row of rows) {
      const lines = row[side];
      out.push(`  ${row[0].padEnd(12)}${lines[0] ?? ""}`);
      for (const more of lines.slice(1)) out.push(`  ${"".padEnd(12)}${more}`);
    }
  }
  return out;
}

/** 0 behind: say so, and what's left to do (usually a push). */
export function formatNothingToSync(
  report: SyncReport,
  ctx: ScreenContext,
): string {
  const { c } = ctx;
  const { status } = report;
  const out = [
    headline(status, ctx),
    "",
    c.green(
      `Nothing to sync: ${status.branch} already has everything on ${status.base}.`,
    ),
  ];
  // Real git rebase still replays your commits when your branch contains
  // merges (docs/rebase-design.md); say so if that would go wrong.
  if (report.rebase.outcome === "conflict") {
    out.push(
      c.dim(
        `(Running git rebase anyway would flatten your merges and stop at step ${report.rebase.stoppedAtStep} of ${report.rebase.totalSteps}.)`,
      ),
    );
  }
  const up = status.upstream;
  if (status.ahead > 0 && (!up || "gone" in up)) {
    out.push("", `${c.dim("Next:")} git push -u origin ${status.branch}`);
  } else if (up && !("gone" in up) && up.ahead > 0) {
    out.push("", `${c.dim("Next:")} git push`);
  }
  return out.join("\n");
}

/** [d]: everything the engine knows, for when the summary isn't enough. */
export function formatDetails(report: SyncReport, ctx: ScreenContext): string {
  const { c } = ctx;
  const out = [
    c.bold(
      `${report.status.base} moved ${plural(report.status.incoming.length, "commit")}:`,
    ),
  ];
  for (const commit of report.status.incoming) {
    out.push(`  ${commit.sha.slice(0, 7)} ${commit.subject}`);
    for (const f of commit.files) {
      out.push(
        c.dim(
          `      ${f.status.padEnd(5)}${f.from ? `${f.from} → ` : ""}${f.path}`,
        ),
      );
    }
  }
  const r = report.rebase;
  if (r.outcome === "conflict") {
    out.push(
      "",
      c.bold("Rebase"),
      `  step ${r.stoppedAtStep} of ${r.totalSteps} stops: ${r.stoppedAtSha.slice(0, 7)} "${r.stoppedAtCommit}"`,
    );
    out.push(
      c.dim("  Steps after it depend on how you resolve that conflict."),
    );
  }
  if (report.ifStashed?.reapplyOverlap.length) {
    out.push(
      "",
      c.bold("Files you and the sync both change"),
      ...report.ifStashed.reapplyOverlap.map((f) => `  ${f}`),
    );
  }
  return out.join("\n");
}
