// Test-only: the fixture repos built once per run by the root globalSetup
// (packages/core/src/test/fixtures-setup.ts), and an empty Git config so a
// personal setting can't change what the engine says.

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inject } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    fixturesDir: string;
  }
}

export const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

const scratch = mkdtempSync(path.join(os.tmpdir(), "git-forecast-cli-"));
const emptyConfig = path.join(scratch, "gitconfig");
writeFileSync(emptyConfig, "");

export const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: emptyConfig,
  NO_COLOR: "1",
};

/** A private copy of a fixture's work repo (plus its origin), safe to change. */
export function fixtureCopy(name: string): string {
  const dest = mkdtempSync(path.join(scratch, `${name}-`));
  cpSync(path.join(inject("fixturesDir"), name), dest, { recursive: true });
  const work = path.join(dest, "work");
  // Point origin at the copied bare repo, so a push can't touch the shared one.
  const origin = path.join(dest, "origin.git");
  execFileSync("git", ["remote", "set-url", "origin", origin], {
    cwd: work,
    env: ENV,
  });
  return work;
}

export function fixtureWork(name: string): string {
  return path.join(inject("fixturesDir"), name, "work");
}

/** Runs the built CLI. */
export function cli(cwd: string, args: string[] = [], input?: string) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: ENV,
    encoding: "utf8",
    input,
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

export function git(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@t", ...args],
    {
      cwd,
      env: ENV,
      encoding: "utf8",
    },
  );
}

export { scratch };
