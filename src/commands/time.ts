import type { Command } from "commander";

import { PAGED_JSON_HELP } from "../core/define.js";
import { isoToHours, parseDuration } from "../core/duration.js";
import { OpCliError, writeRefusal } from "../core/errors.js";
import { filtersQuery, isoDate, sinceDate, type WpFilter } from "../core/filters.js";
import {
  flattenHalRecord,
  formattableRaw,
  isFlatLink,
  toFormattable,
  type FlatLink,
} from "../core/hal.js";
import {
  apiDelete,
  apiGet,
  apiPatchRaw,
  apiPostRaw,
  authenticate,
  type RawWriteResponse,
} from "../core/http.js";
import { allPageSize, halElements, parsePageSize, withPageSize } from "../core/paginate.js";
import {
  isIdForm,
  rankByCloseness,
  resolveName,
  type LookupSource,
} from "../context/resolve.js";
import {
  parseOptionalId,
  type ActiveProfile,
  type ContextOverrides,
} from "../context/profile.js";
import {
  loadProjectVocabulary,
  loadProjectVocabularyById,
  refreshStoredMetadata,
  type StoredMember,
} from "../context/metadata.js";
import type { RunEnvironment } from "../run.js";
import { formatCell, renderTable } from "../output/table.js";

export interface TimeRuntime {
  readonly env: RunEnvironment;
  readonly resolve: (overrides?: ContextOverrides) => Promise<ActiveProfile>;
  readonly write: (text: string) => void;
  readonly writeErr: (text: string) => void;
  readonly setJsonMode: (on: boolean) => void;
}

// One flat row per time entry; the work package sits on every row so a
// multi-wp listing stays a single table instead of a nested grouping.
export const LIST_COLUMNS: ReadonlyArray<{ readonly title: string; readonly field: string }> = [
  { title: "ID", field: "id" },
  { title: "WORK PACKAGE", field: "wp" },
  { title: "HOURS", field: "hours" },
  { title: "SPENT ON", field: "spentOn" },
  { title: "USER", field: "user" },
  { title: "ACTIVITY", field: "activity" },
];

// Canonical field order of a single-record view; hours always reports
// decimal, with the ISO wire form kept beside it under hours_iso.
const RECORD_FIELDS = [
  "id",
  "wp",
  "hours",
  "hours_iso",
  "spentOn",
  "user",
  "activity",
  "project",
  "comment",
] as const;

/**
 * The flat caller-facing record of one HAL time entry. Links shrink to
 * {id, name}, hours becomes a decimal number, and the entity_type /
 * entity_id filter machinery never appears anywhere.
 */
export function timeEntryRecord(element: unknown): Record<string, unknown> {
  const flat = flattenHalRecord(element);
  const iso = typeof flat.hours === "string" ? flat.hours : null;
  return {
    id: typeof flat.id === "number" ? flat.id : null,
    wp: (flat.workPackage as FlatLink | undefined) ?? null,
    hours: iso === null ? null : isoToHours(iso),
    hours_iso: iso,
    spentOn: typeof flat.spentOn === "string" ? flat.spentOn : null,
    user: (flat.user as FlatLink | undefined) ?? null,
    activity: (flat.activity as FlatLink | undefined) ?? null,
    project: (flat.project as FlatLink | undefined) ?? null,
    comment: formattableRaw(flat.comment),
  };
}

function renderTimeEntries(records: ReadonlyArray<Record<string, unknown>>): string {
  return renderTable(
    LIST_COLUMNS.map((column) => column.title),
    records.map((record) =>
      LIST_COLUMNS.map((column) => formatCell(record[column.field])),
    ),
  );
}

/**
 * The shared tail of every single-record command on this surface: --fields
 * validated against the known columns plus the two shapes, a FIELD/VALUE
 * table by default.
 */
