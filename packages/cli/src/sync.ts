// `git forecast sync`: built in the next PR. Placeholder so the command
// already parses and reports honestly.

import type { Flags } from "./cli.js";
import type { ScreenContext } from "./format.js";

export async function runSync(
  _flags: Flags,
  ctx: ScreenContext,
): Promise<number> {
  console.log(ctx.c.yellow("git forecast sync isn't built yet."));
  return 0;
}
