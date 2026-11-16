// Test-only access to the fixture repos built by fixtures-setup.ts and their
// answer key in fixtures/expected/.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inject } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    fixturesDir: string;
  }
}

const expectedDir = fileURLToPath(
  new URL("../../../../fixtures/expected/", import.meta.url),
);

/** Every scenario that has an expected file. */
export const fixtureNames: string[] = readdirSync(expectedDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""))
  .sort();

/** The `work` repo of a scenario: the one the engine reads. */
export function fixtureWork(name: string): string {
  return path.join(inject("fixturesDir"), name, "work");
}

/** What real Git said for a scenario. Untyped by design: it's the answer key. */
// biome-ignore lint/suspicious/noExplicitAny: fixture JSON is untyped by design
export function expected(name: string): any {
  return JSON.parse(
    readFileSync(path.join(expectedDir, `${name}.json`), "utf8"),
  );
}
