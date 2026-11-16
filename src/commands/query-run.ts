import type { Command } from "commander";

import { OpCliError } from "../core/errors.js";
import { PAGED_JSON_HELP, type CollectionColumn } from "../core/define.js";
import { flattenHalRecord } from "../core/hal.js";
import { allPageSize, halElements, parsePageSize, withPageSize } from "../core/paginate.js";
import { rankByCloseness } from "../context/resolve.js";
import { instancePathOf } from "../context/projectref.js";
import { formatCell, renderTable } from "../output/table.js";
import {
  addQueryScopeOptions,
  connectQuery,
  fetchQuery,
  lastSegment,
  resolveQueryRef,
  type QueryRuntime,
  type QueryScopeOptions,
} from "./query.js";
import { LIST_COLUMNS } from "./wp.js";

type RunOptions = QueryScopeOptions & {
  readonly fields?: string;
  readonly limit?: string;
  readonly all?: boolean;
};

interface ResultsPage {
  readonly total?: unknown;
  readonly _embedded?: { readonly elements?: readonly unknown[] };
}

type LinkBody = { readonly href?: unknown; readonly title?: unknown };

/** The href without its pageSize, so the page size is set exactly once. */
function withoutPageSize(path: string): string {
  const [base = "", query] = path.split("?", 2);
  const kept = (query ?? "").split("&").filter((part) => part !== "" && !part.startsWith("pageSize="));
  return kept.length === 0 ? base : `${base}?${kept.join("&")}`;
}

/**
 * The results path of a Query resource: the link the server gave, cut to
 * start at /api/v3 so an instance subpath is not added twice. Without that
 * link the filters of the query would be lost, so it fails loudly.
 */
function resultsEndpointOf(query: unknown): string {
  const links = ((query as { readonly _links?: Record<string, unknown> })._links ?? {});
  const href = (links.results as LinkBody | null | undefined)?.href;
  const path = typeof href === "string" && href !== "" ? instancePathOf(href) : undefined;
  if (path === undefined) {
    throw new OpCliError(
      "API_ERROR",
      "the query response carried no results link.",
      "check the instance version with op-cli doctor.",
    );
  }
  return withoutPageSize(path);
}

/** The columns the query shows; the fixed work package columns when it defines none. */
function queryColumns(query: unknown): ReadonlyArray<CollectionColumn> {
  const links = ((query as { readonly _links?: Record<string, unknown> })._links ?? {});
  const defined = Array.isArray(links.columns) ? (links.columns as ReadonlyArray<LinkBody>) : [];
  const columns = defined.flatMap((link): Array<CollectionColumn> => {
    if (typeof link.href !== "string" || link.href === "") {
      return [];
    }
    const field = lastSegment(link.href);
    if (field === undefined) {
      return [];
    }
    const title = typeof link.title === "string" && link.title !== "" ? link.title : field;
    return [{ title: title.toUpperCase(), field }];
  });
  return columns.length === 0 ? LIST_COLUMNS : columns;
}

function fieldList(raw: string): Array<string> {
  return [...new Set(raw.split(",").map((name) => name.trim()).filter((name) => name !== ""))];
}

function requireFields(record: Record<string, unknown>, fields: ReadonlyArray<string>): void {
  const missing = fields.find((name) => !(name in record));
  if (missing !== undefined) {
    throw new OpCliError(
      "USAGE_ERROR",
      `field "${missing}" is not a column. Valid fields, closest first: `
        + `${rankByCloseness(missing, Object.keys(record)).join(", ")}.`,
      "run the command without --fields to list every available column.",
    );
  }
}

function pick(record: Record<string, unknown>, fields: ReadonlyArray<string>): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, record[field]]));
}

export function registerQueryRun(query: Command, runtime: QueryRuntime): void {
  addQueryScopeOptions(
    query
      .command("run")
      .description('Run a query and show its work packages, by id, name, or "default"')
      .argument("<id-or-name>", 'query id, exact name, or "default"')
      .option("--json", PAGED_JSON_HELP)
      .option("--fields <list>", "comma-separated columns to show")
      .option("--limit <n>", "maximum number of results to show")
      .option("--all", "fetch every page instead of one limited page"),
  ).action(async (reference: string, options: RunOptions) => {
    runtime.setJsonMode(options.json === true);
    // Flag misuse is refused before any traffic.
    const limit = parsePageSize(options.limit);
    const connection = await connectQuery(runtime, options);
    const resource = await fetchQuery(connection, await resolveQueryRef(connection, reference));
    const endpoint = resultsEndpointOf(resource);
    const { getPage: readPage } = connection;

    const size = options.all === true ? await allPageSize(readPage) : limit;
    const first = withPageSize(endpoint, size);

    const requested = options.fields === undefined ? undefined : fieldList(options.fields);
    const view = requested === undefined
      ? queryColumns(resource)
      : requested.map((field) => ({ title: field.toUpperCase(), field }));
    const flatten = (element: unknown): Record<string, unknown> => {
      const record = flattenHalRecord(element);
      if (requested !== undefined) {
        requireFields(record, requested);
      }
      return record;
    };
    const table = (records: ReadonlyArray<Record<string, unknown>>): string =>
      renderTable(
        view.map((column) => column.title),
        records.map((record) => view.map((column) => formatCell(record[column.field]))),
      );
    const shaped = (record: Record<string, unknown>): Record<string, unknown> =>
      requested === undefined ? record : pick(record, requested);

    if (options.all === true) {
      if (options.json === true) {
        for await (const element of halElements<unknown>(readPage, first)) {
          runtime.write(`${JSON.stringify(shaped(flatten(element)))}\n`);
        }
        return;
      }
      const records: Array<Record<string, unknown>> = [];
      for await (const element of halElements<unknown>(readPage, first)) {
        records.push(flatten(element));
      }
      runtime.write(table(records));
      return;
    }

    const page = (await readPage(first)) as ResultsPage;
    const records = (page._embedded?.elements ?? []).map(flatten);
    runtime.write(
      options.json === true ? `${JSON.stringify(records.map(shaped))}\n` : table(records),
    );
    const total = typeof page.total === "number" ? page.total : records.length;
    if (total > records.length) {
      runtime.writeErr(
        `Showing ${String(records.length)} of ${String(total)} work packages. `
          + "Pass --all to fetch every result.\n",
      );
    }
  });
}
