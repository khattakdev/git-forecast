import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { askKey } from "./prompt.js";

function fakeTty() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    modes: [] as boolean[],
  });
  return Object.assign(input, {
    setRawMode(mode: boolean) {
      input.modes.push(mode);
      return input;
    },
  });
}

describe("askKey", () => {
  it("returns the first allowed key, ignoring others, and restores the terminal", async () => {
    const input = fakeTty();
    const answer = askKey(["m", "d", "q"], input);
    input.write("x"); // not allowed
    input.write("r"); // not allowed here (rebase blocked)
    input.write("M"); // case-insensitive
    expect(await answer).toBe("m");
    expect(input.modes).toEqual([true, false]);
  });

  it("Ctrl-C and Escape quit", async () => {
    for (const key of ["\u0003", "\u001b"]) {
      const input = fakeTty();
      const answer = askKey(["r", "m", "d", "q"], input);
      input.write(key);
      expect(await answer).toBe("q");
    }
  });
});
