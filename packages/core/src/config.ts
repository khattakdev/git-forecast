// .gitforecast.json at the repo's top level: the team's rules.
//   { "sync": "rebase" | "merge", "autostash": true | false }
// Missing file → no rules. Invalid JSON or a wrong type → ForecastError
// "bad-config", so a typo can't silently change what sync does.
// Unknown keys are ignored, so newer config files work with older versions.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { gitOutput } from "./git.js";
import { ForecastError } from "./types.js";

export interface ForecastConfig {
  sync?: "rebase" | "merge";
  autostash?: boolean;
}

export const CONFIG_FILE = ".gitforecast.json";

export async function readConfig(cwd: string): Promise<ForecastConfig> {
  const top = await gitOutput(["rev-parse", "--show-toplevel"], { cwd });
  const file = path.join(top, CONFIG_FILE);
  const text = await readFile(file, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (text === undefined) return {};

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ForecastError(
      "bad-config",
      `${CONFIG_FILE} isn't valid JSON: ${(error as Error).message}`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ForecastError(
      "bad-config",
      `${CONFIG_FILE} must be a JSON object, like { "sync": "rebase" }`,
    );
  }
  const { sync, autostash } = raw as Record<string, unknown>;
  const config: ForecastConfig = {};
  if (sync !== undefined) {
    if (sync !== "rebase" && sync !== "merge") {
      throw new ForecastError(
        "bad-config",
        `${CONFIG_FILE}: "sync" must be "rebase" or "merge", not ${JSON.stringify(sync)}`,
      );
    }
    config.sync = sync;
  }
  if (autostash !== undefined) {
    if (typeof autostash !== "boolean") {
      throw new ForecastError(
        "bad-config",
        `${CONFIG_FILE}: "autostash" must be true or false, not ${JSON.stringify(autostash)}`,
      );
    }
    config.autostash = autostash;
  }
  return config;
}
