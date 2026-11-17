# git-forecast

**A smarter `git status` that forecasts conflicts before you sync.**

Your branch has been open for three days and `main` kept moving. Will a rebase conflict? On which commit? Will you need a force push? Would a merge be cleaner? `git-forecast` answers before you run anything, then runs the option you pick.

<!-- Demo GIF: record with `npm run demo` (needs VHS), then uncomment:
![git forecast on a branch whose rebase stops at step 2](docs/demo.gif)
-->

```bash
npx git-forecast
```

Or install it, so Git picks it up as `git forecast`:

```bash
npm install -g git-forecast
git forecast
```

Needs Node 22+ and Git 2.40+. Works on macOS, Linux and Windows.

## `git forecast`

Everything `git status` tells you, plus what moved on `main` and what a merge would do right now (real output on the `squash-prs` test repo):

```
feature → origin/main · 2 ahead, 4 behind · fetched 2 hours ago
Not pushed yet

origin/main moved 4 commits · PRs #12 #15 #18
  #12  Add login page                 src/login.txt
  #15  Explain #7 in README           README.md
       Bump version                   version.txt
  #18  Revert "Add login page (#12)"  src/login.txt

If you merged now: clean

Next: git forecast sync
```

## `git forecast sync`

Rebase and merge side by side, a recommendation, then one key to run it (the `conflict-step-2` test repo):

```
              rebase                           merge
Result        stops at step 2 of 3             conflict in app.txt
              "Change greeting in app"
              conflict in app.txt
Rewrites      3 commits                        nothing
Force push    not pushed yet                   not pushed yet
History       straight line                    adds a merge commit

Recommended: rebase · origin/main's history is a straight line

[r] rebase  [m] merge  [d] details  [q] quit
```

After you pick, it runs the real `git rebase` or `git merge` with its normal output. Then it prints the next step (for example `git push --force-with-lease`) and how to back out.

## Options

| Flag                  | What it does                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `--json`              | Print the report as JSON and nothing else (the shape is `StatusReport` / `SyncReport` in `@git-forecast/core`)     |
| `--fetch`             | Run `git fetch` first. Without it, git-forecast never touches the network and tells you how old your last fetch is |
| `--base <branch>`     | Compare against `<branch>` instead of the remote's default branch                                                  |
| `--rebase`, `--merge` | `sync`: pick without the prompt (for scripts)                                                                      |
| `--autostash`         | `sync`: stash your uncommitted changes, sync, then re-apply them (Git's own `--autostash`)                         |
| `-h`, `-v`            | Help and version. `git forecast --help` is caught by Git, which looks for a man page, so use `-h`                  |

Exit codes: `0` done; `1` Git failed or the sync stopped on a conflict; `2` can't forecast here (not a repo, detached HEAD, a merge in progress…), always with a one-line fix.

## Team rules: `.gitforecast.json`

```json
{ "sync": "rebase", "autostash": true }
```

- **`sync`:** your team's rule, which wins over the recommendation. Without it, git-forecast looks at `main`: recent merge commits suggest merge; a straight line suggests rebase.
- **`autostash`:** makes `--autostash` the default.

## How it works

- **Nothing changes until you pick.** Forecasts never touch your branch, index or files.
- **Merges** are simulated with `git merge-tree --write-tree`, the same merge machinery `git merge` uses, without a working tree.
- **Rebases** are simulated commit by commit: one long-running `git merge-tree --stdin` replays each of your commits onto the result of the last. About 1–6 ms per commit.
- **About the objects it writes:** `merge-tree` stores its result trees in Git's object database. Nothing points to them, nothing else changes, and Git's routine cleanup deletes them.
- **When it can't be sure, it says so** instead of guessing:
  - custom merge drivers
  - Git LFS files
  - `rerere`
  - rebase steps after the first conflict
  - Git older than 2.40
- **Every prediction is tested against the real thing:** the test suite builds repos with known histories, runs the real `git merge` / `git rebase` on copies, and checks the forecast matches.
- **Speed:** on React's repository (about 21,800 commits) with a 20-commit branch, `git forecast` takes about 60 ms and `git forecast sync` about 75 ms.

## Limits

- **Only what you've fetched.** git-forecast sees `origin` as of your last fetch; use `--fetch` to update first.
- **Re-applying an autostash** can still conflict. The screen lists the files where it might, and the CLI says when it did.

## Credits

git-forecast borrows its best ideas from [git-sim](https://github.com/initialcommit-com/git-sim) by Jacob Stopak: risk levels, conflict prediction with `git merge-tree`, and force-push detection. git-sim shows _what a command will do_; git-forecast starts from _what you're trying to do_, compares the options, and runs the one you pick.

## Development

```bash
npm install
npm run build        # core first, then the CLI
npm test             # Vitest; builds the fixture repos once per run
npm run lint
npm run typecheck
npm run fixtures     # rebuild the test repos and their expected outcomes from real Git
npm run speed        # time the engine on a large public repo (network)
npm run demo         # re-record docs/demo.gif (needs VHS: brew install vhs)
```

The engine is `packages/core` (`@git-forecast/core`, which returns plain data and never prints); the CLI is `packages/cli` (`git-forecast`). See `docs/plan.md` and `docs/build-guide.md`.

## License

MIT
