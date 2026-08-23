import type { Command } from "commander";

import {
  clearStoredMetadata,
  loadStoredMetadata,
  readStoredMetadata,
  refreshStoredMetadata,
  type LookupRow,
  type MetadataChange,
  type StoredMetadata,
  type StoredPriority,
  type StoredStatus,
  type StoredType,
} from "../context/metadata.js";
import type { ActiveProfile } from "../context/profile.js";
import type { RunEnvironment } from "../run.js";
import { defineLookupCommand, type LookupSpec } from "../core/define.js";
import { renderTable } from "../output/table.js";

export interface MetaRuntime {
  readonly env: RunEnvironment;
  readonly resolve: () => Promise<ActiveProfile>;
  readonly write: (text: string) => void;
  readonly setJsonMode: (on: boolean) => void;
}

function star(value: unknown): string {
  return value === true ? "*" : "";
}

const typeLookup: LookupSpec<StoredType> = {
  name: "types",
  description: "List the work package types of the instance",
  select: (metadata) => metadata.types,
  columns: [
    { title: "ID", cell: (entry) => String(entry.id) },
    { title: "NAME", cell: (entry) => entry.name },
    { title: "MILESTONE", cell: (entry) => star(entry.is_milestone) },
  ],
};

const statusLookup: LookupSpec<StoredStatus> = {
  name: "statuses",
  description: "List the work package statuses of the instance",
  select: (metadata) => metadata.statuses,
  columns: [
    { title: "ID", cell: (entry) => String(entry.id) },
    { title: "NAME", cell: (entry) => entry.name },
    { title: "CLOSED", cell: (entry) => star(entry.is_closed) },
    { title: "DEFAULT", cell: (entry) => star(entry.is_default) },
  ],
  filters: [
    {
      flag: "--open",
      description: "only statuses that are not closed",
      keep: (entry) => !entry.is_closed,
    },
    {
      flag: "--closed",
      description: "only closed statuses",
      keep: (entry) => entry.is_closed,
    },
  ],
};

const priorityLookup: LookupSpec<StoredPriority> = {
  name: "priorities",
  description: "List the work package priorities of the instance",
  select: (metadata) => metadata.priorities,
  columns: [
    { title: "ID", cell: (entry) => String(entry.id) },
    { title: "NAME", cell: (entry) => entry.name },
    { title: "DEFAULT", cell: (entry) => star(entry.is_default) },
  ],
};

// The sections below are stored by issue #5; until then they render what
// the store holds, which is an honest empty list.
function projectScoped(
  metadata: StoredMetadata,
  section: string,
): ReadonlyArray<LookupRow> {
  return metadata.projectScoped?.[section] ?? [];
}

const memberLookup: LookupSpec<LookupRow> = {
  name: "members",
  description: "List the members of the active project",
  select: (metadata) => projectScoped(metadata, "members"),
  columns: [
    { title: "ID", cell: (entry) => String(entry.id) },
    { title: "NAME", cell: (entry) => entry.name },
  ],
};

const versionLookup: LookupSpec<LookupRow> = {
  name: "versions",
  description: "List the versions of the active project",
  select: (metadata) => projectScoped(metadata, "versions"),
  columns: [
    { title: "ID", cell: (entry) => String(entry.id) },
    { title: "NAME", cell: (entry) => entry.name },
  ],
};

const categoryLookup: LookupSpec<LookupRow> = {
  name: "categories",
  description: "List the categories of the active project",
  select: (metadata) => projectScoped(metadata, "categories"),
  columns: [
    { title: "ID", cell: (entry) => String(entry.id) },
    { title: "NAME", cell: (entry) => entry.name },
  ],
};

const fieldLookup: LookupSpec<LookupRow> = {
  name: "fields",
  description: "List the custom fields of the active project",
  select: (metadata) => projectScoped(metadata, "fields"),
  columns: [
    { title: "ID", cell: (entry) => String(entry.id) },
    { title: "NAME", cell: (entry) => entry.name },
  ],
};

interface ActivityRow extends LookupRow {
  readonly is_default?: boolean;
}

const activityLookup: LookupSpec<ActivityRow> = {
  name: "activities",
  description: "List the time entry activities of the active project",
  select: (metadata) => projectScoped(metadata, "activities") as ReadonlyArray<ActivityRow>,
  columns: [
    { title: "ID", cell: (entry) => String(entry.id) },
    { title: "NAME", cell: (entry) => entry.name },
    { title: "DEFAULT", cell: (entry) => star(entry.is_default) },
  ],
};

