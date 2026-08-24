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
 * carries the raw user input and is turned into a date window here.
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
 * Turn the raw `--updated-after` input into the inclusive local date
 * window the API's `<>d` operator expects: today means the single day,
 * yesterday runs from yesterday through today, Nd from N days ago
 * through today, and an explicit date from that date through today (a
 * work package cannot be updated in the future, so the open upper bound
 * is always today).
 */
export function updatedAtRange(
  raw: string,
  now: Date,
): { readonly start: string; readonly end: string } {
  const token = raw.trim().toLowerCase();
  const today = isoDate(now);
  if (token === "today") {
    return { start: today, end: today };
  }
  if (token === "yesterday") {
    return { start: isoDate(daysAgo(now, 1)), end: today };
  }
  const relative = /^(\d+)d$/.exec(token);
  if (relative !== null) {
    const days = Number(relative[1]);
    if (days >= 1) {
      return { start: isoDate(daysAgo(now, days)), end: today };
    }
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(token)) {
    if (!isCalendarDate(token)) {
      throw new OpCliError(
        "USAGE_ERROR",
        `"${raw}" is not a real date.`,
        `--updated-after accepts ${DATE_FORMS}.`,
      );
    }
    if (token > today) {
      throw new OpCliError(
        "USAGE_ERROR",
        `"${raw}" is in the future.`,
        "--updated-after needs a date up to today.",
      );
    }
    return { start: token, end: today };
  }
  throw new OpCliError(
    "USAGE_ERROR",
    `cannot read "${raw}" as an updated-after value.`,
    `--updated-after accepts ${DATE_FORMS}.`,
  );
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
  if (flags.updatedAfter !== undefined) {
    const range = updatedAtRange(flags.updatedAfter, now);
    filters.push({
      name: "updated_at",
      operator: "<>d",
      values: [range.start, range.end],
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
