import type { Command } from "commander";

import { OpCliError } from "../core/errors.js";
import {
  buildWpFilters,
  filtersQuery,
  type WpFilter,
  type WpListFlags,
} from "../core/filters.js";
import { flattenHalRecord, isFlatLink } from "../core/hal.js";
import { apiGet, authenticate } from "../core/http.js";
import { halElements } from "../core/paginate.js";
import {
  isIdForm,
  rankByCloseness,
  resolveName,
  type LookupSource,
  type NamedEntry,
} from "../context/resolve.js";
import {
  parseOptionalId,
  type ActiveProfile,
  type ContextOverrides,
} from "../context/profile.js";
import {
  loadProjectVocabulary,
  loadStoredMetadata,
  refreshStoredMetadata,
  type ProjectVocabulary,
  type StoredMetadata,
} from "../context/metadata.js";
import type { RunEnvironment } from "../run.js";
import { renderTable } from "../output/table.js";

export interface WpRuntime {
  readonly env: RunEnvironment;
  readonly resolve: (overrides?: ContextOverrides) => Promise<ActiveProfile>;
  readonly write: (text: string) => void;
  readonly writeErr: (text: string) => void;
  readonly setJsonMode: (on: boolean) => void;
}

// Canonical row order for a single-record table; every other key of the
// flattened record follows in server order.
const PREFERRED_FIELDS = [
  "id",
  "subject",
  "type",
  "status",
  "priority",
  "assignee",
  "author",
  "project",
  "version",
  "category",
  "startDate",
  "dueDate",
  "createdAt",
  "updatedAt",
  "lockVersion",
] as const;

// The list table is fixed: these are the columns an agent scans first.
const LIST_COLUMNS: ReadonlyArray<{ readonly title: string; readonly field: string }> = [
  { title: "ID", field: "id" },
  { title: "SUBJECT", field: "subject" },
  { title: "TYPE", field: "type" },
  { title: "STATUS", field: "status" },
  { title: "PRIORITY", field: "priority" },
  { title: "ASSIGNEE", field: "assignee" },
  { title: "UPDATED", field: "updatedAt" },
];

interface WorkPackagePage {
  readonly total?: unknown;
  readonly _embedded?: { readonly elements?: readonly unknown[] };
}

function defaultFields(record: Record<string, unknown>): Array<string> {
  const preferred = PREFERRED_FIELDS.filter((field) => field in record);
  const rest = Object.keys(record).filter(
    (key) => !(preferred as ReadonlyArray<string>).includes(key),
  );
  return [...preferred, ...rest];
}

function selectedFields(
  raw: string | undefined,
  record: Record<string, unknown>,
): Array<string> {
  if (raw === undefined) {
    return defaultFields(record);
  }
  const requested = [
    ...new Set(
      raw.split(",").map((name) => name.trim()).filter((name) => name !== ""),
    ),
  ];
  const first = requested.find((name) => !(name in record));
  if (first !== undefined) {
    throw new OpCliError(
      "USAGE_ERROR",
      `field "${first}" is not a column. Valid fields, closest first: `
        + `${rankByCloseness(first, Object.keys(record)).join(", ")}.`,
      "run the command without --fields to list every available column.",
    );
  }
  return requested;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (isFlatLink(value)) {
    return value.name ?? (value.id === null ? "" : String(value.id));
  }
  return JSON.stringify(value);
}

function collectValue(value: string, previous: Array<string>): Array<string> {
  return [...previous, value];
}

interface FilterFlagOptions {
  readonly status?: Array<string>;
  readonly type?: Array<string>;
  readonly assignee?: Array<string>;
  readonly author?: Array<string>;
  readonly version?: Array<string>;
  readonly category?: Array<string>;
  readonly priority?: Array<string>;
  readonly parent?: Array<string>;
  readonly updatedAfter?: string;
  readonly open?: boolean;
  readonly closed?: boolean;
  readonly profile?: string;
  readonly project?: string;
}

/**
 * Attach the shared filter surface of `wp list` and `wp count`. Both
 * commands accept exactly the same flags; repeating a value flag ORs.
 */
