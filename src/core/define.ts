import { Command } from "commander";

import { OpCliError } from "./errors.js";
import { formatCell, renderTable } from "../output/table.js";
import { halElements, parsePageSize, withPageSize } from "./paginate.js";
import { isIdForm, rankByCloseness } from "../context/resolve.js";

export interface LookupColumn<Row> {
  readonly title: string;
  readonly cell: (row: Row) => string;
}

export interface LookupFilter<Row> {
  readonly flag: string;
  readonly description: string;
  readonly keep: (row: Row) => boolean;
}

export interface LookupOption {
  readonly flag: string;
  readonly description: string;
}

/**
 * Declaration of one read-only lookup command. Adding a lookup to the CLI
 * means writing one of these (under 30 lines) and registering it; no
 * bespoke command code is ever written.
 */
export interface LookupSpec<Row, Data> {
  readonly name: string;
  readonly description: string;
  readonly select: (data: Data) => ReadonlyArray<Row>;
  readonly columns: ReadonlyArray<LookupColumn<Row>>;
  readonly filters?: ReadonlyArray<LookupFilter<Row>>;
  readonly options?: ReadonlyArray<LookupOption>;
}

export type ParsedOptions = Record<string, boolean | string | undefined>;

export interface LookupRuntime<Data> {
  readonly load: (options: ParsedOptions) => Promise<Data>;
  readonly write: (text: string) => void;
  readonly setJsonMode: (on: boolean) => void;
}