function renderRecord(
  runtime: Pick<TimeRuntime, "write">,
  options: { json?: boolean; fields?: string },
  record: Record<string, unknown>,
  /**
   * What already happened when the record is the result of a completed
   * write. A bad --fields name is still misuse, but the message has to
   * say the write landed or it invites a repeat that logs twice.
   */
  done?: string,
): void {
  const fields =
    options.fields === undefined
      ? [...RECORD_FIELDS]
      : options.fields.split(",").map((name) => name.trim()).filter(
          (name) => name !== "",
        );
  const first = fields.find((name) => !(name in record));
  if (first !== undefined) {
    throw new OpCliError(
      "USAGE_ERROR",
      `${done === undefined ? "" : `${done}; `}`
        + `field "${first}" is not a column. Valid fields, closest first: `
        + `${rankByCloseness(first, [...RECORD_FIELDS]).join(", ")}.`,
      "run the command without --fields to list every available column.",
    );
  }
  if (options.json === true) {
    const picked: Record<string, unknown> = {};
    for (const field of fields) {
      picked[field] = record[field];
    }
    runtime.write(`${JSON.stringify(picked)}\n`);
    return;
  }
  runtime.write(
    renderTable(
      ["FIELD", "VALUE"],
      fields.map((field) => [field, formatCell(record[field])]),
    ),
  );
}

/** Work packages and time entries are addressed by numeric id everywhere here. */
function requireId(reference: string, noun: string): void {
  if (!isIdForm(reference)) {
    throw new OpCliError(
      "USAGE_ERROR",
      `${noun} "${reference}" is not an id.`,
      `${noun}s are addressed by their numeric id.`,
    );
  }
}

function collectValue(value: string, previous: Array<string>): Array<string> {
  return [...previous, value];
}

/** Accept both repeated flags ("--wp 675 --wp 598") and lists ("675,598"). */
function splitList(raws: ReadonlyArray<string>): Array<string> {
  return [
    ...new Set(
      raws
        .flatMap((raw) => raw.split(","))
        .map((raw) => raw.trim())
        .filter((raw) => raw !== ""),
    ),
  ];
}

/**
 * Build the exact filter JSON the time-entries endpoint expects. The trap
 * the Python predecessor documented lives here and nowhere else: the API
 * scopes by entity type and entity id, and this function is the only
 * place those names exist.
 *
 * `project` leads when a project is in context: there is no
 * project-scoped time-entry collection to address instead, so the clause
 * is the only way `--project` reaches the query at all (#19).
 */
function buildTimeFilters(
  project: number | undefined,
  wps: ReadonlyArray<string>,
  users: ReadonlyArray<string>,
  from: string | undefined,
  now: Date,
): ReadonlyArray<WpFilter> {
  const filters: Array<WpFilter> = [];
  if (project !== undefined) {
    filters.push({ name: "project", operator: "=", values: [String(project)] });
  }
  if (wps.length > 0) {
    filters.push({ name: "entity_type", operator: "=", values: ["WorkPackage"] });
    filters.push({ name: "entity_id", operator: "=", values: [...wps] });
  }
  if (users.length > 0) {
    filters.push({ name: "user_id", operator: "=", values: [...users] });
  }
  if (from !== undefined) {
    // Same date grammar as --updated-after on `wp list`, applied to
    // spent_on instead, open upper bound included (#24).
    const since = sinceDate(from, now);
    filters.push({
      name: "spent_on",
      operator: "<>d",
      values: [since, ""],
    });
  }
  return filters;
}

function membersSource(
  env: RunEnvironment,
  profile: ActiveProfile,
): LookupSource<number> {
  return {
    label: "user",
    load: async () => {
      if (profile.project === undefined) {
        throw new OpCliError(
          "USAGE_ERROR",
          "--user needs a project to look member names up in.",
          "pass --project <id> or set a default project on the profile.",
        );
      }
      const select = (
        vocabulary: { readonly members: ReadonlyArray<StoredMember> },
      ) =>
        vocabulary.members.map((member) => ({
          name: member.name,
          owner: member.type,
          value: member.user_id,
        }));
      return select(await loadProjectVocabulary(env, profile));
    },
    refresh: async () => {
      await refreshStoredMetadata(env, profile);
    },
  };
}

async function resolveUserValues(
  env: RunEnvironment,
  profile: ActiveProfile,
  raws: ReadonlyArray<string>,
): Promise<Array<string>> {
  let authenticatedId: number | undefined;
  const ids: Array<string> = [];
  const push = (id: number | string): void => {
    const key = String(id);
    if (!ids.includes(key)) {
      ids.push(key);
    }
  };
  for (const raw of raws) {
    if (raw.toLowerCase() === "me") {
      authenticatedId ??= (await authenticate(profile.instanceUrl, profile.apiKey)).id;
      push(authenticatedId);
    } else if (isIdForm(raw)) {
      push(raw);
    } else {
      push(await resolveName(raw, membersSource(env, profile)));
    }
  }
  return ids;
}

