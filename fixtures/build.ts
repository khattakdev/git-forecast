// Builds throwaway Git repos with known outcomes, then asks real Git what
// happens when you rebase or merge them. The answers go to
// fixtures/expected/<name>.json and are the ground truth for the engine.
//
//   npm run fixtures                      build every scenario, write expected files
//   npm run fixtures -- clean             build only the named scenarios
//   npm run fixtures -- --out <dir>       build into <dir> instead of a temp folder
//   npm run fixtures -- --check           fail if real Git disagrees with expected/
//
// Runs with plain `node` (type stripping, Node 22.18+), so this file uses only
// erasable TypeScript syntax and no relative imports.
//
// Git calls here use their own small helper rather than packages/core/src/git.ts:
// this is dev tooling, it must not depend on the code it is testing, and it
// needs extra isolation (no user or system config) that the engine must not have.

import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs, promisify } from "node:util";

const execFileAsync = promisify(execFile);
const FIXTURES_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXPECTED_DIR = path.join(FIXTURES_DIR, "expected");

// ---------------------------------------------------------------------------
// Scenarios

/** File path → full contents. Contents are written as-is (LF only). */
type Files = Record<string, string>;

interface Commit {
  subject: string;
  files: Files;
}

interface Scenario {
  name: string;
  description: string;
  /** The first commit on main, shared by everyone. */
  base: Files;
  /** Pushed to origin/main by a teammate after the base. */
  incoming: Commit[];
  /** Your commits on `feature`, branched from the base. Not pushed. */
  feature: Commit[];
}

const lines = (...l: string[]): string => `${l.join("\n")}\n`;

export const scenarios: Scenario[] = [
  {
    name: "clean",
    description: "main moved, no files overlap",
    base: {
      "README.md": lines("# clean fixture"),
      "src/a.txt": lines("alpha 1", "alpha 2", "alpha 3"),
      "src/b.txt": lines("bravo 1", "bravo 2", "bravo 3"),
    },
    incoming: [
      {
        subject: "Update b",
        files: { "src/b.txt": lines("bravo 1", "bravo 2 (main)", "bravo 3") },
      },
      { subject: "Add docs", files: { "docs/c.txt": lines("charlie") } },
    ],
    feature: [
      {
        subject: "Edit a",
        files: {
          "src/a.txt": lines("alpha 1", "alpha 2 (feature)", "alpha 3"),
        },
      },
      { subject: "Add d", files: { "src/d.txt": lines("delta") } },
    ],
  },
];

// ---------------------------------------------------------------------------
// Git, isolated from whoever runs this

