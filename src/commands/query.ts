import type { Command } from "commander";

import { formatCell, renderTable } from "../output/table.js";
import { registerQueryManage } from "./query-manage.js";

import { OpCliError, refuseCombined } from "../core/errors.js";
import { filtersQuery, type WpFilter } from "../core/filters.js";
import {
  emitRows,
  PAGED_JSON_HELP,
  rowViewOf,
  type CollectionColumn,
} from "../core/define.js";
import { flattenHalLink, halRefId } from "../core/hal.js";
import { apiGet } from "../core/http.js";
import {
  DEFAULT_PAGE_SIZE,
  allPageSize,
  halElements,
  parsePageSize,
  withPageSize,
} from "../core/paginate.js";
import { isIdForm, matchByName, rankByCloseness } from "../context/resolve.js";
import {
  parseProjectOverride,
  type ActiveProfile,
  type ContextOverrides,
} from "../context/profile.js";
import {
  PROJECTS_COLLECTION,
  withMovedRetry,
  WORKSPACES_COLLECTION,
} from "../context/projectref.js";

export interface QueryRuntime {
  readonly resolve: (overrides?: ContextOverrides) => Promise<ActiveProfile>;
  readonly write: (text: string) => void;
  readonly writeErr: (text: string) => void;
  readonly setJsonMode: (on: boolean) => void;
}

export const QUERIES_COLLECTION = "/api/v3/queries";

export const QUERY_COLUMNS: ReadonlyArray<CollectionColumn> = [
  { title: "ID", field: "id" },
  { title: "NAME", field: "name" },
  { title: "PROJECT", field: "project" },
  { title: "STARRED", field: "starred" },
  { title: "PUBLIC", field: "public" },
];

export type GetPage = (path: string) => Promise<unknown>;

/** The flags every query command shares to say which queries it means. */
export type QueryScopeOptions = {
  readonly json?: boolean;
  readonly profile?: string;
  readonly project?: string;
  readonly global?: boolean;
  readonly allProjects?: boolean;
};

/**
 * Which queries a command looks at: those of one project, only those
 * without a project, or every visible one.
 */
export type QueryScope =
  | { readonly kind: "project"; readonly id: number }
  | { readonly kind: "global" }
  | { readonly kind: "all" };

/** Declares the scope flags on one command; the single spelling of them. */
export function addQueryScopeOptions(command: Command): Command {
  return command
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <name-or-id>", "only queries of this project")
    .option("--global", "only queries that belong to no project")
    .option("--all-projects", "queries of every project, ignoring the default project");
}

/** Flag misuse is refused here, before any traffic. */
export function checkQueryScopeFlags(options: QueryScopeOptions): void {
  refuseCombined(
    [
      options.global === true ? "--global" : undefined,
      options.allProjects === true ? "--all-projects" : undefined,
      options.project === undefined ? undefined : "--project",
    ],
    "pass only one of --project, --global, or --all-projects.",
  );
}

/** The scope the flags and the profile's default project select. */
export function queryScopeOf(
  options: QueryScopeOptions,
  profile: Pick<ActiveProfile, "project">,
): QueryScope {
  if (options.global === true) {
    return { kind: "global" };
  }
  if (options.allProjects === true || profile.project === undefined) {
    return { kind: "all" };
  }
  return { kind: "project", id: profile.project };
}

export interface QueryConnection {
  readonly getPage: GetPage;
  readonly scope: QueryScope;
  readonly profile: ActiveProfile;
}

/** The shared opening: JSON mode, flag checks, the profile, the scope. */
export async function connectQuery(
  runtime: QueryRuntime,
  options: QueryScopeOptions,
): Promise<QueryConnection> {
  runtime.setJsonMode(options.json === true);
  checkQueryScopeFlags(options);
  const profile = await runtime.resolve({
    profile: options.profile,
    project: parseProjectOverride(options.project),
  });
  return {
    getPage: (path) => apiGet(profile.instanceUrl, profile.apiKey, path),
    scope: queryScopeOf(options, profile),
    profile,
  };
}

