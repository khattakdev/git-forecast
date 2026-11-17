// How failures reach the user: one line, exit code 2 when it's about where
// you ran it (each core message already carries its fix), 1 otherwise.

import { ForecastError } from "@git-forecast/core";
import type { Colors } from "./format.js";

export function exitCodeFor(error: unknown): number {
  return error instanceof ForecastError && error.code !== "git-failed" ? 2 : 1;
}

export function formatError(error: unknown, c: Colors): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${c.red("git-forecast:")} ${message}`;
}

export function errorJson(error: unknown): string {
  const code = error instanceof ForecastError ? error.code : "internal";
  const message = error instanceof Error ? error.message : String(error);
  return JSON.stringify({ error: { code, message } }, null, 2);
}
