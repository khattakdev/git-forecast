#!/usr/bin/env node
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { coreVersion } from "@git-forecast/core";
import pc from "picocolors";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const HELP = `${pc.bold("git-forecast")}: a smarter git status that forecasts conflicts before you sync

Usage
  git forecast            status of your branch (coming in v0)
  git forecast sync       compare rebase and merge (coming in v0)

Options
  -h, --help              show this help
  -v, --version           show the version
`;

const options = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

function parse(argv: string[]) {
  return parseArgs({ args: argv, options, allowPositionals: true });
}

function main(argv: string[]): number {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    console.error(pc.red((error as Error).message));
    console.error("Run git forecast -h for usage.");
    return 1;
  }

  if (parsed.values.version) {
    console.log(`git-forecast ${version} (core ${coreVersion})`);
    return 0;
  }
  if (parsed.values.help) {
    console.log(HELP);
    return 0;
  }

  const [command] = parsed.positionals;
  const what = command ? `"${command}"` : "The status screen";
  console.log(
    `${pc.yellow(`${what} isn't built yet.`)} Run git forecast -h to see what's planned.`,
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
