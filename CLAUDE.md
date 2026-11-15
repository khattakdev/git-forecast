# git-forecast

A smarter `git status` that forecasts conflicts before you sync. Free, open-source portfolio project.

- Plan (what and why): docs/plan.md
- Build guide (step by step, with checks): docs/build-guide.md. Current step: **Step 5, test repos**. All seven scenarios and the speed test are built; what's left is reading each `fixtures/expected/*.json` once by hand. Then Step 6.

## Layout

- `packages/core` → `@git-forecast/core`: the engine. Reads the repo, returns plain data, never prints.
- `packages/cli` → `git-forecast` (run as `git forecast`): formats output, prompts, runs Git.
- `fixtures/` → `build.ts` builds throwaway test repos and records what real Git does in `expected/*.json`; `speed.ts` times the engine's Git commands on a large repo; `git.ts` is their shared, config-isolated Git helper.
- `docs/` → plan and build guide.

## Commands

- `npm run build`: tsc, core first, then cli
- `npm test`: vitest
- `npm run lint` / `npm run format`: Biome
- `npm run typecheck` (also typechecks `fixtures/`)
- `npm run fixtures`: rebuild the test repos and rewrite `fixtures/expected/`; `-- --check` only compares (CI runs this)
- `npm run speed`: speed test on a blobless React clone (network; not in CI)

## Rules

- Core returns data and never prints. The CLI only formats, prompts and runs Git.
- Read-only until the user confirms: a check never changes refs, the index or the working tree. The one exception is `git commit-tree` in the rebase simulation, which writes unreferenced objects; keep that documented.
- No native modules. Core has zero runtime dependencies; the CLI depends only on core and `picocolors`.
- Every Git call goes through `packages/core/src/git.ts` (`execFile`, `GIT_OPTIONAL_LOCKS=0`, `LC_ALL=C`).
- Tests first: a fixture repo and its expected result exist before the code. Expected results come from running real `git rebase` / `git merge` on a copy, never from reasoning.
- When a prediction can't be trusted, return `"uncertain"` with a reason. Never guess.
- Node 22+. Git 2.40+ for step-by-step rebase simulation (`git merge-tree --merge-base`); on older Git, skip that check and say so.
- Must work on macOS, Linux and Windows. LF line endings everywhere (see `.gitattributes`).
- TypeScript strict, ESM, NodeNext: relative imports end in `.js`.
- Small diffs, one module per session. Explain anything non-obvious in the PR or commit message.

## Gotchas

- `git forecast --help` is intercepted by Git, which looks for a man page. Use `-h` or `git-forecast --help`.
- Build core before typechecking the CLI: the CLI reads core's types from `packages/core/dist`.
- The fixture scripts run `.ts` directly with `node`, which needs Node 22.18+ (type stripping). Use erasable syntax only, and end relative imports there in `.ts`.
- Short command alias: not decided yet. Only `git-forecast` is installed.
