import { OpCliError } from "./errors.js";

/**
 * One OpenProject APIv3 filter: a filter name, an operator symbol, and
 * the values the operator applies to (empty for value-less operators
 * such as `o` and `c`). Multiple values inside one clause are OR; the
 * list of clauses is AND.
 */
export interface WpFilter {
  readonly name: string;
  readonly operator: string;
  readonly values: ReadonlyArray<string>;
}

/**
 * The resolved flag surface shared by `wp list` and `wp count`. Every
 * array holds already-resolved ids as strings; `updatedAfter` still
 * carries the raw user input and becomes the open-ended window's start
 * date here.
 */
export interface WpListFlags {
  /**
   * The project in context, already resolved to its id. Present means
   * every clause beside it is read inside that project (#19).
   */
  readonly project?: string | undefined;
  readonly statuses?: ReadonlyArray<string> | undefined;
  readonly open?: boolean | undefined;
  readonly closed?: boolean | undefined;
  readonly types?: ReadonlyArray<string> | undefined;
  readonly assignees?: ReadonlyArray<string> | undefined;
  readonly authors?: ReadonlyArray<string> | undefined;
  readonly versions?: ReadonlyArray<string> | undefined;
  readonly categories?: ReadonlyArray<string> | undefined;
  readonly priorities?: ReadonlyArray<string> | undefined;
  readonly parents?: ReadonlyArray<string> | undefined;
  readonly updatedAfter?: string | undefined;
  /** Substring matched against subjects through the API's `~` operator. */
  readonly search?: string | undefined;
  readonly createdAfter?: string | undefined;
}

const DATE_FORMS = "today, yesterday, a number of days such as 7d, or an explicit YYYY-MM-DD date";

