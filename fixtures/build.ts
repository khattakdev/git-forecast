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
// erasable TypeScript syntax, and relative imports end in `.ts`.
// Git calls go through ./git.ts (see why there).

import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { git, gitConfig, makeClock, run } from "./git.ts";

const FIXTURES_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXPECTED_DIR = path.join(FIXTURES_DIR, "expected");

// ---------------------------------------------------------------------------
// Scenarios

/** File path → full contents. Contents are written as-is (LF only). */
type Files = Record<string, string>;

interface Commit {
  subject: string;
  files: Files;
  /** Old path → new path, done with `git mv` before `files` are written. */
  renames?: Record<string, string>;
}

interface Scenario {
  name: string;
  description: string;
  /** The first commit on main, shared by everyone. */
  base: Files;
  /** Pushed to origin/main by a teammate after the base. */
  incoming: Commit[];
  /** Your commits on `feature`, branched from the base. */
  feature: Commit[];
  /** Push the first N feature commits with `-u` before making the rest.
   *  Leave out for a branch that was never pushed (no upstream). */
  pushed?: number;
  /** Also record what came in on main and what your side changes after a
   *  clean merge or rebase (`incoming` and `changes` in the expected file). */
  detail?: boolean;
  /** Uncommitted state made after the commits: stashes first (each saved
   *  with `git stash push` at its own fixed date), then edits to tracked
   *  files left unstaged, then new untracked files. */
  local?: {
    stashes?: { message: string; date: number; files: Files }[];
    unstaged?: Files;
    untracked?: Files;
  };
}

