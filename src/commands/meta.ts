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
import { parseProjectOverride, type ContextOverrides } from "../context/profile.js";
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
  flag: "--project <name-or-id>",
  description: "override the profile default project",
};

const profileOption = {
  flag: "--profile <name>",
  description: "use this profile for this command only",
};

const typeLookup: LookupSpec<StoredType, StoredMetadata> = {
  name: "types",
  description: "List the work package types of the instance",
  select: (metadata) => metadata.types,
  options: [profileOption],
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
  options: [profileOption],
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
  options: [profileOption],
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
  options: [profileOption, projectOption],
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
  options: [profileOption, projectOption],
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
  options: [profileOption, projectOption],
  columns: [
    { title: "ID", cell: (entry) => String(entry.id) },
    { title: "NAME", cell: (entry) => entry.name },
  ],
};

/** What the fields lookup reads: the vocabulary plus the type names. */
interface FieldData {
  readonly metadata: StoredMetadata;
  readonly vocabulary: ProjectVocabulary;
}

/** One custom field with the work package types that expose it. */
interface FieldRow extends StoredCustomField {
  readonly types: ReadonlyArray<string>;
}

/**
 * One row per custom field, however many work package types carry it.
 * `custom_fields` is stored keyed by type id, so flattening it repeats a
 * shared field once per type; a custom field is defined once for the
 * instance, so those copies differ only in which type exposes them and
 * that difference belongs in the TYPES column, not in extra rows.
 *
 * The `wp create` resolver keeps reading the per-type map directly: there
 * a shared name repeated across types is exactly what makes it ambiguous.
 */
function uniqueFields(data: FieldData): ReadonlyArray<FieldRow> {
  const typeName = new Map(
    data.metadata.types.map((entry) => [String(entry.id), entry.name]),
  );
  const byKey = new Map<string, { field: StoredCustomField; types: Array<string> }>();
  for (const [typeId, fields] of Object.entries(data.vocabulary.custom_fields)) {
    const owner = typeName.get(typeId) ?? typeId;
    for (const field of fields) {
      const existing = byKey.get(field.key);
      if (existing === undefined) {
        byKey.set(field.key, { field, types: [owner] });
        continue;
      }
      if (!existing.types.includes(owner)) {
        existing.types.push(owner);
      }
    }
  }
  return [...byKey.values()]
    .map((entry) => ({ ...entry.field, types: entry.types }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const fieldLookup: LookupSpec<FieldRow, FieldData> = {
  name: "fields",
  description: "List the custom fields of the active project",
  select: uniqueFields,
  options: [profileOption, projectOption],
  columns: [
    { title: "ID", cell: (entry) => String(entry.id) },
    { title: "NAME", cell: (entry) => entry.name },
    { title: "KEY", cell: (entry) => entry.key },
    { title: "TYPES", cell: (entry) => entry.types.join(", ") },
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
  options: [profileOption, projectOption],
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
    .option("--profile <name>", "use this profile for this command only")
    .option("--json", "emit a JSON object");
  command.action(async (options: { profile?: string; json?: boolean }) => {
    runtime.setJsonMode(options.json === true);
    const profile = await runtime.resolve({ profile: options.profile });
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
    .option("--profile <name>", "use this profile for this command only")
    .option("--json", "emit a JSON object");
  command.action(async (options: { profile?: string; json?: boolean }) => {
    runtime.setJsonMode(options.json === true);
    const profile = await runtime.resolve({ profile: options.profile });
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
    .option("--profile <name>", "use this profile for this command only")
    .action(async (options: { profile?: string }) => {
      const profile = await runtime.resolve({ profile: options.profile });
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

/** The `--profile` override a lookup was handed, if any. */
function profileOverride(options: ParsedOptions): string | undefined {
  return typeof options.profile === "string" ? options.profile : undefined;
}

function instanceLoad(runtime: MetaRuntime): MetaLoader<StoredMetadata> {
  return async (options) =>
    loadStoredMetadata(
      runtime.env,
      await runtime.resolve({ profile: profileOverride(options) }),
    );
}

/** The active profile under this run's --profile/--project overrides. */
async function projectProfile(
  runtime: MetaRuntime,
  options: ParsedOptions,
): Promise<ActiveProfile> {
  const raw = options.project;
  return runtime.resolve({
    profile: profileOverride(options),
    project: parseProjectOverride(typeof raw === "string" ? raw : undefined),
  });
}

function projectLoad(runtime: MetaRuntime): MetaLoader<ProjectVocabulary> {
  return async (options) =>
    loadProjectVocabulary(runtime.env, await projectProfile(runtime, options));
}

/**
 * The fields lookup needs the instance types too, to name them. Instance
 * metadata is loaded first because the vocabulary is stored inside it, so
 * an empty cache is filled by one fetch of each rather than two.
 */
function fieldLoad(runtime: MetaRuntime): MetaLoader<FieldData> {
  return async (options) => {
    const profile = await projectProfile(runtime, options);
    const metadata = await loadStoredMetadata(runtime.env, profile);
    return {
      metadata,
      vocabulary: await loadProjectVocabulary(runtime.env, profile),
    };
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
  addLookup(parent, runtime, fieldLookup, fieldLoad(runtime));
  addLookup(parent, runtime, activityLookup, project);
  registerShow(parent, runtime);
  registerRefresh(parent, runtime);
  registerClear(parent, runtime);
}
