import type { Command } from "commander";

import {
  clearStoredMetadata,
  customFieldAllowedNames,
  loadProjectVocabulary,
  loadStoredMetadata,
  readStoredMetadata,
  refreshStoredMetadata,
  type MetadataChange,
  type ProjectVocabulary,
  type StoredActivity,
  type StoredCategory,
  type StoredCustomField,
  type StoredMember,
  type StoredMetadata,
  type StoredPriority,
  type StoredStatus,
  type StoredVersion,
  type StoredType,
} from "../context/metadata.js";
import type { ActiveProfile } from "../context/profile.js";
import { parseOptionalId, type ContextOverrides } from "../context/profile.js";
import type { RunEnvironment } from "../run.js";
import {
  defineLookupCommand,
  type LookupSpec,
  type ParsedOptions,
} from "../core/define.js";
import { renderTable } from "../output/table.js";

export interface MetaRuntime {
  readonly env: RunEnvironment;
  readonly resolve: (overrides?: ContextOverrides) => Promise<ActiveProfile>;
  readonly write: (text: string) => void;
  readonly setJsonMode: (on: boolean) => void;
}

function star(value: unknown): string {
  return value === true ? "*" : "";
}

const projectOption = {
  flag: "--project <id>",
  description: "override the profile default project",
};

const typeLookup: LookupSpec<StoredType, StoredMetadata> = {
  name: "types",
  description: "List the work package types of the instance",
  select: (metadata) => metadata.types,
  columns: [
    { title: "ID", cell: (entry) => String(entry.id) },
    { title: "NAME", cell: (entry) => entry.name },
    { title: "MILESTONE", cell: (entry) => star(entry.is_milestone) },
  ],
};

const statusLookup: LookupSpec<StoredStatus, StoredMetadata> = {
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

const priorityLookup: LookupSpec<StoredPriority, StoredMetadata> = {
  name: "priorities",
  description: "List the work package priorities of the instance",
  select: (metadata) => metadata.priorities,
  columns: [
    { title: "ID", cell: (entry) => String(entry.id) },
    { title: "NAME", cell: (entry) => entry.name },
    { title: "DEFAULT", cell: (entry) => star(entry.is_default) },
  ],
};

const memberLookup: LookupSpec<StoredMember, ProjectVocabulary> = {
  name: "members",
  description: "List the members of the active project",
  select: (vocabulary) => vocabulary.members,
  options: [projectOption],
  columns: [
    { title: "ID", cell: (entry) => String(entry.user_id) },
    { title: "NAME", cell: (entry) => entry.name },
    { title: "TYPE", cell: (entry) => entry.type },
    {
      title: "ROLES",
      cell: (entry) => entry.roles.map((role) => role.title).join(", "),
    },
  ],
};

const versionLookup: LookupSpec<StoredVersion, ProjectVocabulary> = {
  name: "versions",
  description: "List the versions of the active project",
  select: (vocabulary) => vocabulary.versions,
  options: [projectOption],
  columns: [
    { title: "ID", cell: (entry) => String(entry.id) },
    { title: "NAME", cell: (entry) => entry.name },
    { title: "STATUS", cell: (entry) => entry.status },
  ],
};

const categoryLookup: LookupSpec<StoredCategory, ProjectVocabulary> = {
  name: "categories",
  description: "List the categories of the active project",
  select: (vocabulary) => vocabulary.categories,
  options: [projectOption],
  columns: [
    { title: "ID", cell: (entry) => String(entry.id) },
    { title: "NAME", cell: (entry) => entry.name },
  ],
};

/**
 * One row per (type, custom field) pair: when a custom field is attached
 * to several work package types it appears SEVERAL times here under the
 * same name (distinct keys), so the result is not unique by name. The wp
 * create resolver relies on exactly this duplication to declare a shared
 * name ambiguous.
 */
function flattenFields(
  vocabulary: ProjectVocabulary,
): ReadonlyArray<StoredCustomField> {
  const fields = Object.values(vocabulary.custom_fields).flat();
  return [...fields].sort((a, b) => a.name.localeCompare(b.name));
}

const fieldLookup: LookupSpec<StoredCustomField, ProjectVocabulary> = {
  name: "fields",
  description: "List the custom fields of the active project",
  select: flattenFields,
  options: [projectOption],
  columns: [
    { title: "ID", cell: (entry) => String(entry.id) },
    { title: "NAME", cell: (entry) => entry.name },
    { title: "KEY", cell: (entry) => entry.key },
    {
      title: "ALLOWED VALUES",
      cell: (entry) => customFieldAllowedNames(entry).join(", "),
    },
  ],
};

const activityLookup: LookupSpec<StoredActivity, ProjectVocabulary> = {
  name: "activities",
  description: "List the time entry activities of the active project",
  select: (vocabulary) => vocabulary.activities,
  options: [projectOption],
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

type MetaLoader<Data> = (options: ParsedOptions) => Promise<Data>;

function addLookup<Row, Data>(
  parent: Command,
  runtime: MetaRuntime,
  spec: LookupSpec<Row, Data>,
  load: MetaLoader<Data>,
): void {
  parent.addCommand(
    defineLookupCommand(spec, {
      load,
      write: runtime.write,
      setJsonMode: runtime.setJsonMode,
    }),
  );
}

function instanceLoad(runtime: MetaRuntime): MetaLoader<StoredMetadata> {
  return async () =>
    loadStoredMetadata(runtime.env, await runtime.resolve());
}

function projectLoad(runtime: MetaRuntime): MetaLoader<ProjectVocabulary> {
  return async (options) => {
    const raw = options.project;
    const project = parseOptionalId(typeof raw === "string" ? raw : undefined);
    const profile = await runtime.resolve({ project });
    return loadProjectVocabulary(runtime.env, profile);
  };
}

export function registerMetaCommands(parent: Command, runtime: MetaRuntime): void {
  // Eight read-only lookups, one declaration each.
  const instance = instanceLoad(runtime);
  const project = projectLoad(runtime);
  addLookup(parent, runtime, typeLookup, instance);
  addLookup(parent, runtime, statusLookup, instance);
  addLookup(parent, runtime, priorityLookup, instance);
  addLookup(parent, runtime, memberLookup, project);
  addLookup(parent, runtime, versionLookup, project);
  addLookup(parent, runtime, categoryLookup, project);
  addLookup(parent, runtime, fieldLookup, project);
  addLookup(parent, runtime, activityLookup, project);
  registerShow(parent, runtime);
  registerRefresh(parent, runtime);
  registerClear(parent, runtime);
}