const BASE = "origin/main";
const BRANCH = "feature";

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
  {
    name: "conflict-step-2",
    description: "rebase stops at your second commit; merge conflicts too",
    base: {
      "app.txt": appLines("greeting = hello"),
      "notes.txt": lines("todo: nothing yet"),
    },
    incoming: [
      {
        subject: "Reword greeting in app",
        files: { "app.txt": appLines("greeting = hi there") },
      },
    ],
    // Step 1 is clean, step 2 conflicts with main, step 3 comes after the
    // first conflict (the engine must call that one "uncertain").
    feature: [
      {
        subject: "Update notes",
        files: { "notes.txt": lines("todo: ship it") },
      },
      {
        subject: "Change greeting in app",
        files: { "app.txt": appLines("greeting = good morning") },
      },
      { subject: "Add extra file", files: { "extra.txt": lines("extra") } },
    ],
  },
  {
    name: "rebase-only-conflict",
    description:
      "merge would be clean, but an intermediate rebase step conflicts",
    base: {
      "app.txt": appLines("greeting = hello"),
      "notes.txt": lines("todo: nothing yet"),
    },
    incoming: [
      {
        subject: "Reword greeting in app",
        files: { "app.txt": appLines("greeting = hi there") },
      },
    ],
    // You try a change and then undo it. Overall your branch leaves app.txt
    // as it was at the base, so a merge just takes main's line. A rebase
    // replays step 2 (hello → howdy) onto "hi there" and conflicts.
    feature: [
      {
        subject: "Update notes",
        files: { "notes.txt": lines("todo: ship it") },
      },
      {
        subject: "Try a new greeting",
        files: { "app.txt": appLines("greeting = howdy") },
      },
      {
        subject: "Revert greeting",
        files: { "app.txt": appLines("greeting = hello") },
      },
    ],
  },
  {
    name: "pushed-branch",
    description: "your branch is on origin, so rebase means a force push",
    base: {
      "README.md": lines("# pushed-branch fixture"),
      "src/a.txt": lines("alpha 1", "alpha 2", "alpha 3"),
      "src/b.txt": lines("bravo 1", "bravo 2", "bravo 3"),
    },
    incoming: [
      {
        subject: "Update b",
        files: { "src/b.txt": lines("bravo 1", "bravo 2 (main)", "bravo 3") },
      },
    ],
    // No overlap, so the rebase is clean and the push can be tested. The
    // first two commits are on origin/feature; the third is not pushed yet.
    feature: [
      {
        subject: "Edit a",
        files: {
          "src/a.txt": lines("alpha 1", "alpha 2 (feature)", "alpha 3"),
        },
      },
      { subject: "Add d", files: { "src/d.txt": lines("delta") } },
      { subject: "Add e", files: { "src/e.txt": lines("echo") } },
    ],
    pushed: 2,
  },
  {
    name: "squash-prs",
    description: "main has squash-merged PRs with (#123) in their subjects",
    base: {
      "README.md": lines("# squash-prs fixture"),
      "src/app.txt": lines("app 1", "app 2"),
      "src/login.txt": lines("login: todo"),
      "version.txt": lines("1.0.0"),
    },
    // Realistic GitHub subjects. Which number is the PR is our own parsing
    // rule, not a Git outcome, so it is not in the expected file; Step 6
    // unit-tests it against these subjects as recorded by `git log`.
    incoming: [
      {
        subject: "Add login page (#12)",
        files: { "src/login.txt": lines("login: form") },
      },
      {
        subject: "Explain #7 in README (#15)",
        files: { "README.md": lines("# squash-prs fixture", "", "See #7.") },
      },
      { subject: "Bump version", files: { "version.txt": lines("1.1.0") } },
      {
        subject: 'Revert "Add login page (#12)" (#18)',
        files: { "src/login.txt": lines("login: todo") },
      },
    ],
    feature: [
      {
        subject: "Edit app",
        files: { "src/app.txt": lines("app 1", "app 2 (feature)") },
      },
      { subject: "Add notes", files: { "notes.txt": lines("notes") } },
    ],
    detail: true,
  },
  {
    name: "rename",
    description: "main renames a file you edited",
    base: {
      "README.md": lines("# rename fixture"),
      "config.txt": lines(
        "name = demo",
        "port = 8080",
        "debug = false",
        "timeout = 30",
        "retries = 3",
        "log = info",
      ),
    },
    // A pure rename on main (100% similar), so Git's rename detection should
    // carry your edit over to the new path. `changes` shows where it landed.
    incoming: [
      {
        subject: "Move config to src/settings.txt",
        files: {},
        renames: { "config.txt": "src/settings.txt" },
      },
    ],
    feature: [
      {
        subject: "Change port",
        files: {
          "config.txt": lines(
            "name = demo",
            "port = 9090",
            "debug = false",
            "timeout = 30",
            "retries = 3",
            "log = info",
          ),
        },
      },
      { subject: "Add x", files: { "x.txt": lines("x") } },
    ],
    detail: true,
  },
  {
    name: "messy-local",
    description: "uncommitted changes, unpushed commits, old stashes",
    base: {
      "README.md": lines("# messy-local fixture"),
      "notes.txt": lines("notes"),
      "src/a.txt": lines("alpha 1", "alpha 2", "alpha 3"),
      "src/b.txt": lines("bravo 1", "bravo 2", "bravo 3"),
    },
    incoming: [
      {
        subject: "Update b",
        files: { "src/b.txt": lines("bravo 1", "bravo 2 (main)", "bravo 3") },
      },
    ],
    // Commits never touch src/b.txt, so judged on commits alone (ifStashed)
    // everything is clean. The uncommitted edit to src/b.txt overlaps main,
    // so merge refuses; the notes.txt edit alone would not stop a merge.
    // Nothing is staged: a staged file makes merge refuse on that file alone
    // and would hide the overlap rule.
    feature: [
      {
        subject: "Edit a",
        files: {
          "src/a.txt": lines("alpha 1", "alpha 2 (feature)", "alpha 3"),
        },
      },
      { subject: "Add d", files: { "src/d.txt": lines("delta") } },
    ],
    pushed: 1,
    local: {
      stashes: [
        {
          message: "old experiment",
          date: 1748736000, // 2025-06-01T00:00:00Z
          files: { "notes.txt": lines("notes", "experiment") },
        },
        {
          message: "wip a",
          date: 1767225600, // 2026-01-01T00:00:00Z
          files: {
            "src/a.txt": lines("alpha 1", "alpha 2 (feature)", "alpha 3 wip"),
          },
        },
      ],
      unstaged: {
        "src/b.txt": lines("bravo 1", "bravo 2", "bravo 3 (local)"),
        "notes.txt": lines("notes", "local edit"),
      },
      untracked: { "scratch.txt": lines("scratch") },
    },
  },
];