function registerShow(parent: Command, runtime: MetaRuntime): void {
  const command = parent
    .command("show")
    .description("Show the stored metadata of the active profile")
    .option("--json", "emit a JSON object");
  command.action(async (options: { json?: boolean }) => {
    runtime.setJsonMode(options.json === true);
    const profile = await runtime.resolve();
    const stored = await readStoredMetadata(runtime.env, profile);
    if (stored === undefined) {
      runtime.write(
        options.json === true
          ? "null\n"
          : "No metadata stored yet.\nRun op-cli meta types to load it.\n",
      );
      return;
    }
    if (options.json === true) {
      runtime.write(`${JSON.stringify(stored)}\n`);
      return;
    }
    runtime.write(
      renderTable(
        ["KEY", "VALUE"],
        [
          ["profile", profile.name],
          ["instance", stored.instance.url],
          ["api_version", stored.instance.api_version ?? ""],
          ["core_version", stored.instance.core_version ?? ""],
          ["fetched_at", stored.instance.fetched_at],
          ["project", formatProjectRef(stored)],
          ["types", String(stored.types.length)],
          ["statuses", String(stored.statuses.length)],
          ["priorities", String(stored.priorities.length)],
        ],
      ),
    );
  });
}

function formatProjectRef(stored: StoredMetadata): string {
  return stored.project === undefined
    ? ""
    : `${String(stored.project.id)} (${stored.project.identifier})`;
}

function registerRefresh(parent: Command, runtime: MetaRuntime): void {
  const command = parent
    .command("refresh")
    .description("Re-fetch the stored metadata and report what changed")
    .option("--json", "emit a JSON object");
  command.action(async (options: { json?: boolean }) => {
    runtime.setJsonMode(options.json === true);
    const profile = await runtime.resolve();
    const changes = await refreshStoredMetadata(runtime.env, profile);
    if (options.json === true) {
      runtime.write(
        `${JSON.stringify({
          profile: profile.name,
          instance: profile.instanceUrl,
          changes,
        })}\n`,
      );
      return;
    }
    runtime.write(
      `Refreshing metadata for profile ${profile.name} at ${profile.instanceUrl}.\n`,
    );
    writeChangeLines(runtime.write, changes);
    runtime.write(changes.length > 0 ? "Metadata updated.\n" : "No changes.\n");
  });
}

function writeChangeLines(
  write: (text: string) => void,
  changes: ReadonlyArray<MetadataChange>,
): void {
  let index = 0;
  while (index < changes.length) {
    const section = changes[index]?.section;
    const details: Array<string> = [];
    while (index < changes.length && changes[index]?.section === section) {
      const detail = changes[index]?.detail;
      if (detail !== undefined) {
        details.push(detail);
      }
      index += 1;
    }
    write(`${String(section)}: ${details.join("; ")}\n`);
  }
}

function registerClear(parent: Command, runtime: MetaRuntime): void {
  parent
    .command("clear")
    .description("Delete the stored metadata of the active profile")
    .action(async () => {
      const profile = await runtime.resolve();
      await clearStoredMetadata(runtime.env, profile);
      runtime.write(`Cleared stored metadata for profile ${profile.name}.\n`);
    });
}

function registerLookup<Row>(
  parent: Command,
  runtime: MetaRuntime,
  spec: LookupSpec<Row>,
): void {
  parent.addCommand(
    defineLookupCommand(spec, {
      load: async () => loadStoredMetadata(runtime.env, await runtime.resolve()),
      write: runtime.write,
      setJsonMode: runtime.setJsonMode,
    }),
  );
}

export function registerMetaCommands(parent: Command, runtime: MetaRuntime): void {
  // Eight read-only lookups, one declaration each.
  registerLookup(parent, runtime, typeLookup);
  registerLookup(parent, runtime, statusLookup);
  registerLookup(parent, runtime, priorityLookup);
  registerLookup(parent, runtime, memberLookup);
  registerLookup(parent, runtime, versionLookup);
  registerLookup(parent, runtime, categoryLookup);
  registerLookup(parent, runtime, fieldLookup);
  registerLookup(parent, runtime, activityLookup);
  registerShow(parent, runtime);
  registerRefresh(parent, runtime);
  registerClear(parent, runtime);
}
