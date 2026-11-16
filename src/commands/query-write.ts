import type { Command } from "commander";

import { OpCliError, refuseCombined, unknownIfUnfinished, writeFailure } from "../core/errors.js";
import { buildWpFilters, parseSort, type WpFilter } from "../core/filters.js";
import { apiPatchRaw, apiPostRaw } from "../core/http.js";
import { parseProjectOverride, type ActiveProfile } from "../context/profile.js";
import {
  addFilterFlags,
  collectOptional,
  rawListFlags,
  resolveListFlags,
  type FilterFlagOptions,
} from "./wp.js";
import {
  addQueryScopeOptions,
  connectQuery,
  flattenQueryRecord,
  QUERIES_COLLECTION,
  renderQueryRecord,
  resolveQueryRef,
  type QueryRuntime,
  type QueryScopeOptions,
} from "./query.js";

/** The flags that shape how a query shows its results, shared by both writes. */
type ViewOptions = {
  readonly public?: string | boolean;
  readonly starred?: string | boolean;
  readonly sums?: string | boolean;
  readonly hierarchies?: string | boolean;
  readonly sort?: Array<string>;
  readonly columns?: string;
  readonly groupBy?: string;
  readonly fields?: string;
  readonly json?: boolean;
};

const QUERY_FIELDS: ReadonlyArray<string> = Object.keys(flattenQueryRecord({}));

const CREATE_WORDING = {
  action: "create",
  unknown: "whether the query was created is unknown",
  check: "run op-cli query list to see whether the query exists before repeating the command.",
};

const UPDATE_WORDING = {
  action: "update",
  unknown: "whether the query was changed is unknown",
  check: "run op-cli query get to see the stored values before repeating the command.",
};

/** The view flags every write accepts; one spelling for both commands. */
function addViewOptions(command: Command): Command {
  return command
    .option("--public [bool]", "visible to everybody: true or false (bare means true)")
    .option("--starred [bool]", "starred for you: true or false (bare means true)")
    .option("--sums [bool]", "show sums: true or false (bare means true)")
    .option("--hierarchies [bool]", "show the work package hierarchy: true or false (bare means true)")
    .option(
      "--sort <field[:asc|desc]>",
      "sort order; repeat for more fields",
      collectOptional,
    )
    .option("--columns <list>", "comma-separated column names, in order")
    .option("--group-by <field>", "group results by this field")
    .option("--json", "emit a flat JSON record")
    .option("--fields <list>", "comma-separated fields to show");
}

function booleanFlag(raw: string | boolean | undefined, flag: string): boolean | undefined {
  if (raw === undefined || raw === true) {
    return raw;
  }
  const lowered = String(raw).trim().toLowerCase();
  if (lowered !== "true" && lowered !== "false") {
    throw new OpCliError(
      "USAGE_ERROR",
      `--${flag} accepts true or false, not "${String(raw)}".`,
      `pass --${flag}, --${flag} true, or --${flag} false.`,
    );
  }
  return lowered === "true";
}

/** What the view flags say, already checked; undefined means "not given". */
interface View {
  readonly attributes: Record<string, unknown>;
  readonly links: Record<string, unknown>;
}

function viewOf(options: ViewOptions, mode: "create" | "update"): View {
  const attributes: Record<string, unknown> = {};
  const links: Record<string, unknown> = {};
  const flags: ReadonlyArray<readonly [string, string, string | boolean | undefined]> = [
    ["public", "public", options.public],
    ["starred", "starred", options.starred],
    ["sums", "sums", options.sums],
    ["hierarchies", "showHierarchies", options.hierarchies],
  ];
  for (const [flag, attribute, raw] of flags) {
    const value = booleanFlag(raw, flag);
    if (value !== undefined) {
      attributes[attribute] = value;
    }
  }

  const sort = options.sort;
  if (sort !== undefined) {
    const clears = mode === "update" && sort.length === 1 && sort[0]?.trim() === "";
    links.sortBy = clears
      ? []
      : parseSort(sort).map(([field, direction]) => ({
        href: `${QUERIES_COLLECTION}/sort_bys/${field}-${direction}`,
      }));
  }

  if (options.columns !== undefined) {
    if (options.columns.trim() === "" && mode === "update") {
      links.columns = [];
    } else {
      const names = options.columns.split(",").map((name) => name.trim());
      if (names.some((name) => name === "")) {
        throw new OpCliError(
          "USAGE_ERROR",
          "--columns needs a comma-separated list of column names, none empty.",
          "pass e.g. --columns id,subject,status.",
        );
      }
      links.columns = names.map((name) => ({
        href: `${QUERIES_COLLECTION}/columns/${name}`,
      }));
    }
  }

  if (options.groupBy !== undefined) {
    const field = options.groupBy.trim();
    if (field === "") {
      if (mode === "create") {
        throw new OpCliError(
          "USAGE_ERROR",
          "--group-by needs a field name.",
          "pass e.g. --group-by status; leave the flag out for no grouping.",
        );
      }
      links.groupBy = { href: null };
    } else {
      links.groupBy = { href: `${QUERIES_COLLECTION}/group_bys/${field}` };
    }
  }
  return { attributes, links };
}

