# @git-forecast/core

The engine behind [git-forecast](https://github.com/khattakdev/git-forecast): it reads a Git repository and forecasts what `git merge` and `git rebase` would do, as plain data. It never prints and never changes your branch, index or files.

```js
import { forecastStatus, forecastSync } from "@git-forecast/core";

const status = await forecastStatus({ cwd: "/path/to/repo" });
// { branch, base, ahead, behind, upstream, local, stashes, incoming, merge, freshness }

const sync = await forecastSync({ cwd: "/path/to/repo" });
// { status, merge, rebase, recommendation, ifStashed?, config }
```

Every result is a discriminated union on `outcome`: `"clean"`, `"conflict"`, `"refused"` or `"uncertain"` (with a reason). When there's no report at all (not a repo, detached HEAD, …) it throws a `ForecastError` with a `code`. See `types.ts` for the full shapes.

Needs Node 22+ and Git 2.40+. Zero runtime dependencies. MIT.
