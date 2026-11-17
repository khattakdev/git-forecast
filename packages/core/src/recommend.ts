// Rebase or merge? The team's rule first (.gitforecast.json "sync"); else
// the base branch's history shape (decision D5): if merge commits landed on
// its first-parent line in the last 90 days, the team merges; otherwise the
// history is kept straight, so rebase.

import type { ForecastConfig } from "./config.js";
import { gitOutput } from "./git.js";
import type { Recommendation } from "./types.js";

export interface RecommendOptions {
  cwd: string;
  base: string;
  config: ForecastConfig;
}

export async function recommend({
  cwd,
  base,
  config,
}: RecommendOptions): Promise<Recommendation> {
  if (config.sync) return { pick: config.sync, because: "team-rule" };
  const merges = await gitOutput(
    [
      "rev-list",
      "--count",
      "--merges",
      "--first-parent",
      "--since=90.days",
      base,
    ],
    { cwd },
  );
  return {
    pick: Number(merges) > 0 ? "merge" : "rebase",
    because: "history-shape",
  };
}
