import { Command } from "commander";

import type { StoredMetadata } from "../context/metadata.js";
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

/**
 * Declaration of one read-only lookup command. Adding a lookup to the CLI
 * means writing one of these (under 30 lines) and registering it; no
 * bespoke command code is ever written.
 */
export interface LookupSpec<Row> {
  readonly name: string;
  readonly description: string;
  readonly select: (metadata: StoredMetadata) => ReadonlyArray<Row>;
  readonly columns: ReadonlyArray<LookupColumn<Row>>;
  readonly filters?: ReadonlyArray<LookupFilter<Row>>;
}

export interface LookupRuntime {
  readonly load: () => Promise<StoredMetadata>;
  readonly write: (text: string) => void;
  readonly setJsonMode: (on: boolean) => void;
}

export function defineLookupCommand<Row>(
  spec: LookupSpec<Row>,
  runtime: LookupRuntime,
): Command {
  const command = new Command(spec.name).description(spec.description);
  const filters = spec.filters ?? [];
  for (const filter of filters) {
    command.option(filter.flag, filter.description);
  }
  command.option("--json", "emit a JSON array");
  command.action(async (options: Record<string, boolean | undefined>) => {
    runtime.setJsonMode(options.json === true);
    const active = filters.filter(
      (filter) => options[filter.flag.replace(/^--/, "")] === true,
    );
    if (active.length > 1) {
      throw new OpCliError("USAGE_ERROR");
    }
    let rows = spec.select(await runtime.load());
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