function addFilterFlags(command: Command): Command {
  return command
    .option("--status <name>", "status name or id; repeat to OR values", collectValue, [])
    .option("--type <name>", "type name or id; repeat to OR values", collectValue, [])
    .option("--assignee <name>", "user name, id, or me; repeat to OR values", collectValue, [])
    .option("--author <name>", "user name, id, or me; repeat to OR values", collectValue, [])
    .option("--version <name>", "version name or id; repeat to OR values", collectValue, [])
    .option("--category <name>", "category name or id; repeat to OR values", collectValue, [])
    .option("--priority <name>", "priority name or id; repeat to OR values", collectValue, [])
    .option("--parent <reference>", "parent work package id or exact subject", collectValue, [])
    .option(
      "--updated-after <value>",
      "today, yesterday, days back such as 7d, or YYYY-MM-DD",
    )
    .option("--open", "shorthand for every open status")
    .option("--closed", "shorthand for every closed status")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <id>", "override the profile default project");
}

function rawListFlags(options: FilterFlagOptions): WpListFlags {
  return {
    statuses: options.status,
    types: options.type,
    assignees: options.assignee,
    authors: options.author,
    versions: options.version,
    categories: options.category,
    priorities: options.priority,
    parents: options.parent,
    updatedAfter: options.updatedAfter,
    open: options.open,
    closed: options.closed,
  };
}

/** Metadata that lives instance-wide: statuses, types, priorities. */
function instanceSource<V>(
  runtime: WpRuntime,
  profile: ActiveProfile,
  label: string,
  select: (metadata: StoredMetadata) => ReadonlyArray<NamedEntry<V>>,
): LookupSource<V> {
  return {
    label,
    load: async () => select(await loadStoredMetadata(runtime.env, profile)),
    refresh: async () => {
      await refreshStoredMetadata(runtime.env, profile);
    },
  };
}

/** Metadata scoped to the profile's project: members, versions, categories. */
function projectSource<V>(
  runtime: WpRuntime,
  profile: ActiveProfile,
  flag: string,
  label: string,
  select: (vocabulary: ProjectVocabulary) => ReadonlyArray<NamedEntry<V>>,
): LookupSource<V> {
  return {
    label,
    load: async () => {
      if (profile.project === undefined) {
        throw new OpCliError(
          "USAGE_ERROR",
          `--${flag} needs a project to look names up in.`,
          "pass --project <id> or set a default project on the profile.",
        );
      }
      return select(await loadProjectVocabulary(runtime.env, profile));
    },
    refresh: async () => {
      await refreshStoredMetadata(runtime.env, profile);
    },
  };
}

async function resolveValues<V>(
  raws: ReadonlyArray<string>,
  source: LookupSource<V>,
): Promise<Array<string>> {
  const ids: Array<string> = [];
  for (const raw of raws) {
    const value = isIdForm(raw) ? Number(raw) : await resolveName(raw, source);
    const key = String(value);
    if (!ids.includes(key)) {
      ids.push(key);
    }
  }
  return ids;
}

async function resolveUserValues(
  runtime: WpRuntime,
  profile: ActiveProfile,
  flag: string,
  raws: ReadonlyArray<string>,
): Promise<Array<string>> {
  const source = projectSource<number>(runtime, profile, flag, flag, (vocabulary) =>
    vocabulary.members.map((member) => ({
      name: member.name,
      owner: member.type,
      value: member.user_id,
    })),
  );
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
      push(await resolveName(raw, source));
    }
  }
  return ids;
}

async function searchParentByName(
  profile: ActiveProfile,
  raw: string,
): Promise<number> {
  const query = encodeURIComponent(
    JSON.stringify([{ subject: { operator: "=", values: [raw] } }]),
  );
  const collection = (await apiGet(
    profile.instanceUrl,
    profile.apiKey,
    `/api/v3/work_packages?filters=${query}&pageSize=100`,
  )) as WorkPackagePage;
  const hits: Array<{ readonly id: number; readonly subject: string }> = [];
  for (const element of collection._embedded?.elements ?? []) {
    const record = element as { readonly id?: unknown; readonly subject?: unknown };
    if (typeof record.id === "number" && typeof record.subject === "string") {
      hits.push({ id: record.id, subject: record.subject });
    }
  }
  if (hits.length === 0) {
    throw new OpCliError(
      "USAGE_ERROR",
      `no work package has the subject "${raw}".`,
      "--parent accepts a work package id or an exact subject.",
    );
  }
  const distinct = [...new Map(hits.map((hit) => [hit.id, hit])).values()];
  if (distinct.length > 1) {
    const listed = distinct.map((hit) => `${hit.id} (${hit.subject})`).join(", ");
    throw new OpCliError(
      "USAGE_ERROR",
      `parent "${raw}" is ambiguous. Candidates: ${listed}.`,
      "repeat the value as the explicit id of one candidate.",
    );
  }
  const only = distinct[0];
  if (only === undefined) {
    throw new OpCliError("INTERNAL_ERROR");
  }
  return only.id;
}

