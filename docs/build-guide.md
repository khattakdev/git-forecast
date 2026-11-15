# git-forecast build guide

From an empty repo to v0.1.0 on npm, launching on January 15, 2027. Each step ends with a check.

## Done

- **Before you start:** npm names checked, `@git-forecast` scope reserved, tools installed.
- **Step 1, repo:** github.com/khattakdev/git-forecast (MIT).
- **Step 2, workspace:** npm workspaces (`packages/core`, `packages/cli`), TypeScript strict built with plain `tsc`, Vitest, Biome. `git forecast -v` works via `npm link -w git-forecast`.
- **Step 3, CI:** lint, build, typecheck, test and a CLI smoke test on Linux, macOS and Windows with Node 22 and 24. `.gitattributes` forces LF.
- **Step 4:** `CLAUDE.md` and these docs.

## Step 5: Test repos first ← current

Build the test repos before the engine, so every feature has a known right answer.

1. Write `fixtures/build.ts`: creates small throwaway repos in a temp folder with plain Git commands, each with a local bare repo acting as `origin`.
2. Scenarios:

| Scenario               | What it tests                                                   |
| ---------------------- | --------------------------------------------------------------- |
| `clean`                | main moved, no files overlap                                    |
| `conflict-step-2`      | rebase stops at your second commit; merge conflicts too         |
| `rebase-only-conflict` | merge would be clean, but an intermediate rebase step conflicts |
| `pushed-branch`        | your branch is on origin, so rebase means a force push          |
| `squash-prs`           | main has squash-merged PRs with `(#123)` in their subjects      |
| `rename`               | main renames a file you edited                                  |
| `messy-local`          | uncommitted changes, unpushed commits, old stashes              |

3. **Real Git is the judge.** For each scenario, run the real `git rebase` and `git merge` in a copy and record the outcome in `fixtures/expected/<name>.json`.
4. **Speed test:** clone a large public repo with `--filter=blob:none`, make a branch that diverges from main, time each command.

Check: `npm run fixtures` builds every scenario, each with an expected file read once by hand.

## Step 6: The core engine

Build in this order; each module passes its fixtures before the next starts.

| Module         | Answers                                      | Git commands                                                                                                                                                                                 |
| -------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git.ts`       | Run Git safely and fast                      | `execFile("git", args)` with `GIT_OPTIONAL_LOCKS=0` and `LC_ALL=C`                                                                                                                           |
| `repo.ts`      | Branch, upstream, base branch                | `git rev-parse --abbrev-ref HEAD`, `git rev-parse --abbrev-ref @{u}`, `git symbolic-ref refs/remotes/origin/HEAD`                                                                            |
| `status.ts`    | Ahead/behind, dirty files, unpushed, stashes | `git status --porcelain=v2 --branch`, `git rev-list --left-right --count origin/main...HEAD`, `git stash list --format=%ct`                                                                  |
| `incoming.ts`  | What moved on main, files, PRs               | `git merge-base HEAD origin/main`, `git log --name-only <base>..origin/main`; PR numbers from `(#123)`                                                                                       |
| `merge.ts`     | Would a merge conflict, where                | `git merge-tree --write-tree --name-only origin/main HEAD` (exit code 1 = conflicts)                                                                                                         |
| `rebase.ts`    | Which rebase step conflicts                  | For each commit of `git rev-list --reverse <base>..HEAD`: `git merge-tree --write-tree --merge-base=<commit>^ <tip> <commit>`, then `git commit-tree` for the next simulated tip (Git 2.40+) |
| `push.ts`      | Force push needed?                           | Does the rebase rewrite commits already on `@{u}`?                                                                                                                                           |
| `recommend.ts` | Rebase or merge                              | `.gitforecast.json` rule first; else `git rev-list --merges --first-parent --since=90.days origin/main --count`                                                                              |
| `freshness.ts` | How stale the view is                        | mtime of `.git/FETCH_HEAD`; suggest `--fetch`                                                                                                                                                |

- Define the output types first in `core/src/types.ts`; the CLI, `--json` and later front ends depend on them.
- Mark uncertainty: custom merge drivers in `.gitattributes`, Git LFS, rerere, and rebase steps after the first conflict.
- Document `git commit-tree`: it writes unreferenced objects (no refs, index or files change; Git's cleanup removes them).

Check: every fixture matches its expected file; speed test under 300 ms.

## Step 7: The CLI

| Command or flag        | Behaviour                                               |
| ---------------------- | ------------------------------------------------------- |
| `git forecast`         | Smarter status screen (see the v0 mock)                 |
| `git forecast sync`    | Rebase vs merge, recommendation, then `[r] [m] [d] [q]` |
| `--json`               | The core's result as JSON, nothing else                 |
| `--fetch`              | Runs `git fetch` first; the only network call           |
| `--base <branch>`      | Compare against another branch                          |
| `--rebase` / `--merge` | Pick without the prompt                                 |

- Interactive only in a TTY; piped or CI → print and exit.
- Run the chosen command through real Git with live output, then print next steps and how to back out.
- Respect `NO_COLOR` and narrow terminals.
- Exit codes: 0 success, 1 error, 2 "not a Git repo" / "no upstream", each with a one-line fix.

Check: output on `conflict-step-2` matches the v0 mock; same in Windows Terminal.

## Step 8: README and demo GIF

Pitch → GIF → `npx git-forecast` → commands with samples → how it works (merge-tree, commit-tree note) → limits (Git 2.40+, "uncertain", no network unless `--fetch`) → credits to git-sim. Record the GIF with VHS (https://github.com/charmbracelet/vhs) against the `conflict-step-2` fixture, under 20 seconds.

## Step 9: Publish to npm

1. Both packages to `0.1.0`; the CLI depends on `"@git-forecast/core": "^0.1.0"`.
2. `npm pack` both, install the tarballs in an empty folder, run inside a fixture repo; have CI do this on all three OSes.
3. Publish from GitHub Actions on a `v*` tag: core first, then the CLI, with `npm publish --provenance --access public` (`permissions: id-token: write`; npm trusted publishing or an `NPM_TOKEN` secret).
4. `git tag v0.1.0 && git push --tags`, then a GitHub release with notes and the GIF.

Check: `npx git-forecast@0.1.0` works in a real repo on another machine.

## Step 10: Launch day

README check → LinkedIn and X post (problem, GIF, link, one honest line about building with Claude Code) → Show HN → longer "how I built it" on dev.to and the personal site → answer every issue the same day → a week later, share real numbers.

## Schedule

- Week of Nov 23: Step 5; post "I'm building a smarter git status"
- Week of Nov 30: `git.ts`, `repo.ts`, `status.ts`, `incoming.ts`
- Week of Dec 7: `merge.ts`; build log #1
- Week of Dec 14: `rebase.ts` (write the design note first)
- Week of Dec 21: `push.ts`, `recommend.ts`, `freshness.ts`; speed test
- Week of Dec 28: CLI status screen; build log #2
- Week of Jan 4: CLI `sync`; Windows check
- Week of Jan 11: Steps 8–10, launch January 15

If a week slips, cut from the end of v0 (`[d] details`, `--base`) rather than moving the launch.
