#!/usr/bin/env node
// `git forecast` (run as git-forecast). Parses flags, asks the engine for a
// report, prints it. Only formats, prompts and runs Git (CLAUDE.md).

import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { coreVersion, forecastStatus, runGit } from "@git-forecast/core";
import pc from "picocolors";
import { errorJson, exitCodeFor, formatError } from "./errors.js";
import { terminalContext } from "./format.js";
import { formatStatus } from "./status-screen.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const HELP = `${pc.bold("git-forecast")}: a smarter git status that forecasts conflicts before you sync

Usage
  git forecast            your branch, what moved on main, what a merge would do
  git forecast sync       rebase and merge side by side, then run the one you pick

Options
  --json                  print the report as JSON, nothing else
  --fetch                 run git fetch first (the only network call)
  --base <branch>         compare against <branch> instead of the remote's default
  --rebase, --merge       sync: pick without the prompt
  --autostash             sync: stash your changes, sync, re-apply them
  -h, --help              show this help (git forecast --help opens Git's man page lookup; use -h)
  -v, --version           show the version
`;

const options = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  json: { type: "boolean" },
  fetch: { type: "boolean" },
  base: { type: "string" },
  rebase: { type: "boolean" },
  merge: { type: "boolean" },
  autostash: { type: "boolean" },
} as const;

export type Flags = ReturnType<typeof parse>["values"];

function parse(argv: string[]) {
  return parseArgs({ args: argv, options, allowPositionals: true });
}

async function main(argv: string[]): Promise<number> {
  const ctx = terminalContext();
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    console.error(formatError(error, ctx.c));
    console.error("Run git forecast -h for usage.");
    return 1;
  }
  const flags = parsed.values;
  const [command, ...extra] = parsed.positionals;

  if (flags.version) {
    console.log(`git-forecast ${version} (core ${coreVersion})`);
    return 0;
  }
  if (flags.help) {
    console.log(HELP);
    return 0;
  }
  if (extra.length > 0 || (command !== undefined && command !== "sync")) {
    console.error(
      formatError(`unknown command "${parsed.positionals.join(" ")}"`, ctx.c),
    );
    console.error("Run git forecast -h for usage.");
    return 1;
  }

  try {
    if (flags.fetch) await fetch(flags.json === true);
    const base = flags.base ? { base: flags.base } : {};
    if (command === "sync") {
      const { runSync } = await import("./sync.js");
      return await runSync(flags, ctx);
    }
    const report = await forecastStatus(base);
    console.log(
      flags.json ? JSON.stringify(report, null, 2) : formatStatus(report, ctx),
    );
    return 0;
  } catch (error) {
    if (flags.json) console.log(errorJson(error));
    else console.error(formatError(error, ctx.c));
    return exitCodeFor(error);
  }
}

/** `git fetch --quiet`: the only network call, and only when asked. */
async function fetch(quiet: boolean): Promise<void> {
  if (!quiet && process.stderr.isTTY)
    process.stderr.write(pc.dim("Fetching…\n"));
  await runGit(["fetch", "--quiet"], {
    cwd: process.cwd(),
    timeoutMs: 120_000,
  });
}

process.exitCode = await main(process.argv.slice(2));
