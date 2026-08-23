import type { Command } from "commander";

import { OpCliError } from "../core/errors.js";
import { flattenHalRecord, isFlatLink } from "../core/hal.js";
import { apiGet } from "../core/http.js";
import { isIdForm, rankByCloseness } from "../context/resolve.js";
import {
  parseOptionalId,
  type ActiveProfile,
  type ContextOverrides,
} from "../context/profile.js";
import { renderTable } from "../output/table.js";

export interface WpRuntime {
  readonly resolve: (overrides?: ContextOverrides) => Promise<ActiveProfile>;
  readonly write: (text: string) => void;
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

export function registerWpCommands(wp: Command, runtime: WpRuntime): void {
  wp.description("Inspect and manage work packages");
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
