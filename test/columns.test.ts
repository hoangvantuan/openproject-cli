import { describe, expect, test } from "vitest";

import {
  CATEGORY_COLUMNS,
  LIST_COLUMNS as PROJECT_LIST_COLUMNS,
  TYPE_COLUMNS,
  VERSION_COLUMNS,
} from "../src/commands/project.js";
import {
  LIST_COLUMNS as TIME_LIST_COLUMNS,
  timeEntryRecord,
} from "../src/commands/time.js";
import {
  COMMENT_COLUMNS,
  HISTORY_COLUMNS,
  LIST_COLUMNS as WP_LIST_COLUMNS,
  RELATION_COLUMNS,
  SCHEMA_COLUMNS,
  activityRow,
  commentRow,
  relationRow,
  schemaRows,
} from "../src/commands/wp.js";
import { flattenHalRecord } from "../src/core/hal.js";

// Issue #32, gap 5: nothing forced a declared column's `field` to exist on
// the record shape it renders, so #30 (a renamed API field behind an
// unchanged table) passed every mocked echo-back. One generic pass over
// every CollectionColumn declaration in the CLI closes that class: each
// set is rendered through the exact pipeline production uses, and every
// declared field must come back defined.

/**
 * A representative element in the exact wire shape the instance sends.
 * These are not minimal stubs: every link carries the href form the live
 * API uses, durations spell whatever crosses a day boundary, and the
 * activity kinds are prefixed the way the activities collection does.
 */
const WP_ELEMENT = {
  _type: "WorkPackage",
  id: 1520,
  lockVersion: 7,
  subject: "Fix login redirect",
  description: { format: "markdown", raw: "Repro: open /login." },
  startDate: "2026-08-10",
  dueDate: null,
  updatedAt: "2026-08-23T09:15:00Z",
  _links: {
    self: { href: "/api/v3/work_packages/1520" },
    type: { href: "/api/v3/types/2", title: "Task" },
    status: { href: "/api/v3/statuses/1", title: "In progress" },
    priority: { href: "/api/v3/priorities/3", title: "High" },
    assignee: { href: "/api/v3/users/9", title: "Linh Nguyen" },
    project: { href: "/api/v3/projects/13", title: "Operations" },
  },
};

const COMMENT_ACTIVITY_ELEMENT = {
  _type: "Activity::Comment",
  id: 891,
  comment: {
    format: "markdown",
    raw: "Deployed to staging.",
    html: "<p>Deployed to staging.</p>",
  },
  createdAt: "2026-08-21T09:30:12Z",
  _links: {
    self: { href: "/api/v3/work_packages/1520/activities/891" },
    // A real instance links the author by href alone; the resolver fills
    // the name in a second pass, so the row itself must still exist.
    user: { href: "/api/v3/users/5" },
  },
};

const EDIT_ACTIVITY_ELEMENT = {
  ...COMMENT_ACTIVITY_ELEMENT,
  _type: "Activity::Edit",
  comment: { format: "markdown", raw: "", html: "" },
};

const RELATION_ELEMENT = {
  _type: "Relation",
  id: 402,
  type: "follows",
  reverseType: "precedes",
  // Any relation spanning 24 hours or more arrives spelled with a day
  // component; the LAG column renders it verbatim.
  lag: "P3DT1H",
  description: null,
  _links: {
    self: { href: "/api/v3/relations/402" },
    from: { href: "/api/v3/work_packages/1520", title: "Fix login redirect" },
    to: { href: "/api/v3/work_packages/1604", title: "Release 0.9" },
  },
};

const SCHEMA_ELEMENT = {
  _type: "Schema",
  _links: { self: { href: "/api/v3/work_packages/schemas/13-2" } },
  id: { _type: "Schema", name: "ID", type: "Integer", required: true, writable: false },
  subject: { _type: "Schema", name: "Subject", type: "String", required: true, writable: true },
  customField6: {
    _type: "Schema",
    name: "Bug Type",
    type: "CustomOption",
    required: false,
    writable: true,
  },
};

const TIME_ENTRY_ELEMENT = {
  _type: "TimeEntry",
  id: 3001,
  hours: "P1DT2H",
  spentOn: "2026-08-21",
  comment: {
    format: "markdown",
    raw: "pairing session",
    html: "<p>pairing session</p>",
  },
  createdOn: "2026-08-21T18:00:00Z",
  _links: {
    self: { href: "/api/v3/time_entries/3001" },
    workPackage: { href: "/api/v3/work_packages/1520", title: "Fix login redirect" },
    project: { href: "/api/v3/projects/13", title: "Operations" },
    user: { href: "/api/v3/users/9", title: "Linh Nguyen" },
    activity: { href: "/api/v3/time_entries/activities/1", title: "Development" },
  },
};

const PROJECT_ELEMENT = {
  _type: "Project",
  id: 13,
  identifier: "operations",
  name: "Operations",
  active: true,
  public: false,
  favorited: false,
  createdAt: "2026-08-01T09:15:00Z",
  updatedAt: "2026-08-20T14:02:11Z",
  _links: { self: { href: "/api/v3/projects/13" } },
};

const VERSION_ELEMENT = {
  _type: "Version",
  id: 31,
  name: "0.9.0",
  status: "open",
  createdAt: "2026-07-01T10:00:00Z",
  updatedAt: "2026-08-01T10:00:00Z",
  _links: {
    self: { href: "/api/v3/projects/13/versions/31" },
    project: { href: "/api/v3/projects/13", title: "Operations" },
  },
};

