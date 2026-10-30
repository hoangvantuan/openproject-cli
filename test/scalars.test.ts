import { describe, expect, test } from "vitest";

import { OpCliError } from "../src/core/errors.js";
import { applyScalars, validateScalars } from "../src/core/scalars.js";

describe("validateScalars (review S6)", () => {
  test("accepts every well-formed scalar and the clearing empty string", () => {
    expect(() => {
      validateScalars({
        start: "2026-03-01",
        due: "",
        estimate: "1h30m",
        remaining: "PT2H",
        done: "40",
        storyPoints: "",
      });
    }).not.toThrow();
  });

  test("rejects a bad value as USAGE_ERROR naming the flag in its message or hint", () => {
    for (const [flags, flag] of [
      [{ due: "2026-02-30" }, "--due"],
      [{ done: "101" }, "--done"],
      [{ estimate: "soon" }, "--estimate"],
      [{ storyPoints: "-1" }, "--story-points"],
    ] as const) {
      try {
        validateScalars(flags);
        expect.unreachable(`${flag} should have been refused`);
      } catch (error) {
        expect(error).toBeInstanceOf(OpCliError);
        expect((error as OpCliError).code).toBe("USAGE_ERROR");
        const { message, hint } = error as OpCliError;
        expect(`${message} ${hint ?? ""}`).toContain(flag);
      }
    }
  });

  test("agrees with applyScalars on what is valid", () => {
    const payload: Record<string, unknown> = {};
    applyScalars(payload, { due: "2026-03-31", done: "" });
    expect(payload).toEqual({ dueDate: "2026-03-31", percentageDone: null });
  });
});