/** The Query filter id a work package filter name goes by. */
function queryFilterId(name: string): string {
  switch (name) {
    case "assigned_to":
      return "assignee";
    case "created_at":
      return "createdAt";
    case "updated_at":
      return "updatedAt";
    default:
      return name;
  }
}

/** Filters whose values are linked resources, by the collection they live in. */
const LINKED_VALUES: Readonly<Record<string, string>> = {
  status: "statuses",
  type: "types",
  assignee: "users",
  responsible: "users",
  author: "users",
  watcher: "users",
  version: "versions",
  observedInVersion: "versions",
  category: "categories",
  sprint: "sprints",
  backlogBucket: "backlog_buckets",
  priority: "priorities",
  parent: "work_packages",
};

/** One filter clause as a Query filter instance in HAL form. */
export function queryFilterInstance(clause: WpFilter): Record<string, unknown> {
  const id = queryFilterId(clause.name);
  const links: Record<string, unknown> = {
    filter: { href: `${QUERIES_COLLECTION}/filters/${id}` },
    operator: {
      href: `${QUERIES_COLLECTION}/operators/${encodeURIComponent(clause.operator)}`,
    },
  };
  const collection = LINKED_VALUES[id];
  if (collection !== undefined) {
    links.values = clause.values.map((value) => ({ href: `/api/v3/${collection}/${value}` }));
    return { _links: links };
  }
  return {
    values: id === "backlogInbox" ? [true] : [...clause.values],
    _links: links,
  };
}

/** The filters the flags name, without the project scope a query keeps elsewhere. */
function queryFilters(
  flags: Parameters<typeof buildWpFilters>[0],
): ReadonlyArray<Record<string, unknown>> {
  return buildWpFilters({ ...flags, project: undefined, includeSubprojects: undefined }, new Date())
    .filter((clause) => clause.name !== "project" && clause.name !== "subprojectId")
    .map(queryFilterInstance);
}

const PROJECT_ONLY_FLAGS: ReadonlyArray<readonly [keyof FilterFlagOptions, string]> = [
  ["version", "--version"],
  ["observedIn", "--observed-in"],
  ["category", "--category"],
  ["sprint", "--sprint"],
  ["bucket", "--bucket"],
];

function requireProjectForNames(options: FilterFlagOptions, projectId: number | undefined): void {
  if (projectId !== undefined) {
    return;
  }
  for (const [key, flag] of PROJECT_ONLY_FLAGS) {
    const value = options[key];
    if (Array.isArray(value) && value.length > 0) {
      throw new OpCliError(
        "USAGE_ERROR",
        `${flag} needs a project in context to resolve names.`,
        "pass --project <name-or-id> or set a default project on the profile.",
      );
    }
  }
}

async function resolvedFilters(
  runtime: QueryRuntime,
  profile: ActiveProfile,
  options: FilterFlagOptions,
  projectId: number | undefined,
): Promise<ReadonlyArray<Record<string, unknown>>> {
  requireProjectForNames(options, projectId);
  const resolved = await resolveListFlags(
    { ...runtime, writeBytes: () => undefined },
    projectId === undefined ? { ...profile, project: undefined } : profile,
    options,
  );
  return queryFilters(resolved);
}

function checkFields(fields: string | undefined): void {
  if (fields === undefined) {
    return;
  }
  const unknown = fields.split(",").map((name) => name.trim()).find(
    (name) => name !== "" && !QUERY_FIELDS.includes(name),
  );
  if (unknown !== undefined) {
    throw new OpCliError(
      "USAGE_ERROR",
      `field "${unknown}" is not a column. Valid fields: ${QUERY_FIELDS.join(", ")}.`,
      "run op-cli query get to list every available field.",
    );
  }
}

function checkName(raw: string, flag: string): string {
  const name = raw.trim();
  if (name === "") {
    throw new OpCliError(
      "USAGE_ERROR",
      `${flag === "name" ? "the query name" : "--name"} cannot be blank.`,
      "give the query a name.",
    );
  }
  return name;
}

type CreateOptions = FilterFlagOptions & ViewOptions & { readonly global?: boolean };

