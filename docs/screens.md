# Screens (v0)

Text drafts of what the CLI prints (decision D3). Colour is a hint, never the only signal: every state also has a word. With `NO_COLOR`, when piped, or with `--json`, there's no colour.

## `git forecast`

```
feature → origin/main · 3 ahead, 1 behind · fetched 2 hours ago
Pushed to origin/feature · 1 commit not pushed

Your changes
  modified   notes.txt
  modified   src/b.txt
  untracked  scratch.txt

Stashes
  wip a                3 days ago
  old experiment       5 months ago  old

Main moved 4 commits · PRs #12 #15 #18
  #12  Add login page                    src/login.txt
  #15  Explain #7 in README              README.md
       Bump version                      version.txt
  #18  Revert "Add login page (#12)"     src/login.txt

If you merged now: blocked by your changes to src/b.txt

Next: git stash, then git forecast sync
```

Rules:

- **Line 1:** branch → base, ahead/behind, and when you last fetched. "never fetched" if there's no FETCH_HEAD. Older than a day: a hint to use `--fetch`.
- **Upstream line:**
  - "Pushed to … · n not pushed"
  - "Not pushed yet"
  - "origin/x was deleted on the remote (merged?)" for a gone upstream
  - "· n new on origin/x" when a teammate pushed to your branch
- **Sections** are left out when empty (no changes, no stashes, nothing new on main).
- **Stashes** older than 30 days get "old".
- **Incoming list:** at most 10 lines, then "… and n more (--json for all)". The PR number comes first; the files are clipped to the terminal width.
- **"If you merged now":** clean / conflict in <files> / blocked by your changes to <files> / not sure: <reason>.
- **Last line is always a next step:**
  - main moved: `git forecast sync`
  - local changes block the merge: `git stash, then git forecast sync`
  - nothing to do: "Up to date with origin/main"

## `git forecast sync`

```
feature → origin/main · 3 ahead, 1 behind · fetched 2 hours ago

              rebase                       merge
Result        stops at step 2 of 3         conflict in app.txt
              "Change greeting in app"
              conflict in app.txt
Rewrites      3 commits (2 pushed)         nothing
Force push    needed                       not needed
History       straight line                adds a merge commit

Recommended: merge · main's recent history uses merge commits

[r] rebase  [m] merge  [d] details  [q] quit
```

- **Narrow terminals** (under 72 columns) show the two options one after the other instead of side by side.
- **Recommended:** the engine's pick, with its reason:
  - "team rule in .gitforecast.json"
  - "main's recent history uses merge commits"
  - "main's history is a straight line"
- **When uncommitted changes block both:** the table shows what `--autostash` would do, under a line that says so. Without `--autostash` (flag or config), only `[d]` and `[q]` are offered, plus the hint `git stash` or `--autostash`. With `--autostash`, the files where re-applying may conflict are listed.
- **The prompt only appears in a real terminal.** Piped or in CI, the screen prints and exits 0. `--rebase` / `--merge` pick without asking.
- **After a pick:**
  - The command and its live output (real Git, your language and colours).
  - Then the next step: on success, `git push` or `git push --force-with-lease`; on a conflict, "fix <files>, then `git add` and `git rebase --continue` (or `git merge --continue`)".
  - Then how to back out: `git rebase --abort` / `git merge --abort` while stopped, `git reset --keep ORIG_HEAD` after a finished sync. `--keep` refuses rather than lose uncommitted work.
- **`[d]`:** every incoming commit with all its files, the rebase step list, and the reapply overlap.

## `--json`

The report from `@git-forecast/core` (`StatusReport` or `SyncReport`), pretty-printed, nothing else on stdout. No prompt, no action. An error prints `{ "error": { "code", "message" } }`.

## Errors and exit codes

One line, then one fix:

```
git-forecast: not inside a Git repository
  Run it from a folder inside a repo.
```

| Exit | When                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | Forecast printed, or the picked sync finished                                                                                                                            |
| 1    | Git failed, or the picked sync stopped on a conflict                                                                                                                     |
| 2    | Can't forecast here: not a repo, detached HEAD, no commits, no base branch, an operation in progress, bad `.gitforecast.json`, Git not found. Each gets its own fix line |