/**
 * Activities are scoped to the project of the logged work package (#5),
 * sourced from the POST /api/v3/time_entries/form payload.
 */
function activitiesSource(
  env: RunEnvironment,
  profile: ActiveProfile,
  projectId: number,
): LookupSource<number> {
  return {
    label: "activity",
    load: async () =>
      (await loadProjectVocabularyById(env, profile, projectId)).activities.map(
        (activity) => ({ name: activity.name, owner: "activity", value: activity.id }),
      ),
    refresh: async () => {
      await refreshStoredMetadata(env, profile);
    },
  };
}

/**
 * Catalogue mapping for a create that survived without retrying: 404
 * stays NOT_FOUND, 5xx means the state is unknown, everything else is
 * the shared refusal mapping.
 */
function logRejection(status: number, body: unknown): OpCliError {
  if (status === 404) {
    return new OpCliError("NOT_FOUND");
  }
  if (status >= 500) {
    return new OpCliError(
      "NETWORK_ERROR",
      `the request failed with HTTP ${String(status)}; whether the entry was recorded is unknown.`,
      "check op-cli time list before repeating the command.",
    );
  }
  return writeRefusal("entry", status, body);
}

/**
 * A create whose failure leaves the recorded state unknown: timeouts and
 * network errors are never retried on writes, and exit 6 says so instead
 * of inviting a duplicate entry.
 */
async function postEntry(
  profile: ActiveProfile,
  payload: Record<string, unknown>,
): Promise<RawWriteResponse> {
  try {
    return await apiPostRaw(
      profile.instanceUrl,
      profile.apiKey,
      "/api/v3/time_entries",
      payload,
    );
  } catch (error) {
    if (error instanceof OpCliError && error.code === "NETWORK_ERROR") {
      throw new OpCliError(
        "NETWORK_ERROR",
        "the request did not complete; whether the entry was recorded is unknown.",
        "check op-cli time list before repeating the command.",
      );
    }
    throw error;
  }
}

/**
 * Catalogue mapping for an update that survived without retrying: 404
 * stays NOT_FOUND, 5xx means the state is unknown, everything else is
 * the shared refusal mapping.
 */
function updateRejection(status: number, body: unknown): OpCliError {
  if (status === 404) {
    return new OpCliError("NOT_FOUND");
  }
  if (status >= 500) {
    return new OpCliError(
      "NETWORK_ERROR",
      `the request failed with HTTP ${String(status)}; whether the change was applied is unknown.`,
      "check op-cli time get before repeating the command.",
    );
  }
  return writeRefusal("change", status, body);
}

/** A patch whose failure leaves the stored state unknown: never retried. */
async function patchEntry(
  profile: ActiveProfile,
  id: string,
  payload: Record<string, unknown>,
): Promise<RawWriteResponse> {
  try {
    return await apiPatchRaw(
      profile.instanceUrl,
      profile.apiKey,
      `/api/v3/time_entries/${id}`,
      payload,
    );
  } catch (error) {
    if (error instanceof OpCliError && error.code === "NETWORK_ERROR") {
      throw new OpCliError(
        "NETWORK_ERROR",
        "the request did not complete; whether the change was applied is unknown.",
        "check op-cli time get before repeating the command.",
      );
    }
    throw error;
  }
}

/** A delete whose failure leaves the stored state unknown: never retried. */
async function deleteEntry(profile: ActiveProfile, id: string): Promise<void> {
  try {
    await apiDelete(profile.instanceUrl, profile.apiKey, `/api/v3/time_entries/${id}`);
  } catch (error) {
    if (error instanceof OpCliError && error.code === "NETWORK_ERROR") {
      throw new OpCliError(
        "NETWORK_ERROR",
        "the request did not complete; whether the entry was removed is unknown.",
        "check op-cli time list before repeating the command.",
      );
    }
    throw error;
  }
}

/** Strict calendar date for --spent-on: the wire form is YYYY-MM-DD. */
function requireIsoDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new OpCliError(
      "USAGE_ERROR",
      `--spent-on "${value}" is not a calendar date.`,
      "give YYYY-MM-DD, for example 2026-08-21.",
    );
  }
  return value;
}

/**
 * One shared resolution path for --activity on log and update alike:
 * id form passes through, a name resolves against the vocabulary of the
 * project the work belongs to (#5).
 */