/** Ten lines with `greeting` on line 5, so both sides edit the same line. */
function appLines(greeting: string): string {
  return lines(
    "name = demo",
    "version = 1",
    "port = 8080",
    "debug = false",
    greeting,
    "timeout = 30",
    "retries = 3",
    "log = info",
    "theme = dark",
    "locale = en",
  );
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
  { subject, files, renames = {} }: Commit,
  clock: () => NodeJS.ProcessEnv,
): Promise<void> {
  for (const [from, to] of Object.entries(renames)) {
    await mkdir(path.dirname(path.join(repo, ...to.split("/"))), {
      recursive: true,
    });
    await git(repo, ["mv", from, to]);
  }
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

async function pushBranch(work: string): Promise<void> {
  await git(work, ["push", "--quiet", "-u", "origin", BRANCH]);
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

  await git(work, ["switch", "--quiet", "-c", BRANCH]);
  for (const [i, c] of scenario.feature.entries()) {
    if (i === scenario.pushed) await pushBranch(work);
    await commit(work, c, clock);
  }
  if (scenario.pushed === scenario.feature.length) await pushBranch(work);
  await git(work, ["fetch", "--quiet", "origin"]);

  for (const stash of scenario.local?.stashes ?? []) {
    await writeFiles(work, stash.files);
    const date = `${stash.date} +0000`;
    await git(work, ["stash", "push", "--quiet", "-m", stash.message], {
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    });
  }
  await writeFiles(work, scenario.local?.unstaged ?? {});
  await writeFiles(work, scenario.local?.untracked ?? {});

  return work;
}

// ---------------------------------------------------------------------------
// The judge: real Git, on a throwaway copy

/** "refused": Git declined to start and left the repo exactly as it was. */
type Outcome = "clean" | "conflict" | "refused";

/** One line of `git diff --name-status -M`. `from` is set for renames and copies. */
interface Change {
  status: string;
  path: string;
  from?: string;
}

function parseNameStatus(out: string): Change[] {
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status = "", a = "", b] = line.split("\t");
      return b === undefined
        ? { status, path: a }
        : { status, from: a, path: b };
    });
}

/** What your side changes on top of BASE, after a clean merge or rebase. */
async function changesVsBase(repo: string): Promise<Change[]> {
  return parseNameStatus(
    await git(repo, ["diff", "-M", "--name-status", BASE, "HEAD"]),
  );
}

/** Commits that came in on BASE since you branched, with the files each changed. */
async function incomingCommits(
  work: string,
): Promise<NonNullable<Expected["incoming"]>> {
  const mergeBase = await git(work, ["merge-base", BASE, BRANCH]);
  const out = await git(work, [
    "log",
    "--reverse",
    "-M",
    "--name-status",
    "--format=%x00%s",
    `${mergeBase}..${BASE}`,
  ]);
  return out
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const [subject = "", ...rest] = record.trim().split("\n");
      return { subject, files: parseNameStatus(rest.join("\n")) };
    });
}

interface JudgeOptions {
  hasUpstream: boolean;
  detail: boolean;
}

export interface Expected {
  scenario: string;
  description: string;
  branch: string;
  base: string;
  ahead: number;
  behind: number;
  /** Only when the branch has an upstream. Counts are relative to it. */
  upstream?: { name: string; ahead: number; behind: number };
  /** Detail scenarios only: commits on BASE since the merge base, oldest first. */
  incoming?: { subject: string; files: Change[] }[];
  /** Scenarios with local state only: uncommitted files as Git sees them. */
  local?: { staged: string[]; unstaged: string[]; untracked: string[] };
  /** Scenarios with local state only: `git stash list`, newest first. */
  stashes?: { subject: string; time: number }[];
  merge: MergeResult;
  rebase: RebaseResult;
  /** Scenarios with local state only: merge and rebase again after
   *  `git stash push --include-untracked`, i.e. judged on commits alone. */
  ifStashed?: { merge: MergeResult; rebase: RebaseResult };
}

interface MergeResult {
  outcome: Outcome;
  conflictedFiles?: string[];
  /** Refused only: the files Git listed as in the way. */
  blockedBy?: string[];
  /** Detail scenarios only, after a clean merge: HEAD vs BASE. */
  changes?: Change[];
  /** Upstream only, after a clean merge: was a plain push rejected? */
  needsForcePush?: boolean;
}