export function isoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${String(date.getFullYear())}-${month}-${day}`;
}

function isCalendarDate(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return false;
  }
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(5, 7));
  const day = Number(raw.slice(8, 10));
  const probe = new Date(year, month - 1, day);
  return (
    probe.getFullYear() === year
    && probe.getMonth() === month - 1
    && probe.getDate() === day
  );
}

function daysAgo(now: Date, days: number): Date {
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - days,
  );
}

/**
 * The shared grammar of every window date flag: today, yesterday, N
 * days back, or an explicit date, all in local time. `flag` names the
 * flag in the error messages.
 */
function parseWindowDate(raw: string, now: Date, flag: string): string {
  const token = raw.trim().toLowerCase();
  if (token === "today") {
    return isoDate(now);
  }
  if (token === "yesterday") {
    return isoDate(daysAgo(now, 1));
  }
  const relative = /^(\d+)d$/.exec(token);
  if (relative !== null) {
    const days = Number(relative[1]);
    if (days >= 1) {
      return isoDate(daysAgo(now, days));
    }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(token)) {
    if (!isCalendarDate(token)) {
      throw new OpCliError(
        "USAGE_ERROR",
        `"${raw}" is not a real date.`,
        `${flag} accepts ${DATE_FORMS}.`,
      );
    }
    return token;
  }
  throw new OpCliError(
    "USAGE_ERROR",
    `cannot read "${raw}" as a ${flag.slice(2)} value.`,
    `${flag} accepts ${DATE_FORMS}.`,
  );
}

/**
 * The date a window opens at. The future check keeps the opening
 * anchored in the past (#24 grammar).
 */
export function sinceDate(
  raw: string,
  now: Date,
  flag = "--updated-after",
): string {
  const token = parseWindowDate(raw, now, flag);
  if (/^\d{4}-\d{2}-\d{2}$/.test(token) && token > isoDate(now)) {
    throw new OpCliError(
      "USAGE_ERROR",
      `"${raw}" is in the future.`,
      `${flag} needs a date up to today.`,
    );
  }
  return token;
}

/**
 * The `--to` input of `time list` / `time report`. Same grammar, but a
 * future end is let through: a period such as `--from 2026-08-01 --to
 * 2026-08-31` stays valid while only part of it has happened.
 */
export function untilDate(raw: string, now: Date, flag = "--to"): string {
  return parseWindowDate(raw, now, flag);
}

function unique(values: ReadonlyArray<string>): Array<string> {
  return [...new Set(values)];
}

/**
 * Build the exact filter JSON the work-packages endpoint expects. Flag
 * combinations that cannot reach the API as one query (--open with
 * --closed, either with explicit statuses) fail here so both commands
 * refuse them before any network traffic.
 */
export function buildWpFilters(
  flags: WpListFlags,
  now: Date,
): ReadonlyArray<WpFilter> {
  if (flags.open === true && flags.closed === true) {
    throw new OpCliError(
      "USAGE_ERROR",
      "--open and --closed cannot be combined.",
      "pass only one of the two shorthands.",
    );
  }
  const statuses = unique(flags.statuses ?? []);
  if ((flags.open === true || flags.closed === true) && statuses.length > 0) {
    throw new OpCliError(
      "USAGE_ERROR",
      "--status cannot be combined with --open or --closed.",
      "list explicit statuses or use one shorthand, not both.",
    );
  }

  const filters: Array<WpFilter> = [];
  // The project leads: it is the scope every other clause narrows, and it
  // is the same clause the project-scoped collection applies internally,
  // subprojects included.
  if (flags.project !== undefined) {
    filters.push({ name: "project", operator: "=", values: [flags.project] });
  }
  if (flags.open === true) {
    filters.push({ name: "status", operator: "o", values: [] });
  } else if (flags.closed === true) {
    filters.push({ name: "status", operator: "c", values: [] });
  } else if (statuses.length > 0) {
    filters.push({ name: "status", operator: "=", values: statuses });
  }
  if ((flags.types ?? []).length > 0) {
    filters.push({ name: "type", operator: "=", values: unique(flags.types!) });
  }
  if ((flags.assignees ?? []).length > 0) {
    filters.push({ name: "assigned_to", operator: "=", values: unique(flags.assignees!) });
  }
  if ((flags.authors ?? []).length > 0) {
    filters.push({ name: "author", operator: "=", values: unique(flags.authors!) });
  }
  if ((flags.versions ?? []).length > 0) {
    filters.push({ name: "version", operator: "=", values: unique(flags.versions!) });
  }
  if ((flags.categories ?? []).length > 0) {
    filters.push({ name: "category", operator: "=", values: unique(flags.categories!) });
  }
  if ((flags.priorities ?? []).length > 0) {
    filters.push({ name: "priority", operator: "=", values: unique(flags.priorities!) });
  }
  if ((flags.parents ?? []).length > 0) {
    filters.push({ name: "parent", operator: "=", values: unique(flags.parents!) });
  }
  if (flags.search !== undefined) {
    if (flags.search.trim() === "") {
      throw new OpCliError(
        "USAGE_ERROR",
        "--search needs text to match against subjects.",
        "pass a substring, e.g. --search login.",
      );
    }
    // The only substring clause: `~` is the API's contains operator,
    // matched server-side so case and diacritics follow the instance.
    filters.push({ name: "subject", operator: "~", values: [flags.search.trim()] });
  }
  if (flags.createdAfter !== undefined) {
    const since = sinceDate(flags.createdAfter, now, "--created-after");
    filters.push({
      name: "created_at",
      operator: "<>d",
      // Open upper bound, same reason as updated_at (#24).
      values: [since, ""],
    });
  }
  if (flags.updatedAfter !== undefined) {
    const since = sinceDate(flags.updatedAfter, now);
    filters.push({
      name: "updated_at",
      operator: "<>d",
      // The empty upper bound is the fix for #24: a closed one drops
      // everything changed during its own day.
      values: [since, ""],
    });
  }
  return filters;
}

/**
 * Serialise clauses into the URL-encoded `filters` query parameter
 * value, in wire shape: one object per clause keyed by filter name.
 */
export function filtersQuery(filters: ReadonlyArray<WpFilter>): string {
  const wire = filters.map((filter) => ({
    [filter.name]: { operator: filter.operator, values: [...filter.values] },
  }));
  return encodeURIComponent(JSON.stringify(wire));
}
