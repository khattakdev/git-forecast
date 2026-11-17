// The whole engine against the whole answer key: every field real Git
// recorded in fixtures/expected/ must come out of forecastStatus() /
// forecastSync() unchanged. This is Step 6's check.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forecastStatus, forecastSync } from "./forecast.js";
import { expected, fixtureNames, fixtureWork } from "./test/fixtures.js";
import { type Sandbox, sandbox } from "./test/repos.js";
import { SCHEMA_VERSION } from "./types.js";

let box: Sandbox;
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  box = sandbox("forecast");
  for (const key of ["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"]) {
    saved[key] = process.env[key];
    process.env[key] = box.env[key];
  }
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  box.remove();
});

/** Drops the answer key's `changes` (for the later details view). */
function withoutChanges<T extends Record<string, unknown>>(result: T) {
  const { changes, ...rest } = result;
  return rest;
}

describe.each(fixtureNames)("%s", (name) => {
  it("forecastSync matches the whole answer key", async () => {
    const want = expected(name);
    const sync = await forecastSync({ cwd: fixtureWork(name) });

    expect(sync.schemaVersion).toBe(SCHEMA_VERSION);
    expect(sync.status).toMatchObject({
      branch: want.branch,
      base: want.base,
      ahead: want.ahead,
      behind: want.behind,
    });
    expect(sync.status.upstream).toEqual(want.upstream);
    if (want.local) expect(sync.status.local).toEqual(want.local);
    if (want.stashes) expect(sync.status.stashes).toEqual(want.stashes);
    if (want.incoming) {
      expect(
        sync.status.incoming.map(({ subject, files }) => ({ subject, files })),
      ).toEqual(want.incoming);
    }
    expect(sync.merge).toEqual(withoutChanges(want.merge));
    expect(sync.status.merge).toEqual(sync.merge);
    expect(sync.rebase).toMatchObject(withoutChanges(want.rebase));
    if (want.ifStashed) {
      expect(sync.ifStashed?.merge).toEqual(want.ifStashed.merge);
      expect(sync.ifStashed?.rebase).toMatchObject(want.ifStashed.rebase);
    } else {
      expect(sync.ifStashed).toBeUndefined();
    }
  });

  it("forecastStatus agrees with forecastSync's status", async () => {
    const cwd = fixtureWork(name);
    const [status, sync] = await Promise.all([
      forecastStatus({ cwd }),
      forecastSync({ cwd }),
    ]);
    expect(status).toEqual(sync.status);
  });
});
