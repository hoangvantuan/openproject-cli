import { describe, expect, test } from "vitest";

import { OpCliError } from "../src/core/errors.js";
import {
  buildWpFilters,
  filtersQuery,
  updatedAtRange,
  type WpListFlags,
} from "../src/core/filters.js";

function catchUsage(run: () => unknown): OpCliError | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof OpCliError ? error : undefined;
  }
}

// A fixed moment so relative windows are deterministic regardless of the
// machine clock: 2026-08-23 (local).
const NOW = new Date(2026, 7, 23, 10, 30, 0);

describe("buildWpFilters", () => {
  test("no flags produce no filters", () => {
    expect(buildWpFilters({}, NOW)).toEqual([]);
  });

  test("status ids map to the status filter with the = operator", () => {
    expect(buildWpFilters({ statuses: ["1", "5"] }, NOW)).toEqual([
      { name: "status", operator: "=", values: ["1", "5"] },
    ]);
  });

  test("--open maps to the o operator with no values", () => {
    expect(buildWpFilters({ open: true }, NOW)).toEqual([
      { name: "status", operator: "o", values: [] },
    ]);
  });

  test("--closed maps to the c operator with no values", () => {
    expect(buildWpFilters({ closed: true }, NOW)).toEqual([
      { name: "status", operator: "c", values: [] },
    ]);
  });

  test("--open and --closed together are refused", () => {
    expect(() => buildWpFilters({ open: true, closed: true }, NOW)).toThrow(
      /--open and --closed/,
    );
  });

  test("open or closed cannot be combined with explicit statuses", () => {
    expect(() =>
      buildWpFilters({ open: true, statuses: ["1"] }, NOW),
    ).toThrow(/--status/);
    expect(() =>
      buildWpFilters({ closed: true, statuses: ["1"] }, NOW),
    ).toThrow(/--status/);
  });

  test("every value filter maps to its API filter name with =", () => {
    const filters = buildWpFilters(
      {
        types: ["6"],
        assignees: ["9"],
        authors: ["5"],
        versions: ["21"],
        categories: ["4"],
        priorities: ["3"],
        parents: ["1520"],
      },
      NOW,
    );
    expect(filters).toEqual([
      { name: "type", operator: "=", values: ["6"] },
      { name: "assigned_to", operator: "=", values: ["9"] },
      { name: "author", operator: "=", values: ["5"] },
      { name: "version", operator: "=", values: ["21"] },
      { name: "category", operator: "=", values: ["4"] },
      { name: "priority", operator: "=", values: ["3"] },
      { name: "parent", operator: "=", values: ["1520"] },
    ]);
  });

  test("repeated values become one OR clause in arrival order", () => {
    const filters = buildWpFilters(
      { statuses: ["1", "5", "9"], types: ["2", "6"] },
      NOW,
    );
    expect(filters).toEqual([
      { name: "status", operator: "=", values: ["1", "5", "9"] },
      { name: "type", operator: "=", values: ["2", "6"] },
    ]);
  });

  test("duplicate values collapse", () => {
    expect(buildWpFilters({ statuses: ["1", "1"] }, NOW)).toEqual([
      { name: "status", operator: "=", values: ["1"] },
    ]);
  });

  test("clauses appear in one stable order regardless of flag order", () => {
    const first = buildWpFilters(
      { priorities: ["3"], statuses: ["1"], updatedAfter: "today" },
      NOW,
    );
    const second = buildWpFilters(
      { updatedAfter: "today", statuses: ["1"], priorities: ["3"] },
      NOW,
    );
    expect(first.map((filter) => filter.name)).toEqual([
      "status",
      "priority",
      "updated_at",
    ]);
    expect(second).toEqual(first);
  });

  test("updatedAfter today is the single-day window ending today", () => {
    expect(buildWpFilters({ updatedAfter: "today" }, NOW)).toEqual([
      { name: "updated_at", operator: "<>d", values: ["2026-08-23", "2026-08-23"] },
    ]);
  });

  test("updatedAfter yesterday runs from yesterday through today", () => {
    expect(buildWpFilters({ updatedAfter: "yesterday" }, NOW)).toEqual([
      { name: "updated_at", operator: "<>d", values: ["2026-08-22", "2026-08-23"] },
    ]);
  });

  test("updatedAfter 7d runs from seven days ago through today", () => {
    expect(buildWpFilters({ updatedAfter: "7d" }, NOW)).toEqual([
      { name: "updated_at", operator: "<>d", values: ["2026-08-16", "2026-08-23"] },
    ]);
  });

  test("updatedAfter accepts an explicit ISO date", () => {
    expect(buildWpFilters({ updatedAfter: "2026-08-01" }, NOW)).toEqual([
      { name: "updated_at", operator: "<>d", values: ["2026-08-01", "2026-08-23"] },
    ]);
  });
  test("updatedAfter rejects tokens it cannot read", () => {
    const caught = catchUsage(() => buildWpFilters({ updatedAfter: "last week" }, NOW));
    expect(caught?.code).toBe("USAGE_ERROR");
    expect(caught?.hint).toMatch(/yesterday.*7d.*YYYY-MM-DD/s);
    const second = catchUsage(() => buildWpFilters({ updatedAfter: "7x" }, NOW));
    expect(second?.hint).toMatch(/yesterday.*7d.*YYYY-MM-DD/s);
  });

  test("updatedAfter rejects impossible and future dates", () => {
    expect(() =>
      buildWpFilters({ updatedAfter: "2026-02-30" }, NOW),
    ).toThrow(/not a real date/);
    expect(() =>
      buildWpFilters({ updatedAfter: "2026-08-24" }, NOW),
    ).toThrow(/in the future/);
  });
});

describe("updatedAtRange", () => {
  test.each([
    ["today", "2026-08-23", "2026-08-23"],
    ["yesterday", "2026-08-22", "2026-08-23"],
    ["1d", "2026-08-22", "2026-08-23"],
    ["7d", "2026-08-16", "2026-08-23"],
    ["30d", "2026-07-24", "2026-08-23"],
    ["2026-08-01", "2026-08-01", "2026-08-23"],
  ])("%s -> [%s, %s]", (raw, start, end) => {
    expect(updatedAtRange(raw, NOW)).toEqual({ start, end });
  });

  test("month and year boundaries roll back correctly", () => {
    const march = new Date(2026, 2, 3, 8, 0, 0);
    expect(updatedAtRange("3d", march)).toEqual({
      start: "2026-02-28",
      end: "2026-03-03",
    });
  });
});

describe("filtersQuery", () => {
  test("serialises clauses into the URL-encoded JSON the API expects", () => {
    const flags: WpListFlags = { open: true, parents: ["123"] };
    expect(filtersQuery(buildWpFilters(flags, NOW))).toBe(
      encodeURIComponent(
        '[{"status":{"operator":"o","values":[]}},' +
          '{"parent":{"operator":"=","values":["123"]}}]',
      ),
    );
  });
});