// Commander camel-cases option names ("--open-only" -> options.openOnly),
// so the declared flag must go through the same transformation before the
// parsed options object is consulted.
function optionKey(flag: string): string {
  return flag.replace(/^--/, "").replace(/-([a-z])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
}

export function defineLookupCommand<Row, Data>(
  spec: LookupSpec<Row, Data>,
  runtime: LookupRuntime<Data>,
): Command {
  const command = new Command(spec.name).description(spec.description);
  const filters = spec.filters ?? [];
  for (const filter of filters) {
    command.option(filter.flag, filter.description);
  }
  for (const option of spec.options ?? []) {
    command.option(option.flag, option.description);
  }
  command.option("--json", "emit a JSON array");
  command.action(async (options: ParsedOptions) => {
    runtime.setJsonMode(options.json === true);
    const active = filters.filter(
      (filter) => options[optionKey(filter.flag)] === true,
    );
    if (active.length > 1) {
      throw new OpCliError("USAGE_ERROR");
    }
    let rows = spec.select(await runtime.load(options));
    if (active.length === 1) {
      rows = rows.filter(active[0]?.keep ?? (() => true));
    }
    if (options.json === true) {
      runtime.write(`${JSON.stringify(rows)}\n`);
      return;
    }
    runtime.write(
      renderTable(
        spec.columns.map((column) => column.title),
        rows.map((row) => spec.columns.map((column) => column.cell(row))),
      ),
    );
  });
  return command;
}

export interface CollectionColumn {
  readonly title: string;
  readonly field: string;
}

export interface CollectionSpec {
  readonly name: string;
  readonly description: string;
  /** Endpoint of the collection for one work package id, without pageSize. */
  readonly path: (id: string) => string;
  /** One flat output row per element; returning undefined drops it. */
  readonly row: (element: unknown) => Record<string, unknown> | undefined;
  readonly columns: ReadonlyArray<CollectionColumn>;
  /**
   * Optional second pass over each row, for facts the collection only
   * links to. The factory runs once per invocation so the resolver can
   * memoise across rows; it is handed the same page getter the listing
   * uses, and returning the row untouched costs nothing.
   */
  readonly resolve?: (
    getPage: (path: string) => Promise<unknown>,
  ) => (row: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export interface CollectionRuntime {
  /** Resolve the profile behind the parsed flags and hand back the getter. */
  readonly connect: (options: ParsedOptions) => Promise<(path: string) => Promise<unknown>>;
  readonly write: (text: string) => void;
  readonly writeErr: (text: string) => void;
  readonly setJsonMode: (on: boolean) => void;
}

/**
 * The column view behind one invocation: --fields validated against the
 * declared columns (before any traffic) plus the row picker it implies.
 * Without --fields the table shows every declared column while JSON keeps
 * the whole flat record, matching `wp list`.
 */
export function rowViewOf(
  columns: ReadonlyArray<CollectionColumn>,
  options: ParsedOptions,
): {
  readonly view: ReadonlyArray<CollectionColumn>;
  readonly pick: (row: Record<string, unknown>) => Record<string, unknown>;
} {
  const fields = options.fields;
  if (typeof fields !== "string") {
    return { view: columns, pick: (row) => row };
  }
  const requested = [
    ...new Set(
      fields.split(",").map((name) => name.trim()).filter((name) => name !== ""),
    ),
  ];
  const declared = columns.map((column) => column.field);
  const missing = requested.find((name) => !declared.includes(name));
  if (missing !== undefined) {
    throw new OpCliError(
      "USAGE_ERROR",
      `field "${missing}" is not a column. Valid fields, closest first: `
        + `${rankByCloseness(missing, declared).join(", ")}.`,
      "run the command without --fields to list every available column.",
    );
  }
  const view = requested.map((name) => columns.find((column) => column.field === name)!);
  return {
    view,
    pick: (row) => Object.fromEntries(view.map((column) => [column.field, row[column.field]])),
  };
}

function renderRowsTable(
  view: ReadonlyArray<CollectionColumn>,
  rows: ReadonlyArray<Record<string, unknown>>,
): string {
  return renderTable(
    view.map((column) => column.title),
    rows.map((row) => view.map((column) => formatCell(row[column.field]))),
  );
}

/**
 * Render rows as a table or one flat JSON array. Shared by every
 * non-streaming listing so field selection exists exactly once.
 */
export function emitRows(
  io: Pick<CollectionRuntime, "write" | "writeErr">,
  columns: ReadonlyArray<CollectionColumn>,
  rows: ReadonlyArray<Record<string, unknown>>,
  options: ParsedOptions,
): void {
  const { view, pick } = rowViewOf(columns, options);
  if (options.json === true) {
    io.write(`${JSON.stringify(rows.map(pick))}\n`);
    return;
  }
  io.write(renderRowsTable(view, rows));
}

/**
 * Declaration of one paginated listing over a per-work-package HAL
 * collection: pagination, the truncation notice, both output shapes and
 * field selection all come from here; a declaration only names the
 * endpoint, its rows, and its columns.
 */
export function defineCollectionCommand(
  spec: CollectionSpec,
  runtime: CollectionRuntime,
): Command {
  const command = new Command(spec.name)
    .description(spec.description)
    .argument("<id>", "work package id")
    .option("--json", "emit a flat JSON array")
    .option("--fields <list>", "comma-separated columns to show")
    .option("--limit <n>", "maximum number of results to show")
    .option("--all", "fetch every page instead of one limited page")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <id>", "override the profile default project");
  command.action(async (reference: string, options: ParsedOptions) => {
    runtime.setJsonMode(options.json === true);
    // Flag misuse is refused before any traffic.
    const { view, pick } = rowViewOf(spec.columns, options);
    if (!isIdForm(reference)) {
      throw new OpCliError(
        "USAGE_ERROR",
        `work package "${reference}" is not an id.`,
        "work packages are addressed by their numeric id.",
      );
    }
    const getPage = await runtime.connect(options);
    const resolve = spec.resolve?.(getPage) ?? ((row) => Promise.resolve(row));
    const limit = parsePageSize(typeof options.limit === "string" ? options.limit : undefined);
    const startPath = withPageSize(spec.path(reference), limit);
    if (options.all === true) {
      if (options.json === true) {
        for await (const element of halElements<unknown>(getPage, startPath)) {
          const row = spec.row(element);
          if (row !== undefined) {
            runtime.write(`${JSON.stringify(pick(await resolve(row)))}\n`);
          }
        }
        return;
      }
      const rows: Array<Record<string, unknown>> = [];
      for await (const element of halElements<unknown>(getPage, startPath)) {
        const row = spec.row(element);
        if (row !== undefined) {
          rows.push(await resolve(row));
        }
      }
      runtime.write(renderRowsTable(view, rows));
      return;
    }
    const page = (await getPage(startPath)) as {
      total?: unknown;
      _embedded?: { elements?: readonly unknown[] };
    };
    const elements = page._embedded?.elements ?? [];
    const rows: Array<Record<string, unknown>> = [];
    for (const element of elements) {
      const row = spec.row(element);
      if (row !== undefined) {
        rows.push(await resolve(row));
      }
    }
    emitRows(runtime, spec.columns, rows, options);
    // The notice compares against what the API delivered on the page, not
    // the post-filter count: a comments listing drops other activity kinds
    // even when the page was complete.
    const total = typeof page.total === "number" ? page.total : elements.length;
    if (total > elements.length) {
      runtime.writeErr(
        `Showing ${rows.length} of ${total} records. `
          + "Pass --all to fetch every result.\n",
      );
    }
  });
  return command;
}