/** The collection path of the queries in scope, without pageSize. */
export function queriesPath(scope: QueryScope): string {
  const filters: Array<WpFilter> = [];
  if (scope.kind === "project") {
    filters.push({ name: "project", operator: "=", values: [String(scope.id)] });
  } else if (scope.kind === "global") {
    filters.push({ name: "project", operator: "!*", values: [] });
  }
  return filters.length === 0
    ? QUERIES_COLLECTION
    : `${QUERIES_COLLECTION}?filters=${filtersQuery(filters)}`;
}

/** Where the default query of the scope lives; undefined for the global one. */
export function defaultQueryPath(scope: QueryScope): string {
  return scope.kind === "project"
    ? `${WORKSPACES_COLLECTION}/${String(scope.id)}/queries/default`
    : `${QUERIES_COLLECTION}/default`;
}

function defaultQueryFallbackPath(scope: QueryScope): string | undefined {
  return scope.kind === "project"
    ? `${PROJECTS_COLLECTION}/${String(scope.id)}/queries/default`
    : undefined;
}

/** What a query reference names: the scope's default, or one stored query. */
export type QueryRef =
  | { readonly kind: "default" }
  | { readonly kind: "id"; readonly id: number };

function lastSegment(href: unknown): string | undefined {
  if (typeof href !== "string") {
    return undefined;
  }
  const tail = href.split("/").filter((part) => part !== "").pop();
  return tail === undefined ? undefined : decodeURIComponent(tail);
}

interface QueryCandidate {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
}

async function walkQueries(
  connection: QueryConnection,
): Promise<ReadonlyArray<QueryCandidate>> {
  const found: Array<QueryCandidate> = [];
  for await (
    const element of halElements<Record<string, unknown>>(
      connection.getPage,
      withPageSize(queriesPath(connection.scope), DEFAULT_PAGE_SIZE),
    )
  ) {
    if (typeof element.id !== "number" || typeof element.name !== "string") {
      continue;
    }
    const project = flattenHalLink(
      (element._links as Record<string, unknown> | undefined)?.project,
    );
    found.push({
      id: element.id,
      name: element.name,
      owner: project.id === null ? "global" : `project ${project.name ?? String(project.id)}`,
    });
  }
  return found;
}

/**
 * A query reference to what it names. A number is an id and a bare
 * "default" is the scope's default query; anything else is an exact name
 * matched live over the queries in scope, because queries are not part of
 * the stored metadata. Ambiguity and a miss fail loudly.
 */
export async function resolveQueryRef(
  connection: QueryConnection,
  raw: string,
): Promise<QueryRef> {
  if (isIdForm(raw)) {
    return { kind: "id", id: Number(raw) };
  }
  if (raw === "default") {
    return { kind: "default" };
  }
  const candidates = await walkQueries(connection);
  const match = matchByName(
    raw,
    candidates.map((candidate) => ({
      name: candidate.name,
      owner: candidate.owner,
      value: candidate.id,
    })),
  );
  if (match.kind === "unique") {
    return { kind: "id", id: match.entry.value };
  }
  if (match.kind === "ambiguous") {
    const listed = match.candidates
      .map((candidate) => `${String(candidate.value)} (${candidate.owner})`)
      .join(", ");
    throw new OpCliError(
      "USAGE_ERROR",
      `query "${raw}" is ambiguous. Candidates: ${listed}.`,
      "repeat the command with the numeric id of one candidate, or narrow with --project or --global.",
    );
  }
  throw new OpCliError(
    "USAGE_ERROR",
    candidates.length === 0
      ? `query "${raw}" not found; no query is visible in this scope.`
      : `query "${raw}" not found. Valid values, closest first: `
        + `${rankByCloseness(raw, candidates.map((candidate) => candidate.name)).join(", ")}.`,
    "run op-cli query list to see the queries you can address.",
  );
}

