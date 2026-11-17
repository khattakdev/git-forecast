# rebase.ts design note

Goal: say which step of `git rebase <base>` would stop on a conflict, without touching refs, the index or your files, inside the 300 ms budget.

## What a rebase does

1. Checks out `<base>`.
2. Replays your commits one by one, oldest first: for commit C, a three-way merge of (C's parent → C) onto the current tip.
3. Stops at the first conflict. What happens after depends on how you resolve it, so later steps are `"uncertain"` (`after-first-conflict`).

Which commits are replayed: `git rev-list --reverse --right-only --cherry-pick --no-merges <base>...HEAD`. Merge commits are dropped, and so are commits whose patch is already on base, as `git rebase` does.

## Simulation

Each step is `merge-tree` with base = C^, ours = previous result tree, theirs = C. The first "ours" is `<base>^{tree}`.

**Chosen (D1): one long-running `git merge-tree --stdin --name-only --no-messages`.** It reads one line per step, `C^ -- <tree> C`, and answers one record: `<1 clean | 0 conflict>\0<result tree>\0<conflicted paths\0…>\0`. The next line uses that tree. Measured at about 1–6 ms per step, against about 13 ms for one `merge-tree` + `commit-tree` process pair per step (speed test, React).

- **No commits are created.** `merge-tree` accepts a tree as "ours", so `commit-tree` isn't needed.
- **What it does write:** `merge-tree --write-tree` stores result trees as unreferenced objects, which Git's cleanup removes.

**Fallback (D2):** if batch mode is rejected, run one `git merge-tree --write-tree --merge-base=C^ <tree> C` per step, which is slower. If Git is older than 2.40, return `"uncertain"` (`git-too-old`).

## Refused (measured with real Git)

| Your uncommitted state                | `git rebase` | `--autostash` |
| ------------------------------------- | ------------ | ------------- |
| any staged or unstaged change         | refused      | proceeds      |
| untracked file where base adds a file | refused      | refused       |
| untracked file elsewhere              | proceeds     | proceeds      |

## Uncertain

- A custom merge driver or Git LFS on a file your branch changes, or on a conflicted file.
- rerere enabled and a conflict.
- Steps after the first conflict.

## Not in rebase.ts

- Force push (`push.ts`).
- What re-applying an autostash might conflict with (`forecast.ts` uses the merge's overlap: the end tree of a clean rebase and a clean merge touch the same files).