// Drop inherited GIT_* variables (GIT_DIR, GIT_INDEX_FILE, ... set by hooks),
// then ignore user and system config so settings like rerere, rebase.autoStash,
// rebase.updateRefs or core.autocrlf can't change the outcome.
const baseEnv: NodeJS.ProcessEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.toUpperCase().startsWith("GIT_"),
  ),
);
const gitConfig: Record<string, string> = {
  "user.name": "Fixture Author",
  "user.email": "fixture@example.com",
  "init.defaultBranch": "main",
  "core.autocrlf": "false",
  "commit.gpgsign": "false",
  "merge.conflictStyle": "merge",
};
const ENV: NodeJS.ProcessEnv = {
  ...baseEnv,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_COUNT: String(Object.keys(gitConfig).length),
  ...Object.fromEntries(
    Object.entries(gitConfig).flatMap(([key, value], i) => [
      [`GIT_CONFIG_KEY_${i}`, key],
      [`GIT_CONFIG_VALUE_${i}`, value],
    ]),
  ),
  GIT_EDITOR: "true",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
};

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs Git and returns its exit code instead of throwing on non-zero. */
async function run(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      env: { ...ENV, ...env },
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code !== "number") throw error; // git missing, bad cwd, ...
    return { code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** Runs Git, throws on non-zero, returns trimmed stdout. */
async function git(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await run(cwd, args, env);
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} exited ${result.code} in ${cwd}\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

/** Fixed, increasing timestamps so every build produces the same commits. */
function makeClock(): () => NodeJS.ProcessEnv {
  let tick = 0;
  return () => {
    const date = `${1767225600 + tick++ * 60} +0000`; // 2026-01-01T00:00:00Z + n minutes
    return { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  };
}

// ---------------------------------------------------------------------------
// Building

async function writeFiles(repo: string, files: Files): Promise<void> {
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(repo, ...file.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
  }
}

async function commit(
  repo: string,
  { subject, files }: Commit,
  clock: () => NodeJS.ProcessEnv,
): Promise<void> {
  await writeFiles(repo, files);
  await git(repo, ["add", "--all"]);
  await git(repo, ["commit", "--quiet", "-m", subject], clock());
}

/** Clones origin and writes the isolation settings into the clone's own config,
 *  so later tests running plain Git in it behave the same as this script. */
async function clone(origin: string, dir: string): Promise<void> {
  await git(path.dirname(dir), ["clone", "--quiet", origin, dir]);
  for (const key of [
    "user.name",
    "user.email",
    "core.autocrlf",
    "commit.gpgsign",
  ]) {
    await git(dir, ["config", key, gitConfig[key] ?? ""]);
  }
}

function findScenario(name: string): Scenario {
  const scenario = scenarios.find((s) => s.name === name);
  if (!scenario) throw new Error(`Unknown scenario "${name}"`);
  return scenario;
}

/**
 * Builds `<dir>/origin.git` (bare, acts as origin), `<dir>/teammate` (pushed
 * the incoming commits) and `<dir>/work` (on `feature`, origin/main fetched,
 * local main left at the base like someone who hasn't pulled).
 * Returns the path of the `work` repo. Replaces `dir` if it exists.
 */
export async function buildScenario(
  name: string,
  dir: string,
): Promise<string> {
  const scenario = findScenario(name);
  const clock = makeClock();
  const origin = path.join(dir, "origin.git");
  const work = path.join(dir, "work");
  const teammate = path.join(dir, "teammate");

  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "--quiet", "--bare", "-b", "main", origin]);

  await clone(origin, work);
  await commit(
    work,
    { subject: "Initial commit", files: scenario.base },
    clock,
  );
  await git(work, ["push", "--quiet", "-u", "origin", "main"]);

  await clone(origin, teammate);
  for (const c of scenario.incoming) await commit(teammate, c, clock);
  await git(teammate, ["push", "--quiet", "origin", "main"]);

  await git(work, ["switch", "--quiet", "-c", "feature"]);
  for (const c of scenario.feature) await commit(work, c, clock);
  await git(work, ["fetch", "--quiet", "origin"]);

  return work;
}

// ---------------------------------------------------------------------------
// The judge: real Git, on a throwaway copy

const BASE = "origin/main";
const BRANCH = "feature";

type Outcome = "clean" | "conflict";

export interface Expected {
  scenario: string;
  description: string;
  branch: string;
  base: string;
  ahead: number;
  behind: number;
  merge: { outcome: Outcome; conflictedFiles?: string[] };
  rebase: {
    outcome: Outcome;
    /** Commits real Git replayed (clean) or planned to replay (conflict). */
    totalSteps: number;
    stoppedAtStep?: number;
    stoppedAtCommit?: string;
    conflictedFiles?: string[];
  };
}

async function conflictedFiles(repo: string): Promise<string[]> {
  const out = await git(repo, ["diff", "--name-only", "--diff-filter=U"]);
  return out.split("\n").filter(Boolean).sort();
}

async function hasUnmergedEntries(repo: string): Promise<boolean> {
  return (await git(repo, ["ls-files", "--unmerged"])) !== "";
}

