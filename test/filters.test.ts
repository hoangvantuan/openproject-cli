import { describe, expect, test } from "vitest";

import { OpCliError } from "../src/core/errors.js";
import {
  buildWpFilters,
  filtersQuery,
  sinceDate,
  untilDate,
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

  test("a project in context becomes a project clause", () => {
    expect(buildWpFilters({ project: "33" }, NOW)).toEqual([
      { name: "project", operator: "=", values: ["33"] },
    ]);
  });

  test("the project clause leads and narrows every clause beside it", () => {
    const filters = buildWpFilters(
      { project: "33", statuses: ["1"], priorities: ["3"], updatedAfter: "today" },
      NOW,
    );
    expect(filters.map((filter) => filter.name)).toEqual([
      "project",
      "status",
      "priority",
      "updated_at",
    ]);
    expect(filters[0]).toEqual({ name: "project", operator: "=", values: ["33"] });
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
        accountables: ["8"],
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
      { name: "responsible", operator: "=", values: ["8"] },
      { name: "author", operator: "=", values: ["5"] },
      { name: "version", operator: "=", values: ["21"] },
      { name: "category", operator: "=", values: ["4"] },
      { name: "priority", operator: "=", values: ["3"] },
      { name: "parent", operator: "=", values: ["1520"] },
    ]);
  });

  test("sprints and buckets map to their link filters with = (#46)", () => {
    expect(buildWpFilters({ sprints: ["58", "57", "58"] }, NOW)).toEqual([
      { name: "sprint", operator: "=", values: ["58", "57"] },
    ]);
    expect(buildWpFilters({ buckets: ["2"] }, NOW)).toEqual([
      { name: "backlogBucket", operator: "=", values: ["2"] },
    ]);
  });

  test("inbox is the backlogInbox boolean, spelled t on the wire (#46)", () => {
    const filters = buildWpFilters({ project: "16", backlogInbox: true }, NOW);
    expect(filters).toEqual([
      { name: "project", operator: "=", values: ["16"] },
      { name: "backlogInbox", operator: "=", values: ["t"] },
    ]);
    expect(decodeURIComponent(filtersQuery(filters))).toBe(
      '[{"project":{"operator":"=","values":["16"]}},'
        + '{"backlogInbox":{"operator":"=","values":["t"]}}]',
    );
  });

  test("a work package sits in one of sprint, bucket, or inbox, so mixing them is refused (#46)", () => {
    for (const flags of [
      { sprints: ["58"], buckets: ["2"] },
      { sprints: ["58"], backlogInbox: true },
      { buckets: ["2"], backlogInbox: true },
    ] satisfies ReadonlyArray<WpListFlags>) {
      const error = catchUsage(() => buildWpFilters(flags, NOW));
      expect(error?.code).toBe("USAGE_ERROR");
    }
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

  test("updatedAfter today opens at today and never closes", () => {
    expect(buildWpFilters({ updatedAfter: "today" }, NOW)).toEqual([
      { name: "updated_at", operator: "<>d", values: ["2026-08-23", ""] },
    ]);
  });

  test("updatedAfter yesterday opens at yesterday and never closes", () => {
    expect(buildWpFilters({ updatedAfter: "yesterday" }, NOW)).toEqual([
      { name: "updated_at", operator: "<>d", values: ["2026-08-22", ""] },
    ]);
  });

  test("updatedAfter 7d opens seven days back and never closes", () => {
    expect(buildWpFilters({ updatedAfter: "7d" }, NOW)).toEqual([
      { name: "updated_at", operator: "<>d", values: ["2026-08-16", ""] },
    ]);
  });

  test("updatedAfter accepts an explicit ISO date", () => {
    expect(buildWpFilters({ updatedAfter: "2026-08-01" }, NOW)).toEqual([
      { name: "updated_at", operator: "<>d", values: ["2026-08-01", ""] },
    ]);
  });

  // The guard for #24: a closed upper bound is read as the start of that
  // day, so anything changed during it drops out. No form may emit one.
  test("no accepted form ever closes the upper bound", () => {
    for (const raw of ["today", "yesterday", "1d", "7d", "30d", "2026-08-01"]) {
      const [clause] = buildWpFilters({ updatedAfter: raw }, NOW);
      expect(clause, raw).toEqual({
        name: "updated_at",
        operator: "<>d",
        values: [expect.any(String), ""],
      });
    }
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

  test("search becomes a subject contains clause", () => {
    expect(buildWpFilters({ search: "login" }, NOW)).toEqual([
      { name: "subject", operator: "~", values: ["login"] },
    ]);
  });

  test("search of only whitespace is refused", () => {
    const caught = catchUsage(() => buildWpFilters({ search: "  " }, NOW));
    expect(caught?.code).toBe("USAGE_ERROR");
    expect(caught?.message).toContain("--search needs text");
  });

  test("createdAfter opens an open-ended window on created_at", () => {
    expect(buildWpFilters({ createdAfter: "7d" }, NOW)).toEqual([
      { name: "created_at", operator: "<>d", values: ["2026-08-16", ""] },
    ]);
  });

  test("createdAfter names its own flag when refusing input", () => {
    const caught = catchUsage(() =>
      buildWpFilters({ createdAfter: "2026-08-24" }, NOW),
    );
    expect(caught?.hint).toContain("--created-after");
    expect(catchUsage(() =>
      buildWpFilters({ createdAfter: "soon" }, NOW),
    )?.hint).toContain("--created-after accepts");
  });
});

describe("sinceDate", () => {
  test.each([
    ["today", "2026-08-23"],
    ["yesterday", "2026-08-22"],
    ["1d", "2026-08-22"],
    ["7d", "2026-08-16"],
    ["30d", "2026-07-24"],
    ["2026-08-01", "2026-08-01"],
  ])("%s -> %s", (raw, start) => {
    expect(sinceDate(raw, NOW)).toBe(start);
  });

  test("month and year boundaries roll back correctly", () => {
    const march = new Date(2026, 2, 3, 8, 0, 0);
    expect(sinceDate("3d", march)).toBe("2026-02-28");
  });
});

describe("untilDate", () => {
  test.each([
    ["today", "2026-08-23"],
    ["yesterday", "2026-08-22"],
    ["7d", "2026-08-16"],
    ["2026-08-01", "2026-08-01"],
  ])("%s -> %s", (raw, end) => {
    expect(untilDate(raw, NOW)).toBe(end);
  });

  test("a future explicit date is let through: a period may be partly ahead", () => {
    expect(untilDate("2026-09-30", NOW)).toBe("2026-09-30");
  });

  test("tokens it cannot read are refused with the flag named", () => {
    const caught = catchUsage(() => untilDate("next week", NOW));
    expect(caught?.code).toBe("USAGE_ERROR");
    expect(caught?.message).toContain("cannot read \"next week\" as a to value");
    expect(caught?.hint).toContain("--to accepts");
  });
});

describe("filtersQuery", () => {
  test("a project clause reaches the wire as the leading filter", () => {
    expect(filtersQuery(buildWpFilters({ project: "33", open: true }, NOW))).toBe(
      encodeURIComponent(
        '[{"project":{"operator":"=","values":["33"]}},' +
          '{"status":{"operator":"o","values":[]}}]',
      ),
    );
  });


  test("serialises clauses into the URL-encoded JSON the API expects", () => {
    const flags: WpListFlags = { open: true, parents: ["123"] };
    expect(filtersQuery(buildWpFilters(flags, NOW))).toBe(
      encodeURIComponent(
        '[{"status":{"operator":"o","values":[]}},' +
          '{"parent":{"operator":"=","values":["123"]}}]',
      ),
    );
  });

describe("due-date filters", () => {
  test("--due-before is an open-lower window", () => {
    expect(buildWpFilters({ dueBefore: "2026-09-30" }, NOW)).toEqual([
      { name: "dueDate", operator: "<>d", values: ["", "2026-09-30"] },
    ]);
  });

  test("--due-after is an open-upper window", () => {
    expect(buildWpFilters({ dueAfter: "2026-09-01" }, NOW)).toEqual([
      { name: "dueDate", operator: "<>d", values: ["2026-09-01", ""] },
    ]);
  });

  test("both bounds share one clause", () => {
    expect(
      buildWpFilters({ dueAfter: "2026-09-01", dueBefore: "2026-09-30" }, NOW),
    ).toEqual([{ name: "dueDate", operator: "<>d", values: ["2026-09-01", "2026-09-30"] }]);
  });

  test("--overdue is open work due up to yesterday", () => {
    expect(buildWpFilters({ overdue: true }, NOW)).toEqual([
      { name: "status", operator: "o", values: [] },
      { name: "dueDate", operator: "<>d", values: ["", "2026-08-22"] },
    ]);
  });

  test("--overdue keeps an explicit --open to one status clause and an earlier --due-before", () => {
    expect(buildWpFilters({ overdue: true, open: true, dueBefore: "2026-08-01" }, NOW)).toEqual([
      { name: "status", operator: "o", values: [] },
      { name: "dueDate", operator: "<>d", values: ["", "2026-08-01"] },
    ]);
  });

  test("--overdue refuses --closed", () => {
    expect(catchUsage(() => buildWpFilters({ overdue: true, closed: true }, NOW))?.code)
      .toBe("USAGE_ERROR");
  });

  test("an empty window and a bad date are usage errors", () => {
    expect(catchUsage(() => buildWpFilters({ dueAfter: "2026-10-01", dueBefore: "2026-09-01" }, NOW))?.code)
      .toBe("USAGE_ERROR");
    expect(catchUsage(() => buildWpFilters({ dueBefore: "2026-02-30" }, NOW))?.code)
      .toBe("USAGE_ERROR");
  });
});

});