interface RebaseResult {
  outcome: Outcome;
  /** Commits real Git replayed (clean) or planned to replay (conflict).
   *  Absent when refused. */
  totalSteps?: number;
  stoppedAtStep?: number;
  stoppedAtCommit?: string;
  conflictedFiles?: string[];
  /** Detail scenarios only, after a clean rebase: HEAD vs BASE. */
  changes?: Change[];
  /** Upstream only, after a clean rebase: pushed commits no longer in HEAD. */
  rewritesPushedCommits?: number;
  /** Upstream only, after a clean rebase: was a plain push rejected? */
  needsForcePush?: boolean;
}

async function leftRight(
  repo: string,
  range: string,
): Promise<[number, number]> {
  const out = await git(repo, ["rev-list", "--left-right", "--count", range]);
  const [left, right] = out.split(/\s+/).map(Number);
  return [left ?? 0, right ?? 0];
}

/**
 * Pushes `feature` for real, to the copy's own origin, and reports whether
 * Git refused it as a non-fast-forward (the case that needs a force push).
 * `--porcelain` prints `<flag>\t<from>:<to>\t<summary>`; `!` means rejected.
 */
async function judgePush(repo: string): Promise<boolean> {
  const result = await run(repo, ["push", "--porcelain", "origin", BRANCH]);
  const ref = `refs/heads/${BRANCH}:refs/heads/${BRANCH}`;
  const line = result.stdout.split("\n").find((l) => l.includes(ref));
  const flag = line?.[0];
  if (result.code === 0 && (flag === " " || flag === "=")) return false;
  if (flag === "!" && line?.includes("(non-fast-forward)")) return true;
  throw new Error(
    `git push gave an unexpected result in ${repo}\n${result.stdout}${result.stderr}`,
  );
}

async function conflictedFiles(repo: string): Promise<string[]> {
  const out = await git(repo, ["diff", "--name-only", "--diff-filter=U"]);
  return out.split("\n").filter(Boolean).sort();
}

async function hasUnmergedEntries(repo: string): Promise<boolean> {
  return (await git(repo, ["ls-files", "--unmerged"])) !== "";
}

/** True when Git left no trace: HEAD unchanged, no merge or rebase in
 *  progress, no unmerged files. Anything else is not a clean refusal. */
async function refusedCleanly(
  repo: string,
  headBefore: string,
): Promise<boolean> {
  if ((await git(repo, ["rev-parse", "HEAD"])) !== headBefore) return false;
  if (
    (await run(repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code === 0
  )
    return false;
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const p = path.resolve(
      repo,
      await git(repo, ["rev-parse", "--git-path", dir]),
    );
    if (
      await access(p).then(
        () => true,
        () => false,
      )
    )
      return false;
  }
  return !(await hasUnmergedEntries(repo));
}

const nameList = (out: string): string[] =>
  out.split("\n").filter(Boolean).sort();

async function localState(
  work: string,
): Promise<NonNullable<Expected["local"]>> {
  return {
    staged: nameList(await git(work, ["diff", "--cached", "--name-only"])),
    unstaged: nameList(await git(work, ["diff", "--name-only"])),
    untracked: nameList(
      await git(work, ["ls-files", "--others", "--exclude-standard"]),
    ),
  };
}

async function stashList(
  work: string,
): Promise<NonNullable<Expected["stashes"]>> {
  const out = await git(work, ["stash", "list", "--format=%ct%x09%gs"]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [time = "", ...subject] = line.split("\t");
      return { subject: subject.join("\t"), time: Number(time) };
    });
}

