// Small formatting helpers shared by the screens. Everything here is pure:
// the screens get colours, width and "now" passed in, so tests can render
// them exactly.

import pc from "picocolors";

export type Colors = ReturnType<typeof pc.createColors>;

export interface ScreenContext {
  c: Colors;
  /** Terminal width in columns. */
  width: number;
  /** Current time, Unix seconds. */
  now: number;
}

/** Colours on only for a real terminal without NO_COLOR (picocolors' rules). */
export function terminalContext(): ScreenContext {
  return {
    c: pc.createColors(pc.isColorSupported),
    width: process.stdout.columns || 80,
    now: Math.floor(Date.now() / 1000),
  };
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "just now", "5 minutes ago", "3 days ago", "7 months ago", "2 years ago". */
export function ago(seconds: number, now: number): string {
  const s = Math.max(0, now - seconds);
  const units: [number, string][] = [
    [365 * 86400, "year"],
    [30 * 86400, "month"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [size, unit] of units) {
    if (s >= size) return `${plural(Math.floor(s / size), unit)} ago`;
  }
  return "just now";
}

/** Cuts `text` to `max` characters, ending with "…" when cut. */
export function clip(text: string, max: number): string {
  if (max <= 1) return "";
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function list(items: string[]): string {
  return items.join(", ");
}