function registerCreate(query: Command, runtime: QueryRuntime): void {
  addViewOptions(
    addFilterFlags(
      query
        .command("create")
        .description("Create a saved query (work package view)")
        .argument("<name>", "name of the new query")
        .option("--global", "make a query that belongs to no project"),
    ),
  ).action(async (rawName: string, options: CreateOptions) => {
    runtime.setJsonMode(options.json === true);
    const name = checkName(rawName, "name");
    refuseCombined(
      [options.global === true ? "--global" : undefined, options.project === undefined ? undefined : "--project"],
      "pass only one of --project or --global.",
    );
    checkFields(options.fields);
    const view = viewOf(options, "create");
    // Flag conflicts among the filters are refused here, before any traffic.
    queryFilters(rawListFlags(options));
    const profile = await runtime.resolve({
      profile: options.profile,
      project: parseProjectOverride(options.project),
    });
    const projectId = options.global === true ? undefined : profile.project;
    const filters = await resolvedFilters(runtime, profile, options, projectId);

    const payload: Record<string, unknown> = {
      name,
      ...view.attributes,
      ...(options.includeSubprojects === undefined
        ? {}
        : { includeSubprojects: options.includeSubprojects }),
      ...(filters.length > 0 ? { filters } : {}),
      _links: {
        project: projectId === undefined
          ? { href: null }
          : { href: `/api/v3/projects/${String(projectId)}` },
        ...view.links,
      },
    };
    const response = await unknownIfUnfinished(
      () => apiPostRaw(profile.instanceUrl, profile.apiKey, QUERIES_COLLECTION, payload),
      CREATE_WORDING,
    );
    if (response.status >= 400) {
      throw writeFailure(response.status, response.body, CREATE_WORDING);
    }
    const record = flattenQueryRecord(response.body);
    renderQueryRecord(
      runtime,
      { ...options, done: `query ${String(record.id)} was created` },
      record,
    );
  });
}

type UpdateOptions = FilterFlagOptions & ViewOptions & QueryScopeOptions & {
  readonly name?: string;
  readonly clearFilters?: boolean;
};

function registerUpdate(query: Command, runtime: QueryRuntime): void {
  addQueryScopeOptions(
    addViewOptions(
      addFilterFlags(
        query
          .command("update")
          .description("Change a saved query by id or name; only the flags you pass change")
          .argument("<id-or-name>", "query id or exact name")
          .option("--name <text>", "new name")
          .option("--clear-filters", "remove every filter"),
        false,
      ),
    ),
  ).action(async (reference: string, options: UpdateOptions) => {
    runtime.setJsonMode(options.json === true);
    if (reference.trim() === "default") {
      throw new OpCliError(
        "USAGE_ERROR",
        'the "default" query is not stored and cannot be updated.',
        "create a query with op-cli query create instead.",
      );
    }
    const name = options.name === undefined ? undefined : checkName(options.name, "--name");
    checkFields(options.fields);
    const view = viewOf(options, "update");
    const named = queryFilters(rawListFlags(options));
    refuseCombined(
      [options.clearFilters === true ? "--clear-filters" : undefined, named.length > 0 ? "a filter flag" : undefined],
      "--clear-filters removes every filter; it cannot be combined with filter flags.",
    );
    const touches = name !== undefined
      || options.clearFilters === true
      || named.length > 0
      || options.includeSubprojects !== undefined
      || Object.keys(view.attributes).length > 0
      || Object.keys(view.links).length > 0;
    if (!touches) {
      throw new OpCliError(
        "USAGE_ERROR",
        "query update needs at least one thing to change.",
        "pass --name, --clear-filters, a filter flag, or a view flag such as --sort or --public.",
      );
    }

    const connection = await connectQuery(runtime, options);
    const ref = await resolveQueryRef(connection, reference);
    if (ref.kind !== "id") {
      throw new OpCliError("USAGE_ERROR", "the default query cannot be updated.", "pass an id or a name.");
    }
    const { profile } = connection;
    const filters = named.length > 0
      ? await resolvedFilters(runtime, profile, options, profile.project)
      : [];

    const links = view.links;
    const payload: Record<string, unknown> = {
      ...(name === undefined ? {} : { name }),
      ...view.attributes,
      ...(options.includeSubprojects === undefined
        ? {}
        : { includeSubprojects: options.includeSubprojects }),
      ...(options.clearFilters === true ? { filters: [] } : {}),
      ...(named.length > 0 ? { filters } : {}),
      ...(Object.keys(links).length > 0 ? { _links: links } : {}),
    };
    const response = await unknownIfUnfinished(
      () =>
        apiPatchRaw(
          profile.instanceUrl,
          profile.apiKey,
          `${QUERIES_COLLECTION}/${String(ref.id)}`,
          payload,
        ),
      UPDATE_WORDING,
    );
    if (response.status >= 400) {
      throw writeFailure(response.status, response.body, UPDATE_WORDING);
    }
    const record = flattenQueryRecord(response.body);
    renderQueryRecord(
      runtime,
      { ...options, done: `query ${String(record.id ?? ref.id)} was updated` },
      record,
    );
  });
}

export function registerQueryWrite(query: Command, runtime: QueryRuntime): void {
  registerCreate(query, runtime);
  registerUpdate(query, runtime);
}