async function judgeRebase(
  repo: string,
  { hasUpstream, detail }: JudgeOptions,
): Promise<RebaseResult> {
  const headBefore = await git(repo, ["rev-parse", "HEAD"]);
  const result = await run(repo, ["rebase", BASE], makeClock()());
  if (result.code === 0) {
    const count = await git(repo, ["rev-list", "--count", `${BASE}..HEAD`]);
    const clean: RebaseResult = {
      outcome: "clean",
      totalSteps: Number(count),
    };
    if (detail) clean.changes = await changesVsBase(repo);
    if (hasUpstream) {
      const rewritten = await git(repo, ["rev-list", "--count", "HEAD..@{u}"]);
      clean.rewritesPushedCommits = Number(rewritten);
      clean.needsForcePush = await judgePush(repo);
    }
    return clean;
  }

  if (await refusedCleanly(repo, headBefore)) return { outcome: "refused" };

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

async function judgeMerge(
  repo: string,
  { hasUpstream, detail }: JudgeOptions,
): Promise<MergeResult> {
  const headBefore = await git(repo, ["rev-parse", "HEAD"]);
  const result = await run(repo, ["merge", "--no-edit", BASE], makeClock()());
  if (result.code === 0) {
    const clean: MergeResult = { outcome: "clean" };
    if (detail) clean.changes = await changesVsBase(repo);
    if (hasUpstream) clean.needsForcePush = await judgePush(repo);
    return clean;
  }
  if (result.code === 1 && (await hasUnmergedEntries(repo))) {
    return {
      outcome: "conflict",
      conflictedFiles: await conflictedFiles(repo),
    };
  }
  if (await refusedCleanly(repo, headBefore)) {
    // Git lists the files in its way as indented lines. Only the list is
    // recorded, never the wording, which can change between Git versions.
    const blockedBy = result.stderr
      .split("\n")
      .filter((line) => /^\s+\S/.test(line))
      .map((line) => line.trim())
      .sort();
    if (blockedBy.length > 0) return { outcome: "refused", blockedBy };
  }
  throw new Error(
    `git merge failed without a conflict in ${repo}\n${result.stderr}`,
  );
}

/**
 * Copies `work` into `<dest>/work`. When the branch has an upstream, also
 * copies `origin.git` and points the copy's origin at it, so the judge can
 * really push without touching the fixture.
 */
async function copyForJudge(
  work: string,
  dest: string,
  withOrigin: boolean,
): Promise<string> {
  const copy = path.join(dest, "work");
  await cp(work, copy, { recursive: true });
  if (withOrigin) {
    const origin = path.join(dest, "origin.git");
    await cp(path.join(path.dirname(work), "origin.git"), origin, {
      recursive: true,
    });
    await git(copy, ["remote", "set-url", "origin", origin]);
  }
  return copy;
}

/** Copies `work` twice, runs real `git rebase` and `git merge`, records what happened. */
export async function judge(name: string, work: string): Promise<Expected> {
  const scenario = findScenario(name);
  const current = await git(work, ["branch", "--show-current"]);
  if (current !== BRANCH)
    throw new Error(`${work} is on "${current}", expected "${BRANCH}"`);

  const [behind, ahead] = await leftRight(work, `${BASE}...${BRANCH}`);
  const u = await run(work, ["rev-parse", "--abbrev-ref", "@{u}"]);
  const upstreamName = u.code === 0 ? u.stdout.trim() : undefined;
  const hasUpstream = upstreamName !== undefined;
  const options: JudgeOptions = {
    hasUpstream,
    detail: scenario.detail === true,
  };
  let upstream: Expected["upstream"];
  if (upstreamName !== undefined) {
    const [uBehind, uAhead] = await leftRight(work, "@{u}...HEAD");
    upstream = { name: upstreamName, ahead: uAhead, behind: uBehind };
  }

  const scratch = await mkdtemp(path.join(os.tmpdir(), "git-forecast-judge-"));
  try {
    const rebaseCopy = await copyForJudge(
      work,
      path.join(scratch, "rebase"),
      hasUpstream,
    );
    const mergeCopy = await copyForJudge(
      work,
      path.join(scratch, "merge"),
      hasUpstream,
    );
    const hasLocal = scenario.local !== undefined;
    let ifStashed: Expected["ifStashed"];
    if (hasLocal) {
      const copies = [];
      for (const kind of ["stashed-merge", "stashed-rebase"]) {
        const copy = await copyForJudge(
          work,
          path.join(scratch, kind),
          hasUpstream,
        );
        await git(
          copy,
          ["stash", "push", "--quiet", "--include-untracked", "-m", "judge"],
          makeClock()(),
        );
        copies.push(copy);
      }
      const [m = "", r = ""] = copies;
      ifStashed = {
        merge: await judgeMerge(m, options),
        rebase: await judgeRebase(r, options),
      };
    }
    // Optional fields are spread in place so the JSON reads top-down.
    return {
      scenario: name,
      description: scenario.description,
      branch: BRANCH,
      base: BASE,
      ahead,
      behind,
      ...(upstream ? { upstream } : {}),
      ...(options.detail ? { incoming: await incomingCommits(work) } : {}),
      ...(hasLocal
        ? { local: await localState(work), stashes: await stashList(work) }
        : {}),
      merge: await judgeMerge(mergeCopy, options),
      rebase: await judgeRebase(rebaseCopy, options),
      ...(ifStashed ? { ifStashed } : {}),
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
