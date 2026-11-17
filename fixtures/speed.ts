// Speed test: times each Git command the engine will run (build guide,
// Step 6 table) on a blobless clone of a large public repo, against the
// 300 ms budget.
//
//   npm run speed
//   npm run speed -- --repo https://github.com/git/git.git
//   npm run speed -- --dir <path> --runs 20 --behind 200 --commits 20
//
// Needs the network for the first clone (and a fetch on later runs), so it
// is not part of `npm run fixtures` or CI. The clone is cached and reused.
//
// Each timing includes starting the `git` process, because the engine pays
// that too. One untimed warm-up run per command absorbs the blob downloads a
// blobless clone does on first use, so network time doesn't skew the numbers.
// `commit-tree` (rebase simulation) writes unreferenced objects into the
// throwaway clone only.

import { mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { git, makeClock, run } from "./git.ts";

const BRANCH = "forecast-speed";
const BUDGET_MS = 300;

interface Timing {
  label: string;
  module: string;
  median: number;
  max: number;
  /** Part of the plain `git forecast` status screen (vs only `sync`). */
  status: boolean;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

async function time(
  runs: number,
  fn: () => Promise<unknown>,
): Promise<{ median: number; max: number }> {
  await fn(); // warm-up: fetches any missing blobs, fills OS caches
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const mid = Math.floor(samples.length / 2);
  const median =
    samples.length % 2 === 1
      ? (samples[mid] ?? 0)
      : ((samples[mid - 1] ?? 0) + (samples[mid] ?? 0)) / 2;
  return { median, max: samples[samples.length - 1] ?? 0 };
}

/** merge-tree may exit 1 for "conflicts", which is a valid answer here. */
async function mergeTree(repo: string, args: string[]): Promise<string> {
  const result = await run(repo, ["merge-tree", "--write-tree", ...args]);
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(`git merge-tree exited ${result.code}\n${result.stderr}`);
  }
  return result.stdout;
}

/** rebase.ts in miniature: replay each commit with merge-tree + commit-tree. */
async function simulateRebase(repo: string, base: string): Promise<number> {
  const mergeBase = await git(repo, ["merge-base", "HEAD", base]);
  const commits = (
    await git(repo, ["rev-list", "--reverse", `${mergeBase}..HEAD`])
  )
    .split("\n")
    .filter(Boolean);
  let tip = await git(repo, ["rev-parse", base]);
  for (const commit of commits) {
    const out = await mergeTree(repo, [`--merge-base=${commit}^`, tip, commit]);
    const tree = out.split("\n")[0] ?? "";
    tip = await git(repo, ["commit-tree", tree, "-p", tip, "-m", "simulated"]);
  }
  return commits.length;
}

async function prepare(
  repo: string,
  dir: string,
  behind: number,
  commits: number,
): Promise<string> {
  if (await exists(path.join(dir, ".git"))) {
    console.log(`Reusing ${dir}, fetching…`);
    await git(dir, ["fetch", "--quiet", "--no-tags", "origin"]);
  } else {
    console.log(`Cloning ${repo} (blobless) into ${dir}…`);
    await mkdir(path.dirname(dir), { recursive: true });
    const start = performance.now();
    await git(path.dirname(dir), [
      "clone",
      "--quiet",
      "--filter=blob:none",
      "--no-tags",
      repo,
      dir,
    ]);
    console.log(
      `Cloned in ${((performance.now() - start) / 1000).toFixed(1)} s`,
    );
  }
  const base = (
    await git(dir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
  ).trim();

  // A branch that forked `behind` commits ago, with `commits` of its own in a
  // folder main never touches, so every rebase step is clean (slowest case).
  await git(dir, [
    "switch",
    "--quiet",
    "--discard-changes",
    "-C",
    BRANCH,
    `${base}~${behind}`,
  ]);
  await git(dir, ["branch", "--quiet", `--set-upstream-to=${base}`]);
  const clock = makeClock();
  await mkdir(path.join(dir, BRANCH), { recursive: true });
  for (let i = 1; i <= commits; i++) {
    const file = `${BRANCH}/file-${i}.txt`;
    await writeFile(path.join(dir, file), `change ${i}\n`, "utf8");
    await git(dir, ["add", file]);
    await git(dir, ["commit", "--quiet", "-m", `Speed test ${i}`], clock());
  }
  return base;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      repo: {
        type: "string",
        default: "https://github.com/facebook/react.git",
      },
      dir: { type: "string" },
      runs: { type: "string", default: "10" },
      behind: { type: "string", default: "200" },
      commits: { type: "string", default: "20" },
    },
  });
  const name = path.basename(values.repo, ".git");
  const dir = path.resolve(
    values.dir ?? path.join(os.tmpdir(), "git-forecast-speed", name),
  );
  const runs = Number(values.runs);
  const base = await prepare(
    values.repo,
    dir,
    Number(values.behind),
    Number(values.commits),
  );

  const mergeBase = await git(dir, ["merge-base", "HEAD", base]);
  const commands: [string, string, boolean, () => Promise<unknown>][] = [
    [
      "repo",
      "rev-parse --abbrev-ref HEAD",
      true,
      () => git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]),
    ],
    [
      "repo",
      "rev-parse --abbrev-ref @{u}",
      true,
      () => git(dir, ["rev-parse", "--abbrev-ref", "@{u}"]),
    ],
    [
      "repo",
      "symbolic-ref refs/remotes/origin/HEAD",
      true,
      () => git(dir, ["symbolic-ref", "refs/remotes/origin/HEAD"]),
    ],
    [
      "status",
      "status --porcelain=v2 --branch",
      true,
      () => git(dir, ["status", "--porcelain=v2", "--branch"]),
    ],
    [
      "status",
      `rev-list --left-right --count ${base}...HEAD`,
      true,
      () => git(dir, ["rev-list", "--left-right", "--count", `${base}...HEAD`]),
    ],
    [
      "status",
      "stash list --format=%ct",
      true,
      () => git(dir, ["stash", "list", "--format=%ct"]),
    ],
    [
      "incoming",
      `merge-base HEAD ${base}`,
      true,
      () => git(dir, ["merge-base", "HEAD", base]),
    ],
    [
      "incoming",
      `log --name-only <base>..${base}`,
      true,
      () => git(dir, ["log", "--name-only", `${mergeBase}..${base}`]),
    ],
    [
      "merge",
      `merge-tree --write-tree --name-only ${base} HEAD`,
      true,
      () => mergeTree(dir, ["--name-only", base, "HEAD"]),
    ],
    [
      "rebase",
      "simulation: merge-tree + commit-tree per commit",
      false,
      () => simulateRebase(dir, base),
    ],
    [
      "recommend",
      `rev-list --merges --first-parent --since=90.days ${base} --count`,
      false,
      () =>
        git(dir, [
          "rev-list",
          "--merges",
          "--first-parent",
          "--since=90.days",
          base,
          "--count",
        ]),
    ],
  ];

  console.log(
    `Timing ${commands.length} commands, ${runs} runs each after a warm-up…\n`,
  );
  const timings: Timing[] = [];
  for (const [module, label, status, fn] of commands) {
    const { median, max } = await time(runs, fn);
    timings.push({ module, label, status, median, max });
  }

  const totalCommits = await git(dir, ["rev-list", "--count", base]);
  const steps = (
    await git(dir, ["rev-list", "--count", `${mergeBase}..HEAD`])
  ).trim();
  const behindCount = (
    await git(dir, ["rev-list", "--count", `HEAD..${base}`])
  ).trim();
  const tip = await git(dir, ["rev-parse", "--short", base]);
  const version = await git(dir, ["--version"]);
  const width = Math.max(...timings.map((t) => t.label.length));
  const fmt = (ms: number) => `${ms.toFixed(1).padStart(7)} ms`;

  console.log(
    `Repo:    ${values.repo} (${totalCommits} commits on ${base} @ ${tip})`,
  );
  console.log(
    `Branch:  ${BRANCH}, ${steps} ahead / ${behindCount} behind ${base}`,
  );
  console.log(
    `Git:     ${version}; Node ${process.version}; ${os.platform()} ${os.arch()}\n`,
  );
  console.log(
    `${"module".padEnd(10)} ${"command".padEnd(width)} ${"median".padStart(10)} ${"max".padStart(10)}`,
  );
  for (const t of timings) {
    console.log(
      `${t.module.padEnd(10)} ${t.label.padEnd(width)} ${fmt(t.median)} ${fmt(t.max)}`,
    );
  }
  const rebase = timings.find((t) => t.module === "rebase");
  if (rebase) {
    console.log(
      `\nRebase simulation per step: ${fmt(rebase.median / Number(steps))}`,
    );
  }
  const sum = (list: Timing[]) => list.reduce((acc, t) => acc + t.median, 0);
  const statusTotal = sum(timings.filter((t) => t.status));
  const syncTotal = sum(timings);
  const verdict = (ms: number) => (ms <= BUDGET_MS ? "within" : "OVER");
  console.log(
    `\nSum of medians, run one after another (the engine may run some in parallel):`,
  );
  console.log(
    `  git forecast       ${fmt(statusTotal)}  ${verdict(statusTotal)} the ${BUDGET_MS} ms budget`,
  );
  console.log(
    `  git forecast sync  ${fmt(syncTotal)}  ${verdict(syncTotal)} the ${BUDGET_MS} ms budget`,
  );
  await timeEngine(dir, runs, fmt);
  console.log(`\nClone kept at ${dir}`);
}

/**
 * The real engine end to end, if it's built (npm run build). Loaded at run
 * time from packages/core/dist, so the fixtures never depend on the engine's
 * source; this part only measures it.
 */
async function timeEngine(
  dir: string,
  runs: number,
  fmt: (ms: number) => string,
): Promise<void> {
  const entry = path.resolve(
    import.meta.dirname,
    "../packages/core/dist/index.js",
  );
  const core = await import(pathToFileURL(entry).href).catch(() => undefined);
  if (!core) {
    console.log(
      "\nEngine not built; run `npm run build` to time it end to end.",
    );
    return;
  }
  console.log(
    "\nThe engine end to end (Git calls run in parallel where possible):",
  );
  for (const name of ["forecastStatus", "forecastSync"] as const) {
    const { median, max } = await time(runs, () => core[name]({ cwd: dir }));
    const verdict = median <= BUDGET_MS ? "within" : "OVER";
    console.log(
      `  ${name.padEnd(15)} ${fmt(median)} median, ${fmt(max)} max  ${verdict} the ${BUDGET_MS} ms budget`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
