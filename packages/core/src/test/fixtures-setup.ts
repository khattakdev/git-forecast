// Vitest globalSetup: builds every fixture repo once per test run, with the
// same builder CI runs (--check also confirms real Git still agrees with
// fixtures/expected/). Test files find the repos via inject("fixturesDir").

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

const builder = fileURLToPath(
  new URL("../../../../fixtures/build.ts", import.meta.url),
);

export default function setup(project: TestProject): () => void {
  const root = mkdtempSync(path.join(os.tmpdir(), "git-forecast-fixtures-"));
  const dir = path.join(root, "repos");
  execFileSync(process.execPath, [builder, "--check", "--out", dir], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  project.provide("fixturesDir", dir);
  return () => rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}