async function resolveParents(
  profile: ActiveProfile,
  raws: ReadonlyArray<string>,
): Promise<Array<string>> {
  const ids: Array<string> = [];
  for (const raw of raws) {
    if (ids.includes(raw)) {
      continue;
    }
    ids.push(isIdForm(raw) ? raw : String(await searchParentByName(profile, raw)));
  }
  return ids;
}

async function resolveListFlags(
  runtime: WpRuntime,
  profile: ActiveProfile,
  options: FilterFlagOptions,
): Promise<WpListFlags> {
  const flags: {
    statuses?: Array<string>;
    types?: Array<string>;
    assignees?: Array<string>;
    authors?: Array<string>;
    versions?: Array<string>;
    categories?: Array<string>;
    priorities?: Array<string>;
    parents?: Array<string>;
    updatedAfter?: string;
  } = {};
  const status = options.status ?? [];
  if (status.length > 0) {
    flags.statuses = await resolveValues(
      status,
      instanceSource(runtime, profile, "status", (metadata) =>
        metadata.statuses.map((entry) => ({
          name: entry.name,
          owner: "Status",
          value: entry.id,
        })),
      ),
    );
  }
  const type = options.type ?? [];
  if (type.length > 0) {
    flags.types = await resolveValues(
      type,
      instanceSource(runtime, profile, "type", (metadata) =>
        metadata.types.map((entry) => ({
          name: entry.name,
          owner: "Type",
          value: entry.id,
        })),
      ),
    );
  }
  const assignee = options.assignee ?? [];
  if (assignee.length > 0) {
    flags.assignees = await resolveUserValues(runtime, profile, "assignee", assignee);
  }
  const author = options.author ?? [];
  if (author.length > 0) {
    flags.authors = await resolveUserValues(runtime, profile, "author", author);
  }
  const version = options.version ?? [];
  if (version.length > 0) {
    flags.versions = await resolveValues(
      version,
      projectSource<number>(runtime, profile, "version", "version", (vocabulary) =>
        vocabulary.versions.map((entry) => ({
          name: entry.name,
          owner: "Version",
          value: entry.id,
        })),
      ),
    );
  }
  const category = options.category ?? [];
  if (category.length > 0) {
    flags.categories = await resolveValues(
      category,
      projectSource<number>(runtime, profile, "category", "category", (vocabulary) =>
        vocabulary.categories.map((entry) => ({
          name: entry.name,
          owner: "Category",
          value: entry.id,
        })),
      ),
    );
  }
  const priority = options.priority ?? [];
  if (priority.length > 0) {
    flags.priorities = await resolveValues(
      priority,
      instanceSource(runtime, profile, "priority", (metadata) =>
        metadata.priorities.map((entry) => ({
          name: entry.name,
          owner: "Priority",
          value: entry.id,
        })),
      ),
    );
  }
  const parent = options.parent ?? [];
  if (parent.length > 0) {
    flags.parents = await resolveParents(profile, parent);
  }
  if (options.updatedAfter !== undefined && options.updatedAfter !== "") {
    flags.updatedAfter = options.updatedAfter;
  }
  return { ...flags, open: options.open, closed: options.closed };
}

const DEFAULT_LIMIT = 100;

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_LIMIT;
  }
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new OpCliError(
      "USAGE_ERROR",
      `--limit "${raw}" is not a positive integer.`,
      "pass a whole number of 1 or more.",
    );
  }
  return Number(raw);
}

function workPackagesPath(filters: ReadonlyArray<WpFilter>): string {
  return `/api/v3/work_packages?filters=${filtersQuery(filters)}`;
}