async function judgeRebase(repo: string): Promise<Expected["rebase"]> {
  const result = await run(repo, ["rebase", BASE], makeClock()());
  if (result.code === 0) {
    const count = await git(repo, ["rev-list", "--count", `${BASE}..HEAD`]);
    return { outcome: "clean", totalSteps: Number(count) };
  }

  // Stopped. Make sure it stopped on a conflict, not on something else.
  const stateDir = path.resolve(
    repo,
    await git(repo, ["rev-parse", "--git-path", "rebase-merge"]),
  );
  const read = async (file: string) =>
    (await readFile(path.join(stateDir, file), "utf8")).trim();
  if (!(await hasUnmergedEntries(repo))) {
    throw new Error(
      `git rebase stopped without a conflict in ${repo}\n${result.stderr}`,
    );
  }
  return {
    outcome: "conflict",
    totalSteps: Number(await read("end")),
    stoppedAtStep: Number(await read("msgnum")),
    stoppedAtCommit: await git(repo, [
      "log",
      "-1",
      "--format=%s",
      "REBASE_HEAD",
    ]),
    conflictedFiles: await conflictedFiles(repo),
  };
}

async function judgeMerge(repo: string): Promise<Expected["merge"]> {
  const result = await run(repo, ["merge", "--no-edit", BASE], makeClock()());
  if (result.code === 0) return { outcome: "clean" };
  if (result.code === 1 && (await hasUnmergedEntries(repo))) {
    return {
      outcome: "conflict",
      conflictedFiles: await conflictedFiles(repo),
    };
  }
  throw new Error(
    `git merge failed without a conflict in ${repo}\n${result.stderr}`,
  );
}

/** Copies `work` twice, runs real `git rebase` and `git merge`, records what happened. */
export async function judge(name: string, work: string): Promise<Expected> {
  const scenario = findScenario(name);
  const current = await git(work, ["branch", "--show-current"]);
  if (current !== BRANCH)
    throw new Error(`${work} is on "${current}", expected "${BRANCH}"`);

  const counts = await git(work, [
    "rev-list",
    "--left-right",
    "--count",
    `${BASE}...${BRANCH}`,
  ]);
  const [behind, ahead] = counts.split(/\s+/).map(Number);

  const scratch = await mkdtemp(path.join(os.tmpdir(), "git-forecast-judge-"));
  try {
    const rebaseCopy = path.join(scratch, "rebase");
    const mergeCopy = path.join(scratch, "merge");
    await cp(work, rebaseCopy, { recursive: true });
    await cp(work, mergeCopy, { recursive: true });
    return {
      scenario: name,
      description: scenario.description,
      branch: BRANCH,
      base: BASE,
      ahead: ahead ?? 0,
      behind: behind ?? 0,
      merge: await judgeMerge(mergeCopy),
      rebase: await judgeRebase(rebaseCopy),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
}

// ---------------------------------------------------------------------------
// CLI

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      check: { type: "boolean", default: false },
    },
  });
  const names =
    positionals.length > 0 ? positionals : scenarios.map((s) => s.name);
  names.forEach(findScenario); // fail fast on typos

  const root = values.out
    ? path.resolve(values.out)
    : await mkdtemp(path.join(os.tmpdir(), "git-forecast-fixtures-"));
  await mkdir(EXPECTED_DIR, { recursive: true });

  let failures = 0;
  for (const name of names) {
    const work = await buildScenario(name, path.join(root, name));
    const actual = await judge(name, work);
    const expectedFile = path.join(EXPECTED_DIR, `${name}.json`);
    const json = `${JSON.stringify(actual, null, 2)}\n`;

    if (values.check) {
      const committed = await readFile(expectedFile, "utf8").catch(() => null);
      if (
        committed !== null &&
        isDeepStrictEqual(JSON.parse(committed), actual)
      ) {
        console.log(`ok    ${name}`);
      } else {
        failures++;
        console.error(
          `FAIL  ${name}: real Git disagrees with ${path.relative(process.cwd(), expectedFile)}`,
        );
        console.error(json);
      }
    } else {
      await writeFile(expectedFile, json, "utf8");
      console.log(`built ${name.padEnd(20)} ${work}`);
    }
  }

  if (values.check && !values.out)
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  else console.log(`\nRepos are in ${root}`);
  return failures === 0 ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
