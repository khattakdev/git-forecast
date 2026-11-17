// One-key prompt for `sync`: [r] rebase [m] merge [d] details [q] quit.
// Only used in a real terminal (the caller checks); reads a single key in
// raw mode so no Enter is needed. Ctrl-C and Escape count as quit.

import type { Readable } from "node:stream";

export type Key = "r" | "m" | "d" | "q";

interface KeyInput extends Readable {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
}

export function askKey(
  allowed: readonly Key[],
  input: KeyInput = process.stdin,
): Promise<Key> {
  return new Promise((resolve) => {
    const raw = typeof input.setRawMode === "function";
    if (raw) input.setRawMode?.(true);
    input.resume();
    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString();
      let key: Key | undefined;
      if (text === "\u0003" || text === "\u001b")
        key = "q"; // Ctrl-C, Escape
      else {
        const lower = text.trim().toLowerCase()[0];
        if (lower && (allowed as readonly string[]).includes(lower))
          key = lower as Key;
      }
      if (!key) return; // ignore other keys
      input.off("data", onData);
      if (raw) input.setRawMode?.(false);
      input.pause();
      resolve(key);
    };
    input.on("data", onData);
  });
}