async function resolveActivityHref(
  runtime: TimeRuntime,
  profile: ActiveProfile,
  projectId: number,
  raw: string,
): Promise<string> {
  const activityId = isIdForm(raw)
    ? Number(raw)
    : await resolveName(raw, activitiesSource(runtime.env, profile, projectId));
  return `/api/v3/time_entries/activities/${String(activityId)}`;
}

export function registerTimeCommands(time: Command, runtime: TimeRuntime): void {
  time.description("Track and inspect time entries");

  time.command("log")
    .description("Record time spent on one work package")
    .argument("<id>", "work package id")
    .requiredOption(
      "--hours <value>",
      "decimal hours such as 1.5, a compound form such as 1h30m, "
        + "or an ISO 8601 duration such as PT1H30M",
    )
    .requiredOption("--activity <name-or-id>", "activity of the project, by name or id")
    .option(
      "--spent-on <date>",
      "calendar date the hours were spent, YYYY-MM-DD; defaults to today",
    )
    .option("--json", "emit a flat JSON record")
    .option("--fields <list>", "comma-separated columns to show")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <id>", "override the profile default project")
    .action(async (reference: string, options: {
      hours: string;
      activity: string;
      spentOn?: string;
      json?: boolean;
      fields?: string;
      profile?: string;
      project?: string;
    }) => {
      runtime.setJsonMode(options.json === true);
      requireId(reference, "work package");
      const duration = parseDuration(options.hours);
      // OpenProject refuses a time entry without a date, so the wire
      // always carries one: today unless --spent-on says otherwise.
      const spentOn = options.spentOn === undefined
        ? isoDate(new Date())
        : requireIsoDate(options.spentOn);
      const profile = await runtime.resolve({
        profile: options.profile,
        project: parseOptionalId(options.project),
      });
      // The activity vocabulary hangs off the project the work package
      // belongs to, not off the profile default.
      const flatWp = flattenHalRecord(
        await apiGet(
          profile.instanceUrl,
          profile.apiKey,
          `/api/v3/work_packages/${reference}`,
        ),
      );
      const projectId = (flatWp.project as FlatLink | undefined)?.id ?? null;
      if (projectId === null) {
        throw new OpCliError(
          "API_ERROR",
          `work package ${reference} carries no project link.`,
          "check the work package on the instance.",
        );
      }
      const activityHref = await resolveActivityHref(
        runtime,
        profile,
        projectId,
        options.activity,
      );
      const response = await postEntry(profile, {
        hours: duration.iso,
        spentOn,
        _links: {
          workPackage: { href: `/api/v3/work_packages/${reference}` },
          activity: { href: activityHref },
        },
      });
      if (
        response.status < 200
        || response.status >= 300
        || response.body === undefined
      ) {
        throw logRejection(response.status, response.body);
      }
      const entry = timeEntryRecord(response.body);
      renderRecord(runtime, options, entry, `time entry ${String(entry.id)} was logged`);
    });

  time.command("list")
    .description("List time entries with the work package on every row")
    .option("--wp <id>", "work package id; repeat or comma-separate to OR values", collectValue, [])
    .option("--user <name>", "user name, id, or me; repeat to OR values", collectValue, [])
    .option("--from <date>", "today, yesterday, days back such as 7d, or YYYY-MM-DD")
    .option("--json", PAGED_JSON_HELP)
    .option("--limit <n>", "maximum number of results to show")
    .option("--all", "fetch every page instead of one limited page")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <id>", "override the profile default project")
    .action(async (options: {
      wp?: Array<string>;
      user?: Array<string>;
      from?: string;
      json?: boolean;
      limit?: string;
      all?: boolean;
      profile?: string;
      project?: string;
    }) => {
      runtime.setJsonMode(options.json === true);
      // Refuse impossible input before any traffic or resolution.
      const wps = splitList(options.wp ?? []);
      for (const wp of wps) {
        requireId(wp, "work package");
      }
      const profile = await runtime.resolve({
        profile: options.profile,
        project: parseOptionalId(options.project),
      });
      const users = await resolveUserValues(runtime.env, profile, splitList(options.user ?? []));
      const filters = buildTimeFilters(
        profile.project,
        wps,
        users,
        options.from,
        new Date(),
      );
      const limit = parsePageSize(options.limit);
      const getPage = (path: string): Promise<unknown> =>
        apiGet(profile.instanceUrl, profile.apiKey, path);
      // --all sizes pages by the instance's advertised maximum; --limit
      // only ever sizes the single non-all page.
      const startPath = withPageSize(
        `/api/v3/time_entries?filters=${filtersQuery(filters)}`,
        options.all === true ? await allPageSize(getPage) : limit,
      );

      if (options.all === true) {
        if (options.json === true) {
          for await (const element of halElements<unknown>(getPage, startPath)) {
            runtime.write(`${JSON.stringify(timeEntryRecord(element))}\n`);
          }
          return;
        }
        const rows: Array<Record<string, unknown>> = [];
        for await (const element of halElements<unknown>(getPage, startPath)) {
          rows.push(timeEntryRecord(element));
        }
        runtime.write(renderTimeEntries(rows));
        return;
      }

      const page = (await getPage(startPath)) as {
        total?: unknown;
        _embedded?: { elements?: readonly unknown[] };
      };
      const elements = page._embedded?.elements ?? [];
      const rows = elements.map((element) => timeEntryRecord(element));
      if (options.json === true) {
        runtime.write(`${JSON.stringify(rows)}\n`);
      } else {
        runtime.write(renderTimeEntries(rows));
      }
      const total = typeof page.total === "number" ? page.total : rows.length;
      if (total > rows.length) {
        runtime.writeErr(
          `Showing ${rows.length} of ${total} time entries. `
            + "Pass --all to fetch every result.\n",
        );
      }
    });

  time.command("get")
    .description("Show one time entry")
    .argument("<id>", "time entry id")
    .option("--json", "emit a flat JSON record")
    .option("--fields <list>", "comma-separated columns to show")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <id>", "override the profile default project")
    .action(async (reference: string, options: {
      json?: boolean;
      fields?: string;
      profile?: string;
      project?: string;
    }) => {
      runtime.setJsonMode(options.json === true);
      requireId(reference, "time entry");
      const profile = await runtime.resolve({
        profile: options.profile,
        project: parseOptionalId(options.project),
      });
      const record = timeEntryRecord(
        await apiGet(
          profile.instanceUrl,
          profile.apiKey,
          `/api/v3/time_entries/${reference}`,
        ),
      );
      renderRecord(runtime, options, record);
    });

  time.command("update")
    .description("Update one time entry")
    .argument("<id>", "time entry id")
    .option(
      "--hours <value>",
      "decimal hours such as 1.5, a compound form such as 1h30m, "
        + "or an ISO 8601 duration such as PT1H30M",
    )
    .option("--activity <name-or-id>", "activity of the project, by name or id")
    .option("--comment <text>", "replace the comment")
    .option("--spent-on <date>", "move the entry to this day, YYYY-MM-DD")
    .option("--json", "emit a flat JSON record")
    .option("--fields <list>", "comma-separated columns to show")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <id>", "override the profile default project")
    .action(async (reference: string, options: {
      hours?: string;
      activity?: string;
      comment?: string;
      spentOn?: string;
      json?: boolean;
      fields?: string;
      profile?: string;
      project?: string;
    }) => {
      runtime.setJsonMode(options.json === true);
      requireId(reference, "time entry");
      // Refuse impossible input before any traffic or resolution.
      const hours = options.hours === undefined
        ? undefined
        : parseDuration(options.hours);
      const spentOn = options.spentOn === undefined
        ? undefined
        : requireIsoDate(options.spentOn);
      const touchesSomething = hours !== undefined
        || options.activity !== undefined
        || options.comment !== undefined
        || spentOn !== undefined;
      if (!touchesSomething) {
        throw new OpCliError(
          "USAGE_ERROR",
          "time update needs at least one value to change.",
          "pass --hours, --activity, --comment, or --spent-on.",
        );
      }
      const profile = await runtime.resolve({
        profile: options.profile,
        project: parseOptionalId(options.project),
      });
      const payload: Record<string, unknown> = {};
      if (hours !== undefined) {
        payload.hours = hours.iso;
      }
      if (spentOn !== undefined) {
        payload.spentOn = spentOn;
      }
      if (options.comment !== undefined) {
        payload.comment = toFormattable(options.comment);
      }
      if (options.activity !== undefined) {
        // The activity vocabulary hangs off the project the entry's own
        // work package belongs to, not off the profile default.
        const flat = flattenHalRecord(
          await apiGet(profile.instanceUrl, profile.apiKey, `/api/v3/time_entries/${reference}`),
        );
        const projectId = (flat.project as FlatLink | undefined)?.id ?? null;
        if (projectId === null) {
          throw new OpCliError(
            "API_ERROR",
            `time entry ${reference} carries no project link.`,
            "check the time entry on the instance.",
          );
        }
        payload._links = {
          activity: {
            href: await resolveActivityHref(runtime, profile, projectId, options.activity),
          },
        };
      }
      const response = await patchEntry(profile, reference, payload);
      if (
        response.status < 200
        || response.status >= 300
        || response.body === undefined
      ) {
        throw updateRejection(response.status, response.body);
      }
      renderRecord(runtime, options, timeEntryRecord(response.body));
    });

  time.command("delete")
    .description("Delete one time entry after explicit confirmation")
    .argument("<id>", "time entry id")
    .option("--yes", "confirm the deletion")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <id>", "override the profile default project")
    .action(async (reference: string, options: {
      yes?: boolean;
      profile?: string;
      project?: string;
    }) => {
      // The guard fires before any resolution or traffic: without --yes
      // nothing is read, nothing is sent, with or without a terminal.
      if (options.yes !== true) {
        throw new OpCliError(
          "USAGE_ERROR",
          `time delete refuses to remove time entry ${reference} without confirmation.`,
          "repeat the command with --yes to confirm the deletion.",
        );
      }
      requireId(reference, "time entry");
      const profile = await runtime.resolve({
        profile: options.profile,
        project: parseOptionalId(options.project),
      });
      await deleteEntry(profile, reference);
      runtime.write(`Deleted time entry ${reference}.\n`);
    });

  time.command("report")
    .description("Sum logged hours over the same filters as time list")
    .option("--wp <id>", "work package id; repeat or comma-separate to OR values", collectValue, [])
    .option("--user <name>", "user name, id, or me; repeat to OR values", collectValue, [])
    .option("--from <date>", "today, yesterday, days back such as 7d, or YYYY-MM-DD")
    .option("--json", "emit a flat JSON array of per-work-package groups")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <id>", "override the profile default project")
    .action(async (options: {
      wp?: Array<string>;
      user?: Array<string>;
      from?: string;
      json?: boolean;
      profile?: string;
      project?: string;
    }) => {
      runtime.setJsonMode(options.json === true);
      // Refuse impossible input before any traffic or resolution.
      const wps = splitList(options.wp ?? []);
      for (const wp of wps) {
        requireId(wp, "work package");
      }
      const profile = await runtime.resolve({
        profile: options.profile,
        project: parseOptionalId(options.project),
      });
      const users = await resolveUserValues(runtime.env, profile, splitList(options.user ?? []));
      const filters = buildTimeFilters(
        profile.project,
        wps,
        users,
        options.from,
        new Date(),
      );
      // A total is only honest over the whole filtered set, so report
      // always walks every page; there is no --limit to half-count by.
      const startPath = withPageSize(
        `/api/v3/time_entries?filters=${filtersQuery(filters)}`,
        parsePageSize(undefined),
      );
      const getPage = (path: string): Promise<unknown> =>
        apiGet(profile.instanceUrl, profile.apiKey, path);
      interface ReportGroup {
        wp: FlatLink | null;
        count: number;
        ms: number;
      }
      const groups = new Map<string, ReportGroup>();
      let totalMs = 0;
      let totalCount = 0;
      for await (const element of halElements<unknown>(getPage, startPath)) {
        const record = timeEntryRecord(element);
        const wp = isFlatLink(record.wp) ? record.wp : null;
        const key = wp === null ? "none" : String(wp.id);
        const group = groups.get(key) ?? { wp, count: 0, ms: 0 };
        group.count += 1;
        // Millisecond integers keep every partial sum exact; only the
        // final render divides into decimal hours.
        const ms = typeof record.hours === "number"
          ? Math.round(record.hours * 3600000)
          : 0;
        group.ms += ms;
        totalMs += ms;
        totalCount += 1;
        groups.set(key, group);
      }
      if (options.json === true) {
        runtime.write(`${JSON.stringify([...groups.values()].map((group) => ({
          wp: group.wp,
          entries: group.count,
          hours: group.ms / 3600000,
        })))}\n`);
        return;
      }
      runtime.write(renderTable(
        ["WORK PACKAGE", "ENTRIES", "HOURS"],
        [
          ...[...groups.values()].map((group) => [
            group.wp === null || group.wp.name === null ? "-" : group.wp.name,
            String(group.count),
            String(group.ms / 3600000),
          ]),
          ["TOTAL", String(totalCount), String(totalMs / 3600000)],
        ],
      ));
    });
}