const CATEGORY_ELEMENT = {
  _type: "Category",
  id: 44,
  name: "Billing",
  _links: {
    self: { href: "/api/v3/projects/13/categories/44" },
    project: { href: "/api/v3/projects/13", title: "Operations" },
  },
};

const PROJECT_TYPE_ELEMENT = {
  _type: "Type",
  id: 6,
  name: "User Story",
  isMilestone: false,
  _links: { self: { href: "/api/v3/projects/13/types/6" } },
};

interface ColumnSet {
  /** The command surface whose table the columns declare. */
  readonly name: string;
  readonly columns: ReadonlyArray<{ readonly field: string }>;
  /** The same record mapping the rendering path runs. */
  readonly render: (element: unknown) => ReadonlyArray<Record<string, unknown>>;
  readonly element: unknown;
}

const COLUMN_SETS: ReadonlyArray<ColumnSet> = [
  {
    name: "wp list",
    columns: WP_LIST_COLUMNS,
    render: (element) => [flattenHalRecord(element)],
    element: WP_ELEMENT,
  },
  {
    name: "wp comments",
    columns: COMMENT_COLUMNS,
    render: (element) => {
      const row = commentRow(element);
      return row === undefined ? [] : [row];
    },
    element: COMMENT_ACTIVITY_ELEMENT,
  },
  {
    name: "wp history",
    columns: HISTORY_COLUMNS,
    render: (element) => [activityRow(element)],
    element: EDIT_ACTIVITY_ELEMENT,
  },
  {
    name: "wp relations",
    columns: RELATION_COLUMNS,
    render: (element) => [relationRow(element)],
    element: RELATION_ELEMENT,
  },
  {
    name: "wp schema",
    columns: SCHEMA_COLUMNS,
    render: (element) => schemaRows(element),
    element: SCHEMA_ELEMENT,
  },
  {
    name: "time list",
    columns: TIME_LIST_COLUMNS,
    render: (element) => [timeEntryRecord(element)],
    element: TIME_ENTRY_ELEMENT,
  },
  {
    name: "project list",
    columns: PROJECT_LIST_COLUMNS,
    render: (element) => [flattenHalRecord(element)],
    element: PROJECT_ELEMENT,
  },
  {
    name: "project versions",
    columns: VERSION_COLUMNS,
    render: (element) => [flattenHalRecord(element)],
    element: VERSION_ELEMENT,
  },
  {
    name: "project categories",
    columns: CATEGORY_COLUMNS,
    render: (element) => [flattenHalRecord(element)],
    element: CATEGORY_ELEMENT,
  },
  {
    name: "project types",
    columns: TYPE_COLUMNS,
    render: (element) => [flattenHalRecord(element)],
    element: PROJECT_TYPE_ELEMENT,
  },
];

describe("every declared column exists on the record it renders", () => {
  for (const set of COLUMN_SETS) {
    test(set.name, () => {
      const rows = set.render(set.element);
      expect(rows.length, `${set.name}: the fixture produced no row`).toBeGreaterThan(0);
      for (const row of rows) {
        for (const column of set.columns) {
          expect(
            column.field in row,
            `${set.name}: declared column "${column.field}" is absent from the rendered record`,
          ).toBe(true);
          expect(
            row[column.field],
            `${set.name}: declared column "${column.field}" renders as undefined`,
          ).not.toBeUndefined();
        }
      }
    });
  }
});

describe("the column fixtures track the wire shapes they stand in for", () => {
  test("wp list flattens links into named resources beside scalars", () => {
    const row = flattenHalRecord(WP_ELEMENT);
    expect(row.type).toEqual({ id: 2, name: "Task" });
    expect(row.status).toEqual({ id: 1, name: "In progress" });
    expect(row.assignee).toEqual({ id: 9, name: "Linh Nguyen" });
    expect(row.subject).toBe("Fix login redirect");
  });

  test("wp history derives KIND from the prefixed _type and keeps the raw text", () => {
    const row = activityRow(COMMENT_ACTIVITY_ELEMENT);
    expect(row.kind).toBe("Comment");
    expect(row.comment).toBe("Deployed to staging.");
    expect(row.user).toEqual({ id: 5, name: null });
  });

  test("wp comments keeps only Comment-kind activities", () => {
    expect(commentRow(COMMENT_ACTIVITY_ELEMENT)).toBeDefined();
    expect(commentRow(EDIT_ACTIVITY_ELEMENT)).toBeUndefined();
  });

  test("wp relations keep both ends and the day-spelled lag verbatim", () => {
    const row = relationRow(RELATION_ELEMENT);
    expect(row.lag).toBe("P3DT1H");
    expect(row.from).toEqual({ id: 1520, name: "Fix login redirect" });
    expect(row.to).toEqual({ id: 1604, name: "Release 0.9" });
  });

  test("wp schema walks plain fields and custom fields alike", () => {
    const fields = schemaRows(SCHEMA_ELEMENT).map((row) => row.field);
    expect(fields).toEqual(["id", "subject", "customField6"]);
  });

  test("time entries report a day-crossing duration as decimal beside ISO", () => {
    const row = timeEntryRecord(TIME_ENTRY_ELEMENT);
    expect(row.hours).toBe(26);
    expect(row.hours_iso).toBe("P1DT2H");
    expect(row.wp).toEqual({ id: 1520, name: "Fix login redirect" });
  });

  test("project vocabulary elements expose the attributes their tables name", () => {
    expect(flattenHalRecord(VERSION_ELEMENT).status).toBe("open");
    expect(flattenHalRecord(PROJECT_TYPE_ELEMENT).isMilestone).toBe(false);
    expect(flattenHalRecord(PROJECT_ELEMENT).favorited).toBe(false);
  });
});
