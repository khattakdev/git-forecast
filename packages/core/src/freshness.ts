// How old is the view of the remote? Git updates FETCH_HEAD on every fetch
// (and pull), so its modification time is the last fetch. Absent: never
// fetched (e.g. a fresh clone). `--git-path` finds it in worktrees too.

import { stat } from "node:fs/promises";
import path from "node:path";
import { gitOutput } from "./git.js";
import type { StatusReport } from "./types.js";

export async function readFreshness(
  cwd: string,
): Promise<StatusReport["freshness"]> {
  const file = await gitOutput(["rev-parse", "--git-path", "FETCH_HEAD"], {
    cwd,
  });
  const info = await stat(path.resolve(cwd, file)).catch(() => undefined);
  return info ? { fetchedAt: Math.floor(info.mtimeMs / 1000) } : {};
}
