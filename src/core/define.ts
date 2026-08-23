import { Command } from "commander";

import { OpCliError } from "./errors.js";
import { renderTable } from "../output/table.js";

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
