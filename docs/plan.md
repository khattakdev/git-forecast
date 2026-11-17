# git-forecast plan: v0 and v1

A smarter `git status` that warns you before things go wrong and helps you fix them. v0 ships mid-January 2027 with `git forecast` and `git forecast sync`; v1 adds undo, branch cleanup, a prompt segment and guard mode by the end of February 2027.

## Positioning

It starts from the developer's goal, not the Git command. git-sim answers "what will this command do?"; git-forecast answers "what should I do?", compares the options and runs the one you pick. It reuses git-sim's best ideas (risk levels, conflict prediction with `git merge-tree`, force-push detection) and credits them openly in the README.

Goal: a polished, free, open-source portfolio piece built in public. Success is quality and content, not downloads.

## Who it's for

Developers on PR-based teams who keep branches open for days while main moves underneath them.

- **Every day:** `git forecast` instead of `git status`: did main move, what will conflict, what isn't pushed.
- **Before updating a branch:** `git forecast sync` shows rebase and merge side by side, then follows the team's rule.
- **After a mistake (v1):** `git forecast undo` previews the way back before running it.

Not for: people learning Git (git-sim serves them better), or teams on tiny branches that GitHub's "Update branch" button already covers.

## v0 (mid-January 2027)

| Feature                            | What it does                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core engine (`@git-forecast/core`) | Reads branches, upstreams and history; simulates rebase commit by commit and merge with `git merge-tree`; detects rewrites and force-push needs; returns plain data |
| `git forecast`                     | Everything `git status` shows, plus how far main moved, which files will conflict, unpushed commits, old stashes                                                    |
| `git forecast sync`                | Rebase vs merge side by side (conflicts, commits rewritten, force push, history shape); recommends one, then runs the pick                                          |
| Repo config                        | `.gitforecast.json` with the team's rule, e.g. `{ "sync": "rebase", "autostash": true }`                                                                            |
| Output                             | Colored, `NO_COLOR`- and pipe-safe; `--json` on every command                                                                                                       |
| Tests                              | Fixture repos with known conflicts, squash merges, renames                                                                                                          |
| Release                            | README, demo GIF, npm publish                                                                                                                                       |

Requirements: Node 22+, Git 2.40+ (older Git skips rebase-step checks and says so), macOS, Linux, Windows.

Done means: correct results on every fixture repo; `git forecast` under 300 ms on a 10,000-commit repo; "uncertain" instead of guessing (custom merge drivers, Git LFS, rerere).

## v1 (end of February 2027), one small release per feature

| Feature          | What it does                                                                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `undo`           | Reads the reflog, names the last action (commit, amend, merge, rebase, reset, pull), previews the undo, runs it on confirm; offers `git revert` for anything pushed; `--list` shows the last 10 |
| Prompt segment   | Starship / oh-my-zsh segment like `↓14 ⚠1`, from a cached result                                                                                                                                |
| `tidy`           | Branches safe to delete, including squash-merged ones `git branch --merged` misses                                                                                                              |
| Guard mode       | Shell hook that checks destructive Git commands and stays silent unless something would be lost                                                                                                 |
| `--graph`        | Before/after commit graphs in the terminal, plain text from core data                                                                                                                           |
| GitHub awareness | Optional, via the `gh` CLI login: knows when a PR is open                                                                                                                                       |

## Not planned for v0 or v1

VS Code extension, MCP server for agents, catch-up summaries / weekly recaps, web playground or tutorials, paid features.

## Architecture

One core engine, several front ends. The CLI is only a formatter. Every front end (CLI now; prompt segment and guard hook in v1; VS Code later) calls the same core. Core talks to Git directly through plumbing commands (`rev-list`, `merge-tree`, `reflog`) and to GitHub only when the user opts in.

Core modules: repo reader (branches, upstreams, history, reflog) · simulator (rebase step by step, merge via merge-tree) · risk check (conflicts, rewrites, force push) · recommender (history shape + team config).

## Lessons from git-sim's author

From Jacob Stopak's retrospective (https://initialcommit.com/blog/git-sim-mistakes-and-fixes):

- Outputs that lead nowhere are dead ends → every screen ends in a next step (run an option, copy an undo command, pipe `--json`).
- Install friction blocked users → plain Node plus Git, no native modules, `npx` just works.
- Slow output broke the workflow → benchmark on a large real repo early; keep the 300 ms budget.
- Pick tools for the long run; release even if unsure.

## Risks

| Risk                               | Handling                                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| Wrong prediction                   | Fixture tests per edge case; "uncertain" for renames, merge drivers, LFS, rerere |
| Too slow for daily use or a prompt | 300 ms target; cache for the prompt; spawn Git directly                          |
| Windows quirks                     | CI on Windows from the first commit; LF line endings                             |
| Scope creep                        | Fixed lists per version; new ideas go to issues                                  |
| Seen as a git-sim copy             | Goals-first, terminal-first, credited openly                                     |

## Open decisions

- Short command alias (only `git-forecast` / `git forecast` for now)
- Whether v0 ships `sync` alone first
