// The engine's two public entry points. Each runs the modules in as few
// rounds as possible and returns one plain report:
//
//   round 1: repo.ts                       (branch, upstream, base)
//   round 2: status, incoming, freshness   (+ config for sync), at once
//   round 3: merge, push (+ rebase, recommend for sync), at once
//
// Front ends (the CLI now, others later) only call these two functions.

import { readConfig } from "./config.js";
import { readFreshness } from "./freshness.js";
import { readIncoming } from "./incoming.js";
import { type MergeParts, readMerge } from "./merge.js";
import { readPush, withMergePush, withRebasePush } from "./push.js";
import { readRebase } from "./rebase.js";
import { recommend } from "./recommend.js";
import { type RepoInfo, readRepo } from "./repo.js";
import { readStatus, type StatusParts } from "./status.js";
import { SCHEMA_VERSION, type StatusReport, type SyncReport } from "./types.js";

export interface ForecastOptions {
  /** Any folder inside the repo. Default: the current folder. */
  cwd?: string;
  /** Compare against this instead of the remote's default branch (--base). */
  base?: string;
}

/** Everything `git forecast` shows. */
export async function forecastStatus(
  options: ForecastOptions = {},
): Promise<StatusReport> {
  const cwd = options.cwd ?? process.cwd();
  const repo = await readRepo(
    options.base ? { cwd, base: options.base } : { cwd },
  );
  const [status, incoming, freshness] = await Promise.all([
    readStatus({ cwd, repo }),
    readIncoming({ cwd, base: repo.base }),
    readFreshness(cwd),
  ]);
  const [merge, push] = await Promise.all([
    mergeOf(cwd, repo, status),
    readPush({
      cwd,
      base: repo.base,
      upstream: status.upstream,
      behind: status.behind,
    }),
  ]);
  return report(
    repo,
    status,
    incoming,
    freshness,
    withMergePush(merge.merge, push),
  );
}

/** Everything `git forecast sync` shows: merge and rebase side by side. */
export async function forecastSync(
  options: ForecastOptions = {},
): Promise<SyncReport> {
  const cwd = options.cwd ?? process.cwd();
  const repo = await readRepo(
    options.base ? { cwd, base: options.base } : { cwd },
  );
  const [status, incoming, freshness, config] = await Promise.all([
    readStatus({ cwd, repo }),
    readIncoming({ cwd, base: repo.base }),
    readFreshness(cwd),
    readConfig(cwd),
  ]);
  const [merge, rebase, push, recommendation] = await Promise.all([
    mergeOf(cwd, repo, status),
    readRebase({ cwd, base: repo.base, local: status.local }),
    readPush({
      cwd,
      base: repo.base,
      upstream: status.upstream,
      behind: status.behind,
    }),
    recommend({ cwd, base: repo.base, config }),
  ]);

  const mergeForecast = withMergePush(merge.merge, push);
  const sync: SyncReport = {
    schemaVersion: SCHEMA_VERSION,
    status: report(repo, status, incoming, freshness, mergeForecast),
    merge: mergeForecast,
    rebase: withRebasePush(rebase.rebase, push),
    recommendation,
    config,
  };
  if (merge.ifStashed || rebase.ifStashed) {
    sync.ifStashed = {
      merge: withMergePush(merge.ifStashed ?? merge.merge, push),
      rebase: withRebasePush(rebase.ifStashed ?? rebase.rebase, push),
      // A clean rebase and a clean merge end on the same files, so the
      // merge's overlap serves both (docs/rebase-design.md).
      reapplyOverlap: merge.reapplyOverlap ?? [],
    };
  }
  return sync;
}

function mergeOf(
  cwd: string,
  repo: RepoInfo,
  status: StatusParts,
): Promise<MergeParts> {
  return readMerge({
    cwd,
    base: repo.base,
    ahead: status.ahead,
    behind: status.behind,
    local: status.local,
  });
}

function report(
  repo: RepoInfo,
  status: StatusParts,
  incoming: StatusReport["incoming"],
  freshness: StatusReport["freshness"],
  merge: StatusReport["merge"],
): StatusReport {
  const result: StatusReport = {
    schemaVersion: SCHEMA_VERSION,
    branch: repo.branch,
    base: repo.base,
    ahead: status.ahead,
    behind: status.behind,
    local: status.local,
    stashes: status.stashes,
    incoming,
    merge,
    freshness,
  };
  if (status.upstream) result.upstream = status.upstream;
  return result;
}
