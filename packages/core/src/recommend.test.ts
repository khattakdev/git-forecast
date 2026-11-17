// recommend.ts and config.ts: the team rule first, else history shape.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readConfig } from "./config.js";
import { readFreshness } from "./freshness.js";
import { recommend } from "./recommend.js";
import { type Sandbox, sandbox } from "./test/repos.js";
import { ForecastError } from "./types.js";

let box: Sandbox;
beforeAll(() => {
  box = sandbox("recommend");
});
afterAll(() => box.remove());

function repoWith(name: string, config?: string): string {
  const repo = box.repo(name);
  box.commit(repo, "a.txt", "a\n", "Base");
  if (config !== undefined)
    writeFileSync(path.join(repo, ".gitforecast.json"), config);
  return repo;
}

async function codeOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ForecastError);
  return (error as ForecastError).code;
}

describe("config", () => {
  it("no file → no rules", async () => {
    expect(await readConfig(repoWith("none"))).toEqual({});
  });

  it("reads sync and autostash, ignores unknown keys", async () => {
    const repo = repoWith(
      "ok",
      '{ "sync": "merge", "autostash": true, "future": 1 }',
    );
    expect(await readConfig(repo)).toEqual({ sync: "merge", autostash: true });
  });

  it("found from a subfolder", async () => {
    const repo = repoWith("sub", '{ "sync": "rebase" }');
    const sub = path.join(repo, "deep");
    mkdirSync(sub);
    expect(await readConfig(sub)).toEqual({ sync: "rebase" });
  });

  it.each([
    ["invalid JSON", "{ sync: rebase }"],
    ["not an object", '["rebase"]'],
    ["wrong sync value", '{ "sync": "squash" }'],
    ["wrong autostash type", '{ "autostash": "yes" }'],
  ])("%s → bad-config", async (label, text) => {
    expect(
      await codeOf(readConfig(repoWith(label.replace(/\W+/g, "-"), text))),
    ).toBe("bad-config");
  });
});

describe("recommend", () => {
  it("the team rule wins", async () => {
    const repo = repoWith("rule");
    expect(
      await recommend({ cwd: repo, base: "main", config: { sync: "merge" } }),
    ).toEqual({
      pick: "merge",
      because: "team-rule",
    });
  });

  it("straight history → rebase", async () => {
    const repo = repoWith("straight");
    box.commit(repo, "b.txt", "b\n", "More");
    expect(await recommend({ cwd: repo, base: "main", config: {} })).toEqual({
      pick: "rebase",
      because: "history-shape",
    });
  });

  it("a recent merge commit on main → merge", async () => {
    const repo = repoWith("merges");
    box.git(repo, ["switch", "--quiet", "-c", "pr"]);
    box.commit(repo, "b.txt", "b\n", "PR work");
    box.git(repo, ["switch", "--quiet", "main"]);
    box.git(repo, ["merge", "--quiet", "--no-ff", "--no-edit", "pr"]);
    expect(await recommend({ cwd: repo, base: "main", config: {} })).toEqual({
      pick: "merge",
      because: "history-shape",
    });
  });
});

describe("freshness", () => {
  it("never fetched → no time", async () => {
    expect(await readFreshness(repoWith("unfetched"))).toEqual({});
  });

  it("after a fetch → the fetch time", async () => {
    const origin = repoWith("fetch-origin");
    const work = path.join(box.root, "fetch-work");
    box.git(box.root, ["clone", "--quiet", origin, work]);
    box.git(work, ["fetch", "--quiet"]);
    const { fetchedAt } = await readFreshness(work);
    expect(Math.abs((fetchedAt ?? 0) - Date.now() / 1000)).toBeLessThan(60);
  });
});