function renderWorkPackages(records: ReadonlyArray<Record<string, unknown>>): string {
  return renderTable(
    LIST_COLUMNS.map((column) => column.title),
    records.map((record) =>
      LIST_COLUMNS.map((column) => formatCell(record[column.field])),
    ),
  );
}

export function registerWpCommands(wp: Command, runtime: WpRuntime): void {
  wp.description("Inspect and manage work packages");
  addFilterFlags(
    wp.command("list")
      .description("List work packages by name-resolved filters")
      .option("--json", "emit a flat JSON array")
      .option("--limit <n>", "maximum number of results to show")
      .option("--all", "fetch every page instead of one limited page"),
  ).action(async (options: FilterFlagOptions & { json?: boolean; limit?: string; all?: boolean }) => {
    runtime.setJsonMode(options.json === true);
    // Refuse impossible flag combinations before any traffic or resolution.
    buildWpFilters(rawListFlags(options), new Date());
    const profile = await runtime.resolve({
      profile: options.profile,
      project: parseOptionalId(options.project),
    });
    const now = new Date();
    const limit = parseLimit(options.limit);
    const filters = buildWpFilters(await resolveListFlags(runtime, profile, options), now);
    const startPath = `${workPackagesPath(filters)}&pageSize=${String(limit)}`;
    const getPage = (path: string): Promise<unknown> =>
      apiGet(profile.instanceUrl, profile.apiKey, path);

    if (options.all === true) {
      const rows: Array<Record<string, unknown>> = [];
      for await (const element of halElements<unknown>(getPage, startPath)) {
        const record = flattenHalRecord(element);
        if (options.json === true) {
          runtime.write(`${JSON.stringify(record)}\n`);
        } else {
          rows.push(record);
        }
      }
      if (options.json !== true) {
        runtime.write(renderWorkPackages(rows));
      }
      return;
    }

    const page = (await getPage(startPath)) as WorkPackagePage;
    const records = (page._embedded?.elements ?? []).map((element) =>
      flattenHalRecord(element),
    );
    if (options.json === true) {
      runtime.write(`${JSON.stringify(records)}\n`);
    } else {
      runtime.write(renderWorkPackages(records));
    }
    const total = typeof page.total === "number" ? page.total : records.length;
    if (total > records.length) {
      runtime.writeErr(
        `Showing ${records.length} of ${total} work packages. `
          + "Pass --all to fetch every result.\n",
      );
    }
  });

  addFilterFlags(wp.command("count").description("Count work packages matching the filters")).action(
    async (options: FilterFlagOptions) => {
      buildWpFilters(rawListFlags(options), new Date());
      const profile = await runtime.resolve({
        profile: options.profile,
        project: parseOptionalId(options.project),
      });
      const filters = buildWpFilters(
        await resolveListFlags(runtime, profile, options),
        new Date(),
      );
      const body = (await apiGet(
        profile.instanceUrl,
        profile.apiKey,
        `${workPackagesPath(filters)}&pageSize=1`,
      )) as WorkPackagePage;
      if (typeof body.total !== "number") {
        throw new OpCliError(
          "API_ERROR",
          "the response carried no total.",
          "check the instance version with op-cli doctor.",
        );
      }
      runtime.write(`${String(body.total)}\n`);
    },
  );

  wp.command("get")
    .description("Show one work package")
    .argument("<id>")
    .option("--json", "emit a flat JSON record")
    .option("--fields <list>", "comma-separated columns to show")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <id>", "override the profile default project")
    .action(
      async (
        reference: string,
        options: {
          json?: boolean;
          fields?: string;
          profile?: string;
          project?: string;
        },
      ) => {
        runtime.setJsonMode(options.json === true);
        if (!isIdForm(reference)) {
          throw new OpCliError(
            "USAGE_ERROR",
            `work package "${reference}" is not an id.`,
            "work packages are addressed by their numeric id.",
          );
        }
        const profile = await runtime.resolve({
          profile: options.profile,
          project: parseOptionalId(options.project),
        });
        const record = flattenHalRecord(
          await apiGet(
            profile.instanceUrl,
            profile.apiKey,
            `/api/v3/work_packages/${reference}`,
          ),
        );
        const fields = selectedFields(options.fields, record);
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
      },
    );
}