/** The raw Query resource a reference names. */
export async function fetchQuery(
  connection: QueryConnection,
  ref: QueryRef,
): Promise<unknown> {
  if (ref.kind === "id") {
    return connection.getPage(`${QUERIES_COLLECTION}/${String(ref.id)}`);
  }
  const fallback = defaultQueryFallbackPath(connection.scope);
  const first = defaultQueryPath(connection.scope);
  return fallback === undefined
    ? connection.getPage(first)
    : withMovedRetry(
      () => connection.getPage(first),
      () => connection.getPage(fallback),
    );
}

function filterSummary(filter: unknown): Record<string, unknown> {
  const body = filter as {
    readonly values?: unknown;
    readonly _links?: Record<string, unknown>;
  };
  const links = body._links ?? {};
  const linked = Array.isArray(links.values)
    ? links.values.map((value: unknown) => {
      const href = (value as { readonly href?: unknown }).href;
      return halRefId(typeof href === "string" ? href : null)?.toString() ?? lastSegment(href) ?? "";
    })
    : [];
  const plain = Array.isArray(body.values) ? body.values.map(String) : [];
  return {
    field: lastSegment((links.filter as { href?: unknown } | undefined)?.href) ?? null,
    operator: lastSegment((links.operator as { href?: unknown } | undefined)?.href) ?? null,
    values: [...plain, ...linked],
  };
}

function linkList(links: unknown): ReadonlyArray<{ readonly href?: unknown }> {
  return Array.isArray(links) ? (links as ReadonlyArray<{ href?: unknown }>) : [];
}

function sortSummary(href: unknown): string | undefined {
  const key = lastSegment(href);
  const split = key?.lastIndexOf("-") ?? -1;
  return key === undefined || split < 0
    ? key
    : `${key.slice(0, split)}:${key.slice(split + 1)}`;
}

/**
 * One Query resource as a flat record: the scalars, `{ id, name }` for
 * project, user, and group-by, the columns and sort order as plain strings,
 * and the filters as `{ field, operator, values }`. The embedded results
 * are dropped: running a query is its own command.
 */
export function flattenQueryRecord(element: unknown): Record<string, unknown> {
  const query = element as Record<string, unknown> & {
    readonly _links?: Record<string, unknown>;
  };
  const links = query._links ?? {};
  return {
    id: query.id ?? null,
    name: query.name ?? null,
    project: flattenHalLink(links.project),
    user: flattenHalLink(links.user),
    starred: query.starred ?? null,
    public: query.public ?? null,
    sums: query.sums ?? null,
    includeSubprojects: query.includeSubprojects ?? null,
    showHierarchies: query.showHierarchies ?? null,
    groupBy: flattenHalLink(links.groupBy),
    columns: linkList(links.columns)
      .map((link) => lastSegment(link.href))
      .filter((name): name is string => name !== undefined),
    sortBy: linkList(links.sortBy)
      .map((link) => sortSummary(link.href))
      .filter((sort): sort is string => sort !== undefined),
    filters: Array.isArray(query.filters) ? query.filters.map(filterSummary) : [],
    createdAt: query.createdAt ?? null,
    updatedAt: query.updatedAt ?? null,
  };
}

/** Renders one flat query record as a FIELD/VALUE table or picked JSON. */
export function renderQueryRecord(
  runtime: Pick<QueryRuntime, "write">,
  options: { readonly json?: boolean; readonly fields?: string },
  record: Record<string, unknown>,
  done?: string,
): void {
  const requested = typeof options.fields === "string"
    ? [
      ...new Set(
        options.fields.split(",").map((name) => name.trim()).filter((name) => name !== ""),
      ),
    ]
    : Object.keys(record);
  const unknown = requested.find((name) => !(name in record));
  if (unknown !== undefined) {
    throw new OpCliError(
      "USAGE_ERROR",
      `${done === undefined ? "" : `${done}; `}field "${unknown}" is not a column. Valid fields, closest first: `
        + `${rankByCloseness(unknown, Object.keys(record)).join(", ")}.`,
      "run the command without --fields to list every available field.",
    );
  }
  if (options.json === true) {
    runtime.write(
      `${JSON.stringify(Object.fromEntries(requested.map((field) => [field, record[field]])))}\n`,
    );
    return;
  }
  runtime.write(
    renderTable(
      ["FIELD", "VALUE"],
      requested.map((field) => [field, formatCell(record[field])]),
    ),
  );
}

