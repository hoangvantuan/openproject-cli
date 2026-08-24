import { describe, expect, test } from "vitest";

import { OpCliError } from "../src/core/errors.js";
import {
  hoursToIso,
  isoToHours,
  parseDuration,
} from "../src/core/duration.js";

function catchOpCliError(run: () => unknown): OpCliError {
  try {
    run();
  } catch (error) {
    if (error instanceof OpCliError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected an OpCliError");
}

describe("isoToHours", () => {
  test("zero is legal and maps to 0", () => {
    expect(isoToHours("PT0S")).toBe(0);
  });

  test("whole hours, minutes, and seconds map to decimals", () => {
    expect(isoToHours("PT2H")).toBe(2);
    expect(isoToHours("PT30M")).toBe(0.5);
    expect(isoToHours("PT3600S")).toBe(1);
  });

  test("compound components sum up", () => {
    expect(isoToHours("PT1H30M")).toBe(1.5);
    expect(isoToHours("PT1H30M45S")).toBeCloseTo(1.5125, 10);
  });

  test("a single component can be expressed through another one", () => {
    expect(isoToHours("PT90M")).toBe(1.5);
    expect(isoToHours("PT5400S")).toBe(1.5);
  });

  test("fractional components are accepted", () => {
    expect(isoToHours("PT1.5H")).toBe(1.5);
    expect(isoToHours("PT0.25H")).toBe(0.25);
    expect(isoToHours("PT1.5M")).toBeCloseTo(0.025, 10);
  });

  test("letters are case-insensitive", () => {
    expect(isoToHours("pt1h30m")).toBe(1.5);
  });

  test("a day component is read, not refused", () => {
    // OpenProject spells any duration of 24 hours or more with a day
    // component, so the read path has to sum P3DT1H as 73 hours.
    expect(isoToHours("P3DT1H")).toBe(73);
    expect(isoToHours("P1D")).toBe(24);
    expect(isoToHours("P1DT30M")).toBe(24.5);
  });

  test("a week component is read too", () => {
    expect(isoToHours("P1W")).toBe(168);
    expect(isoToHours("P1W2DT3H30M")).toBe(168 + 48 + 3.5);
  });

  test("calendar spans and malformed forms are refused as the instance's answer", () => {
    for (const bad of ["", "P", "PT", "PT1H30", "1h30m", "P1DT", "P1YT1H", "P1M", "-PT1H", "abc", "P1DT1W"]) {
      const error = catchOpCliError(() => isoToHours(bad));
      expect(error.code).toBe("API_ERROR");
      expect(error.message).toContain(bad === "" ? '""' : bad);
    }
  });
});

describe("hoursToIso", () => {
  test("zero renders as PT0S", () => {
    expect(hoursToIso(0)).toBe("PT0S");
  });

  test("decimals render as the shortest compound form", () => {
    expect(hoursToIso(1.5)).toBe("PT1H30M");
    expect(hoursToIso(2)).toBe("PT2H");
    expect(hoursToIso(0.25)).toBe("PT15M");
    expect(hoursToIso(0.5)).toBe("PT30M");
  });

  test("sub-minute remainders keep their seconds", () => {
    expect(hoursToIso(1.0075)).toBe("PT1H27S");
    expect(hoursToIso(1 / 120)).toBe("PT30S");
  });

  test("fractional seconds survive without trailing zeros", () => {
    expect(hoursToIso(1 / 7200)).toBe("PT0.5S");
  });

  test("binary-fraction noise never leaks into the output", () => {
    expect(hoursToIso(0.1 + 0.2)).toBe("PT18M");
    expect(hoursToIso(1.1)).toBe("PT1H6M");
  });

  test("negative and non-finite inputs are refused", () => {
    expect(() => hoursToIso(-1)).toThrow(OpCliError);
    expect(() => hoursToIso(Number.NaN)).toThrow(OpCliError);
    expect(() => hoursToIso(Number.POSITIVE_INFINITY)).toThrow(OpCliError);
  });
});

describe("ISO round trip", () => {
  test("every canonical form survives both directions", () => {
    for (const iso of [
      "PT0S",
      "PT1H",
      "PT30M",
      "PT1H30M",
      "PT2H15M",
      "PT1H30M45S",
      "PT45S",
      "PT0.5S",
    ]) {
      const back = hoursToIso(isoToHours(iso));
      // Both spellings must name the same amount of time even where the
      // canonical form differs (PT90M becomes PT1H30M).
      expect(isoToHours(back)).toBe(isoToHours(iso));
    }
  });

  test("decimal hours are stable across a round trip", () => {
    for (const hours of [0, 0.25, 0.5, 1, 1.5, 2, 7.75, 40]) {
      expect(isoToHours(hoursToIso(hours))).toBe(hours);
    }
  });
});

describe("parseDuration", () => {
  test("decimal and compound input agree exactly", () => {
    expect(parseDuration("1.5")).toEqual({ hours: 1.5, iso: "PT1H30M" });
    expect(parseDuration("1h30m")).toEqual(parseDuration("1.5"));
    expect(parseDuration("90m")).toEqual(parseDuration("1.5"));
    expect(parseDuration("PT1H30M")).toEqual(parseDuration("1.5"));
  });

  test("compound forms accept every unit alone and together", () => {
    expect(parseDuration("2h")).toEqual({ hours: 2, iso: "PT2H" });
    expect(parseDuration("45m")).toEqual({ hours: 0.75, iso: "PT45M" });
    expect(parseDuration("1h30m")).toEqual({ hours: 1.5, iso: "PT1H30M" });
    expect(parseDuration("1h30m20s")).toEqual({
      hours: isoToHours("PT1H30M20S"),
      iso: hoursToIso(isoToHours("PT1H30M20S")),
    });
  });

  test("compound forms tolerate case and spaces between segments", () => {
    expect(parseDuration("1H30M")).toEqual(parseDuration("1h30m"));
    expect(parseDuration("1h 30m")).toEqual(parseDuration("1h30m"));
  });

  test("decimal fractions work in compound hour segments too", () => {
    expect(parseDuration("0.5h")).toEqual({ hours: 0.5, iso: "PT30M" });
  });

  test("zero and negatives are refused for logging", () => {
    for (const bad of ["0", "0h", "0m", "PT0S", "-1", "-1h", "0.0"]) {
      expect(() => parseDuration(bad)).toThrow(OpCliError);
    }
  });

  test("unrecognisable shapes are refused with the accepted forms", () => {
    for (const bad of ["", "abc", "1h30", "h30m", "30m1h", "1h30h", "1.5.5", "1,5"]) {
      const error = catchOpCliError(() => parseDuration(bad));
      expect(error.code).toBe("USAGE_ERROR");
    }
  });

  test("calendar components stay refused on the write path the read path accepts", () => {
    // isoToHours reads P3DT1H because the instance emits it; --hours does
    // not, because the hours field of one entry carries no calendar span.
    for (const bad of ["P3DT1H", "P1D", "P1W", "1d", "1w"]) {
      const error = catchOpCliError(() => parseDuration(bad));
      expect(error.code).toBe("USAGE_ERROR");
      expect(error.hint).toContain("PT1H30M");
    }
  });
});