type ListOptions = QueryScopeOptions & {
  readonly starred?: boolean;
  readonly fields?: string;
  readonly limit?: string;
  readonly all?: boolean;
};

function registerList(query: Command, runtime: QueryRuntime): void {
  addQueryScopeOptions(
    query
      .command("list")
      .description("List visible queries (saved work package views)")
      .option("--starred", "only queries you starred")
      .option("--json", PAGED_JSON_HELP)
      .option("--fields <list>", "comma-separated columns to show")
      .option("--limit <n>", "maximum number of results to show")
      .option("--all", "fetch every page instead of one limited page"),
  ).action(async (options: ListOptions) => {
    runtime.setJsonMode(options.json === true);
    // Flag misuse is refused before any traffic.
    const { pick } = rowViewOf(QUERY_COLUMNS, options);
    const limit = parsePageSize(options.limit);
    const { getPage, scope } = await connectQuery(runtime, options);
    const basePath = queriesPath(scope);
    const keep = (row: Record<string, unknown>): boolean =>
      options.starred !== true || row.starred === true;

    // The starred flag is applied here, not by the server: the filter set
    // of the collection is not documented for it. A client-side filter
    // needs every page, or a short first page could hide a starred query.
    const walkAll = options.all === true || options.starred === true;
    if (walkAll) {
      const startPath = withPageSize(basePath, await allPageSize(getPage));
      const rows: Array<Record<string, unknown>> = [];
      for await (const element of halElements<unknown>(getPage, startPath)) {
        const row = flattenQueryRecord(element);
        if (!keep(row)) {
          continue;
        }
        if (options.all === true && options.json === true) {
          runtime.write(`${JSON.stringify(pick(row))}\n`);
        } else {
          rows.push(row);
        }
      }
      if (options.all === true && options.json === true) {
        return;
      }
      const shown = options.all === true ? rows : rows.slice(0, limit);
      emitRows(runtime, QUERY_COLUMNS, shown, options);
      if (shown.length < rows.length) {
        runtime.writeErr(
          `Showing ${String(shown.length)} of ${String(rows.length)} queries. `
            + "Pass --all to fetch every result.\n",
        );
      }
      return;
    }

    const page = (await getPage(withPageSize(basePath, limit))) as {
      total?: unknown;
      _embedded?: { elements?: readonly unknown[] };
    };
    const elements = page._embedded?.elements ?? [];
    emitRows(runtime, QUERY_COLUMNS, elements.map(flattenQueryRecord), options);
    const total = typeof page.total === "number" ? page.total : elements.length;
    if (total > elements.length) {
      runtime.writeErr(
        `Showing ${String(elements.length)} of ${String(total)} queries. `
          + "Pass --all to fetch every result.\n",
      );
    }
  });
}

function registerGet(query: Command, runtime: QueryRuntime): void {
  addQueryScopeOptions(
    query
      .command("get")
      .description('Show one query by id, name, or "default"')
      .argument("<id-or-name>", 'query id, exact name, or "default"')
      .option("--json", "emit a flat JSON record")
      .option("--fields <list>", "comma-separated fields to show"),
  ).action(
    async (
      reference: string,
      options: QueryScopeOptions & { readonly fields?: string },
    ) => {
      const connection = await connectQuery(runtime, options);
      const ref = await resolveQueryRef(connection, reference);
      renderQueryRecord(
        runtime,
        options,
        flattenQueryRecord(await fetchQuery(connection, ref)),
      );
    },
  );
}

export function registerQueryCommands(query: Command, runtime: QueryRuntime): void {
  query.description("Inspect saved work package views (queries)");
  registerList(query, runtime);
  registerGet(query, runtime);
  registerQueryManage(query, runtime);
}
