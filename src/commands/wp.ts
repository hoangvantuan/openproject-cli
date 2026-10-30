import type { Command } from "commander";

import { OpCliError, refuseCombined, writeRefusal } from "../core/errors.js";
import {
  applyScalars,
  SCALAR_OPTIONS,
  scalarFlag,
  validateScalars,
  type ScalarFlags,
} from "../core/scalars.js";
import {
  buildWpFilters,
  filtersQuery,
  type WpFilter,
  type WpListFlags,
} from "../core/filters.js";
import {
  defineCollectionCommand,
  emitRows,
  PAGED_JSON_HELP,
  type CollectionRuntime,
} from "../core/define.js";
import { flattenHalRecord, isFlatLink, toFormattable } from "../core/hal.js";
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiPatchRaw,
  apiPostRaw,
  authenticate,
  type RawWriteResponse,
} from "../core/http.js";
import {
  allPageSize,
  DEFAULT_PAGE_SIZE,
  halElements,
  parsePageSize,
  withPageSize,
} from "../core/paginate.js";
import {
  explicitCustomFieldKey,
  isIdForm,
  matchByName,
  rankByCloseness,
  resolveName,
  type LookupSource,
  type NamedEntry,
} from "../context/resolve.js";
import {
  parseProjectOverride,
  type ActiveProfile,
  type ContextOverrides,
} from "../context/profile.js";
import { resolveProjectRef } from "../context/projectref.js";
import {
  loadProjectVocabulary,
  loadProjectVocabularyById,
  loadStoredMetadata,
  refreshProjectVocabulary,
  refreshStoredMetadata,
  requireVocabulary,
  type ProjectVocabulary,
  type StoredVersionField,
  type StoredVersionFields,
  type StoredCustomField,
  type StoredMetadata,
} from "../context/metadata.js";
import type { RunEnvironment } from "../run.js";
import { formatCell, renderTable } from "../output/table.js";

export interface WpRuntime {
  readonly env: RunEnvironment;
  readonly resolve: (overrides?: ContextOverrides) => Promise<ActiveProfile>;
  readonly write: (text: string) => void;
  readonly writeErr: (text: string) => void;
  readonly setJsonMode: (on: boolean) => void;
  /** Present only when the host can hand over stdin (bin.ts can). */
  readonly readStdin?: () => Promise<string>;
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
  "targetVersions",
  "observedInVersions",
  "category",
  "startDate",
  "dueDate",
  "estimatedTime",
  "remainingTime",
  "percentageDone",
  "storyPoints",
  "createdAt",
  "updatedAt",
  "lockVersion",
] as const;

// The list table is fixed: these are the columns an agent scans first.
export const LIST_COLUMNS: ReadonlyArray<{ readonly title: string; readonly field: string }> = [
  { title: "ID", field: "id" },
  { title: "SUBJECT", field: "subject" },
  { title: "TYPE", field: "type" },
  { title: "STATUS", field: "status" },
  { title: "PRIORITY", field: "priority" },
  { title: "ASSIGNEE", field: "assignee" },
  { title: "UPDATED", field: "updatedAt" },
];

interface WorkPackagePage {
  readonly total?: unknown;
  readonly _embedded?: { readonly elements?: readonly unknown[] };
}

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
  /**
   * What already happened, when the record is the result of a completed
   * write. A bad --fields name is still misuse, but the message has to
   * say the write landed or it invites a repeat that writes twice.
   */
  done?: string,
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
      `${done === undefined ? "" : `${done}; `}`
        + `field "${first}" is not a column. Valid fields, closest first: `
        + `${rankByCloseness(first, Object.keys(record)).join(", ")}.`,
      "run the command without --fields to list every available column.",
    );
  }
  return requested;
}

/** Work packages are addressed by numeric id everywhere on this surface. */
function requireWpId(reference: string): void {
  if (!isIdForm(reference)) {
    throw new OpCliError(
      "USAGE_ERROR",
      `work package "${reference}" is not an id.`,
      "work packages are addressed by their numeric id.",
    );
  }
}

/**
 * The one shared tail of every single-record command: --fields plus the
 * two shapes, a FIELD/VALUE table by default.
 */
function renderRecord(
  runtime: Pick<WpRuntime, "write">,
  options: { json?: boolean; fields?: string },
  record: Record<string, unknown>,
  done?: string,
): void {
  const fields = selectedFields(options.fields, record, done);
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
}

/**
 * The shared opening of every command on this surface: JSON mode first,
 * then the id check is the caller's, then the profile.
 */
async function openProfile(
  runtime: Pick<WpRuntime, "write" | "setJsonMode" | "resolve">,
  options: { json?: boolean; fields?: string; profile?: string; project?: string },
): Promise<ActiveProfile> {
  runtime.setJsonMode(options.json === true);
  return runtime.resolve({
    profile: options.profile,
    project: parseProjectOverride(options.project),
  });
}

function collectValue(value: string, previous: Array<string>): Array<string> {
  return [...previous, value];
}

/** Like collectValue, but a flag left out stays undefined, not empty. */
function collectOptional(value: string, previous?: Array<string>): Array<string> {
  return [...(previous ?? []), value];
}

interface FilterFlagOptions {
  readonly status?: Array<string>;
  readonly type?: Array<string>;
  readonly assignee?: Array<string>;
  readonly accountable?: Array<string>;
  readonly author?: Array<string>;
  readonly version?: Array<string>;
  readonly observedIn?: Array<string>;
  readonly category?: Array<string>;
  readonly sprint?: Array<string>;
  readonly bucket?: Array<string>;
  readonly backlogInbox?: boolean;
  readonly priority?: Array<string>;
  readonly parent?: Array<string>;
  readonly updatedAfter?: string;
  readonly createdAfter?: string;
  readonly dueBefore?: string;
  readonly dueAfter?: string;
  readonly overdue?: boolean;
  readonly search?: string;
  readonly open?: boolean;
  readonly closed?: boolean;
  readonly profile?: string;
  readonly project?: string;
}

/**
 * Attach the shared filter surface of `wp list` and `wp count`. Both
 * commands accept exactly the same flags; repeating a value flag ORs.
 */
function addFilterFlags(command: Command): Command {
  return command
    .option("--status <name>", "status name or id; repeat to OR values", collectValue, [])
    .option("--type <name>", "type name or id; repeat to OR values", collectValue, [])
    .option("--assignee <name>", "user name, id, or me; repeat to OR values", collectValue, [])
    .option(
      "--accountable <name>",
      "Accountable (API field responsible): user name, id, or me; repeat to OR values",
      collectValue,
      [],
    )
    .option("--author <name>", "user name, id, or me; repeat to OR values", collectValue, [])
    .option("--version <name>", "version name or id; repeat to OR values", collectValue, [])
    .option(
      "--observed-in <name>",
      "observed-in version name or id; repeat to OR values",
      collectValue,
      [],
    )
    .option("--category <name>", "category name or id; repeat to OR values", collectValue, [])
    .option("--sprint <name>", "sprint name or id; repeat to OR values", collectValue, [])
    .option("--bucket <name>", "backlog bucket name or id; repeat to OR values", collectValue, [])
    .option(
      "--backlog-inbox",
      "only work packages in the backlog inbox: in neither a sprint nor a backlog bucket",
    )
    .option("--priority <name>", "priority name or id; repeat to OR values", collectValue, [])
    .option("--parent <reference>", "parent work package id or exact subject", collectValue, [])
    .option(
      "--updated-after <value>",
      "today, yesterday, days back such as 7d, or YYYY-MM-DD",
    )
    .option(
      "--created-after <value>",
      "only work packages created since; same date forms as --updated-after",
    )
    .option(
      "--due-before <date>",
      "due on or before this date: YYYY-MM-DD, today, yesterday, or Nd; "
        + "today/yesterday/Nd count back from today, only YYYY-MM-DD reaches the future",
    )
    .option("--due-after <date>", "due on or after this date; same date forms as --due-before")
    .option("--overdue", "open work packages whose due date is before today")
    .option("--search <text>", "substring matched against work package subjects")
    .option("--open", "shorthand for every open status")
    .option("--closed", "shorthand for every closed status")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <name-or-id>", "override the profile default project");
}

function rawListFlags(options: FilterFlagOptions): WpListFlags {
  return {
    statuses: options.status,
    types: options.type,
    assignees: options.assignee,
    accountables: options.accountable,
    authors: options.author,
    versions: options.version,
    observedIn: options.observedIn,
    categories: options.category,
    sprints: options.sprint,
    buckets: options.bucket,
    backlogInbox: options.backlogInbox,
    priorities: options.priority,
    parents: options.parent,
    updatedAfter: options.updatedAfter,
    createdAfter: options.createdAfter,
    dueBefore: options.dueBefore,
    dueAfter: options.dueAfter,
    overdue: options.overdue,
    search: options.search,
    open: options.open,
    closed: options.closed,
  };
}

/** Metadata that lives instance-wide: statuses, types, priorities. */
function instanceSource<V>(
  runtime: WpRuntime,
  profile: ActiveProfile,
  label: string,
  select: (metadata: StoredMetadata) => ReadonlyArray<NamedEntry<V>>,
  memo?: ResolutionMemo,
): LookupSource<V> {
  return {
    label,
    load: async () =>
      select(await (memo === undefined
        ? loadStoredMetadata(runtime.env, profile)
        : memo.metadata())),
    refresh: async () => {
      // Drop the shared snapshots before and while the store is rebuilt:
      // a concurrent item must never read the stale one.
      memo?.invalidate();
      await refreshStoredMetadata(runtime.env, profile);
    },
  };
}

/** Metadata scoped to the profile's project: members, versions, categories. */
function projectSource<V>(
  runtime: WpRuntime,
  profile: ActiveProfile,
  flag: string,
  label: string,
  select: (vocabulary: ProjectVocabulary) => ReadonlyArray<NamedEntry<V>>,
  memo?: ResolutionMemo,
): LookupSource<V> {
  return {
    label,
    load: async () => {
      if (profile.project === undefined) {
        throw new OpCliError(
          "USAGE_ERROR",
          `--${flag} needs a project to look names up in.`,
          "pass --project <name-or-id> or set a default project on the profile.",
        );
      }
      return select(await (memo === undefined
        ? loadProjectVocabulary(runtime.env, profile)
        : memo.vocabulary()));
    },
    refresh: async () => {
      memo?.invalidate();
      await refreshStoredMetadata(runtime.env, profile);
    },
  };
}

/** The two backlog placements a work package link can name (#46). */
const BACKLOG_SOURCES = {
  sprint: { source: "sprints", owner: "Sprint", plural: "sprints" },
  bucket: { source: "buckets", owner: "Bucket", plural: "backlog buckets" },
} as const;

/**
 * The sprints or backlog buckets of the profile's project, on the same
 * footing as the other project sources. A store from before #46 lacks
 * them and an empty list may simply be stale, so an empty read re-reads
 * this project once; a project that still has none fails naming the
 * project instead of matching against nothing. Only this project is
 * refreshed: the failure path would otherwise re-fetch every cached
 * project on each call.
 */
function backlogSource(
  runtime: WpRuntime,
  profile: ActiveProfile,
  flag: keyof typeof BACKLOG_SOURCES,
  memo?: ResolutionMemo,
): LookupSource<number> {
  const { source, owner, plural } = BACKLOG_SOURCES[flag];
  const project = projectSource<number>(
    runtime,
    profile,
    flag,
    flag,
    (vocabulary) => {
      const entries: ReadonlyArray<{ readonly id: number; readonly name: string }> =
        requireVocabulary(vocabulary, source);
      return entries.map((entry) => ({ name: entry.name, owner, value: entry.id }));
    },
    memo,
  );
  const refresh = async (): Promise<void> => {
    memo?.invalidate();
    await refreshProjectVocabulary(runtime.env, profile, Number(profile.project));
  };
  return {
    label: project.label,
    load: async () => {
      let entries = await project.load();
      if (entries.length === 0) {
        await refresh();
        entries = await project.load();
      }
      if (entries.length === 0) {
        throw new OpCliError(
          "USAGE_ERROR",
          `--${flag}: project ${String(profile.project)} has no ${plural}.`,
          `run op-cli project ${source} ${String(profile.project)} to check, `
            + `or leave --${flag} out.`,
        );
      }
      return entries;
    },
    refresh,
  };
}

async function resolveValues<V>(
  raws: ReadonlyArray<string>,
  source: LookupSource<V>,
): Promise<Array<string>> {
  const ids: Array<string> = [];
  for (const raw of raws) {
    const value = isIdForm(raw) ? Number(raw) : await resolveName(raw, source);
    const key = String(value);
    if (!ids.includes(key)) {
      ids.push(key);
    }
  }
  return ids;
}

async function resolveUserValues(
  runtime: WpRuntime,
  profile: ActiveProfile,
  flag: string,
  raws: ReadonlyArray<string>,
): Promise<Array<string>> {
  const source = projectSource<number>(runtime, profile, flag, flag, (vocabulary) =>
    vocabulary.members.map((member) => ({
      name: member.name,
      owner: member.type,
      value: member.user_id,
    })),
  );
  let authenticatedId: number | undefined;
  const ids: Array<string> = [];
  const push = (id: number | string): void => {
    const key = String(id);
    if (!ids.includes(key)) {
      ids.push(key);
    }
  };
  for (const raw of raws) {
    if (raw.toLowerCase() === "me") {
      authenticatedId ??= (await authenticate(profile.instanceUrl, profile.apiKey)).id;
      push(authenticatedId);
    } else if (isIdForm(raw)) {
      push(raw);
    } else {
      push(await resolveName(raw, source));
    }
  }
  return ids;
}

function membersSource(
  runtime: WpRuntime,
  profile: ActiveProfile,
  flag: string,
  memo?: ResolutionMemo,
): LookupSource<number> {
  return projectSource<number>(runtime, profile, flag, flag, (vocabulary) =>
    vocabulary.members.map((member) => ({
      name: member.name,
      owner: member.type,
      value: member.user_id,
    })),
    memo,
  );
}

// ---------------------------------------------------------------------------
// wp create


/**
 * The value flags shared verbatim by one create and every stdin item. The
 * scalar attributes come from ScalarFlags, the one list the payload writer
 * also reads.
 */
interface CreateValueFlags extends ScalarFlags {
  readonly type?: string;
  readonly status?: string;
  readonly priority?: string;
  readonly assignee?: string;
  readonly accountable?: string;
  /** Versions by name or id; `[""]` clears on update. */
  readonly version?: ReadonlyArray<string>;
  readonly observedIn?: ReadonlyArray<string>;
  readonly category?: string;
  /** A sprint or, exclusively, a backlog bucket (#46). */
  readonly sprint?: string;
  readonly bucket?: string;
  readonly parent?: string;
  readonly description?: string;
  readonly field?: Array<string>;
}

/**
 * Every value flag, once. A key added to CreateValueFlags fails to compile
 * until it is listed here, and this list feeds the stdin key check and the
 * update "touches something" guard, so a new flag cannot be forgotten in
 * either.
 */
const VALUE_OPTIONS: Readonly<Record<keyof CreateValueFlags, true>> = {
  type: true,
  status: true,
  priority: true,
  assignee: true,
  accountable: true,
  version: true,
  observedIn: true,
  category: true,
  sprint: true,
  bucket: true,
  parent: true,
  description: true,
  field: true,
  start: true,
  due: true,
  estimate: true,
  remaining: true,
  done: true,
  storyPoints: true,
};

interface CreateOptions extends CreateValueFlags {
  readonly stdin?: boolean;
  readonly dryRun?: boolean;
  readonly failFast?: boolean;
  readonly json?: boolean;
  readonly fields?: string;
  readonly profile?: string;
  readonly project?: string;
}

/**
 * One bulk run resolves against one profile: vocabulary snapshots and
 * the authenticated user are computed at most once and reused by every
 * item instead of refetched per item. Any metadata refresh drops every
 * memo, so the ADR-0002 retry still sees fresh ids.
 */
interface ResolutionMemo {
  readonly metadata: () => Promise<StoredMetadata>;
  readonly vocabulary: () => Promise<ProjectVocabulary>;
  readonly me: () => Promise<number>;
  readonly invalidate: () => void;
}

function newResolutionMemo(
  runtime: WpRuntime,
  profile: ActiveProfile,
): ResolutionMemo {
  let metadata: Promise<StoredMetadata> | undefined;
  let vocabulary: Promise<ProjectVocabulary> | undefined;
  let me: Promise<number> | undefined;
  // A rejected load clears its slot so one failing item cannot poison
  // the shared promise for every later item.
  const guarded = async <T>(build: () => Promise<T>, clear: () => void): Promise<T> => {
    try {
      return await build();
    } catch (error) {
      clear();
      throw error;
    }
  };
  return {
    metadata: () => {
      metadata ??= guarded(() => loadStoredMetadata(runtime.env, profile), () => {
        metadata = undefined;
      });
      return metadata;
    },
    vocabulary: () => {
      vocabulary ??= guarded(
        () => loadProjectVocabulary(runtime.env, profile),
        () => {
          vocabulary = undefined;
        },
      );
      return vocabulary;
    },
    me: () => {
      me ??= guarded(
        () => authenticate(profile.instanceUrl, profile.apiKey).then((user) => user.id),
        () => {
          me = undefined;
        },
      );
      return me;
    },
    invalidate: () => {
      metadata = undefined;
      vocabulary = undefined;
      me = undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Bulk creation from stdin

/**
 * Everything the two create paths share up to the wire: values resolved
 * by name into a payload with the subject and project link attached.
 */
async function prepareCreatePayload(
  runtime: WpRuntime,
  profile: ActiveProfile,
  subject: string,
  values: CreateValueFlags,
  memo?: ResolutionMemo,
): Promise<{ payload: Record<string, unknown>; refs: Array<ResolvedAttribute> }> {
  const { payload, refs } = await resolveNamedValues(runtime, profile, values, memo);
  payload.subject = subject;
  const links = payload._links as Record<string, LinkValue>;
  links.project = { href: `/api/v3/projects/${String(profile.project)}` };
  return { payload, refs };
}

/**
 * The send tail both create paths share: one proof-carrying retry of
 * ADR-0002, then the closed catalogue mapping. Returns the raw body so
 * the single path can still flatten and render it.
 */
async function submitCreate(
  runtime: WpRuntime,
  profile: ActiveProfile,
  payload: Record<string, unknown>,
  refs: ReadonlyArray<ResolvedAttribute>,
  memo?: ResolutionMemo,
): Promise<unknown> {
  let response = await postCreate(profile, payload);
  if (response.status >= 400) {
    response = await retryWithFreshIds(
      runtime,
      profile,
      response,
      payload,
      refs,
      () => postCreate(profile, payload),
      memo,
    );
  }
  if (response.status >= 400) {
    throw writeRejection(response.status, response.body);
  }
  return response.body;
}

/**
 * Kebab spellings a stdin item may use for a camelCase key, mirroring the
 * flag. Both spell the same attribute; giving both is refused.
 */
const BULK_KEY_ALIASES: Readonly<Record<string, keyof CreateValueFlags>> = {
  "story-points": "storyPoints",
  "observed-in": "observedIn",
};

/** Keys one stdin item may carry; everything else is a loud usage error. */
const BULK_ITEM_KEYS: ReadonlyArray<string> = [
  "subject",
  ...Object.keys(VALUE_OPTIONS),
  ...Object.keys(BULK_KEY_ALIASES),
];

/**
 * One element of the --stdin array. Mirrors the value flags of the
 * single-subject path; every rejection names the offending input by its
 * zero-based index so the NDJSON line and the message agree.
 */
function parseBulkItem(
  raw: unknown,
  index: number,
): { subject: string; values: CreateValueFlags } {
  const usage = (message: string, hint?: string): OpCliError =>
    new OpCliError("USAGE_ERROR", `input ${index}: ${message}`, hint);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw usage('every input must be an object with a non-empty "subject".');
  }
  // Normalise into a copy: the caller's parsed object stays as it came in.
  const record: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const [alias, key] of Object.entries(BULK_KEY_ALIASES)) {
    if (record[alias] === undefined) {
      continue;
    }
    if (record[key] !== undefined) {
      throw usage(`"${alias}" and "${key}" are the same key; give one.`);
    }
    record[key] = record[alias];
    delete record[alias];
  }
  const unknownKeys = Object.keys(record)
    .filter((key) => !BULK_ITEM_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    throw usage(
      `unknown key(s): ${unknownKeys.join(", ")}.`,
      `allowed keys: ${BULK_ITEM_KEYS.join(", ")}.`,
    );
  }
  const subject = record.subject;
  if (typeof subject !== "string" || subject.trim() === "") {
    throw usage('every input needs a non-empty "subject" string.');
  }
  const values: { -readonly [K in keyof CreateValueFlags]?: CreateValueFlags[K] } = {};
  const scalarKeys: ReadonlyArray<
    Exclude<keyof CreateValueFlags, "field" | "version" | "observedIn">
  > = [
    "type",
    "status",
    "priority",
    "assignee",
    "accountable",
    "category",
    "sprint",
    "bucket",
    "parent",
    "description",
  ];
  for (const key of scalarKeys) {
    const rawValue = record[key];
    if (rawValue === undefined) {
      continue;
    }
    if (typeof rawValue !== "string" || rawValue === "") {
      throw usage(`"${key}" must be a non-empty name-or-id string.`);
    }
    values[key] = rawValue;
  }
  try {
    refuseTwoPlacements(values);
  } catch (error) {
    if (error instanceof OpCliError) {
      throw usage(error.message, error.hint);
    }
    throw error;
  }
  // A version key takes one name-or-id string or an array of them.
  for (const key of ["version", "observedIn"] as const) {
    const rawValue = record[key];
    if (rawValue === undefined) {
      continue;
    }
    const list = Array.isArray(rawValue) ? rawValue : [rawValue];
    if (
      list.length === 0
      || list.some((entry) => typeof entry !== "string" || entry === "")
    ) {
      throw usage(
        `"${key}" must be a non-empty name-or-id string or an array of them.`,
      );
    }
    values[key] = list as Array<string>;
  }
  for (const key of SCALAR_OPTIONS) {
    const rawValue = record[key];
    if (rawValue === undefined) {
      continue;
    }
    // Numbers are natural in JSON for done and story points, and hours
    // for the durations; they travel as the text a flag would carry.
    if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
      values[key] = String(rawValue);
    } else if (typeof rawValue === "string" && rawValue !== "") {
      values[key] = rawValue;
    } else {
      throw usage(`"${key}" must be a non-empty string or number.`);
    }
  }
  try {
    validateScalars(values);
  } catch (error) {
    // Re-raised with the item index; only a usage error is ours to relabel.
    if (error instanceof OpCliError && error.code === "USAGE_ERROR") {
      throw usage(error.message, error.hint);
    }
    throw error;
  }
  const field = record.field;
  if (field !== undefined) {
    if (
      !Array.isArray(field)
      || field.some((entry) => typeof entry !== "string")
    ) {
      throw usage(
        '"field" must be an array of "Name=Value" strings.',
        'e.g. "field": ["Estimate=5"]; "Name=" clears the field.',
      );
    }
    values.field = field as Array<string>;
  }
  return { subject, values };
}

/**
 * The --stdin batch: one NDJSON result line per input, in input order,
 * continuing past failures unless --fail-fast. Every item shares one
 * resolution memo; any failure ends the run with that failure's catalogue
 * exit code after the last line is out.
 */
async function runBulkCreate(
  runtime: WpRuntime,
  subjectArg: string | undefined,
  options: CreateOptions,
): Promise<void> {
  if (subjectArg !== undefined) {
    throw new OpCliError(
      "USAGE_ERROR",
      "wp create --stdin takes its subjects from the input array.",
      "drop the subject argument, or leave out --stdin to create one.",
    );
  }
  if (options.json === true) {
    throw new OpCliError(
      "USAGE_ERROR",
      "wp create --stdin already reports one NDJSON line per item.",
      "drop --json; each line is machine-readable as it is.",
    );
  }
  if (options.fields !== undefined) {
    throw new OpCliError(
      "USAGE_ERROR",
      "wp create --stdin reports a fixed result line per item, not a record.",
      "drop --fields; run op-cli wp get --fields on an id from the output.",
    );
  }
  const readStdin = runtime.readStdin;
  if (readStdin === undefined) {
    throw new OpCliError(
      "USAGE_ERROR",
      "stdin is not readable in this environment.",
      "pipe the JSON array from a file: op-cli wp create --stdin < wps.json.",
    );
  }
  runtime.setJsonMode(false);
  const text = await readStdin();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OpCliError(
      "USAGE_ERROR",
      "stdin did not carry valid JSON.",
      "wp create --stdin reads one JSON array of work packages.",
    );
  }
  if (!Array.isArray(parsed)) {
    throw new OpCliError(
      "USAGE_ERROR",
      "wp create --stdin expects a JSON array of work packages.",
      'each element is an object like {"subject": "...", "type": "Task"}.',
    );
  }

  const profile = await runtime.resolve({
    profile: options.profile,
    project: parseProjectOverride(options.project),
  });
  if (profile.project === undefined) {
    throw new OpCliError(
      "USAGE_ERROR",
      "wp create needs a project to create the work package in.",
      "pass --project <name-or-id> or set a default project on the profile.",
    );
  }

  const memo = newResolutionMemo(runtime, profile);
  const dryRun = options.dryRun === true;
  let attempted = 0;
  let failures = 0;
  let firstFailure: OpCliError | undefined;
  for (let index = 0; index < parsed.length; index++) {
    attempted += 1;
    try {
      const item = parseBulkItem(parsed[index], index);
      const { payload, refs } = await prepareCreatePayload(
        runtime,
        profile,
        item.subject,
        item.values,
        memo,
      );
      if (dryRun) {
        runtime.write(`${JSON.stringify({
          index,
          ok: true,
          status: "would-create",
          subject: item.subject,
        })}\n`);
        continue;
      }
      const body = await submitCreate(runtime, profile, payload, refs, memo);
      const id = typeof body === "object" && body !== null
        ? (body as Record<string, unknown>).id
        : undefined;
      runtime.write(`${JSON.stringify({
        index,
        ok: true,
        status: "created",
        ...(typeof id === "number" ? { id } : {}),
        subject: item.subject,
      })}\n`);
    } catch (error) {
      failures += 1;
      const failure = error instanceof OpCliError
        ? error
        : new OpCliError("INTERNAL_ERROR");
      firstFailure ??= failure;
      runtime.write(`${JSON.stringify({
        ...(failure.details ?? {}),
        index,
        ok: false,
        status: "failed",
        code: failure.code,
        message: failure.message,
        hint: failure.hint,
      })}\n`);
      if (options.failFast === true) {
        break;
      }
    }
  }
  if (firstFailure !== undefined) {
    // The run's exit code comes from the first failure's catalogue code,
    // so scripts matching on codes keep their promise across both paths.
    // The denominator is always the whole batch; an early stop says so
    // explicitly instead of shrinking the total.
    throw new OpCliError(
      firstFailure.code,
      attempted < parsed.length
        ? `${failures} of ${parsed.length} work packages failed; stopped after ${attempted}.`
        : `${failures} of ${parsed.length} work packages failed.`,
      "each failed input carries its own result line above.",
    );
  }
}

// ---------------------------------------------------------------------------
// wp update

interface UpdateOptions extends CreateValueFlags {
  readonly subject?: string;
  readonly json?: boolean;
  readonly fields?: string;
  readonly profile?: string;
  readonly project?: string;
}

interface FieldPair {
  readonly name: string;
  readonly value: string;
}

function splitFieldPair(raw: string): FieldPair {
  const at = raw.indexOf("=");
  if (at < 1) {
    throw new OpCliError(
      "USAGE_ERROR",
      `--field "${raw}" is not Name=Value.`,
      'separate the human field name from its value with an equals sign, '
        + 'e.g. --field "Estimate=5"; repeat the flag to add more values.',
    );
  }
  return { name: raw.slice(0, at), value: raw.slice(at + 1) };
}

/**
 * One row per (type, custom field) pair. A field attached to several
 * types appears once per type under the same human name; like
 * flattenFields in commands/meta.ts this list is NOT unique by name, and
 * that duplication is exactly what makes a shared name resolve as
 * ambiguous rather than wrong.
 */
function customFieldRows(
  metadata: StoredMetadata,
  vocabulary: ProjectVocabulary,
): ReadonlyArray<NamedEntry<string>> {
  const typeName = new Map(
    metadata.types.map((entry) => [String(entry.id), entry.name]),
  );
  const rows: Array<NamedEntry<string>> = [];
  for (const [typeId, fields] of Object.entries(vocabulary.custom_fields)) {
    const owner = `Type ${typeName.get(typeId) ?? typeId}`;
    for (const field of fields) {
      rows.push({ name: field.name, owner, value: field.key });
    }
  }
  return rows;
}

async function resolveFieldDefinition(
  runtime: WpRuntime,
  profile: ActiveProfile,
  rawName: string,
  memo?: ResolutionMemo,
): Promise<StoredCustomField> {
  if (profile.project === undefined) {
    throw new OpCliError(
      "USAGE_ERROR",
      "--field needs a project to look field names up in.",
      "pass --project <name-or-id> or set a default project on the profile.",
    );
  }
  const metadata = memo === undefined
    ? loadStoredMetadata(runtime.env, profile)
    : memo.metadata();
  const vocabulary = memo === undefined
    ? loadProjectVocabulary(runtime.env, profile)
    : memo.vocabulary();
  const source: LookupSource<string> = {
    label: "field",
    load: async () =>
      customFieldRows(await metadata, await vocabulary),
    refresh: async () => {
      memo?.invalidate();
      await refreshStoredMetadata(runtime.env, profile);
    },
  };
  const explicit = explicitCustomFieldKey(rawName);
  const key = explicit ?? await resolveName(rawName, source);
  const definitions = Object.values((await vocabulary).custom_fields).flat();
  const field = definitions.find((entry) => entry.key === key);
  if (field === undefined) {
    throw new OpCliError(
      "USAGE_ERROR",
      `custom field "${rawName}" is not defined in this project.`,
      `known fields: ${definitions
        .map((entry) => `${entry.key} (${entry.name})`)
        .join(", ")}.`,
    );
  }
  return field;
}

/**
 * One value under `_links`: a single href, or one per value when the
 * attribute holds several. A null href clears the attribute, which is the
 * only way to empty something whose value is a resource.
 */
type LinkValue =
  | { readonly href: string | null }
  | ReadonlyArray<{ readonly href: string }>;

const CUSTOM_OPTIONS_HREF = "/api/v3/custom_options/";

/**
 * One attribute whose payload id was built by resolving a NAME against
 * metadata. Only these can be repaired by the proof-carrying retry of
 * ADR-0002; caller-given ids never depend on cached knowledge.
 */
interface ResolvedAttribute {
  /** Payload location: a _links key such as "status", or the top-level
   * payload key of a custom field such as "customField10". */
  readonly attribute: string;
  /** The user-typed value, re-resolved verbatim after a refresh. */
  readonly raw: string;
  readonly idBefore: number;
  /** href prefix up to the id, e.g. "/api/v3/statuses/". */
  readonly hrefBase: string;
  readonly source: LookupSource<number>;
  /** True when the href lives under _links; false for a top-level
   * custom-field attribute. Decides where the retry patches the id. */
  readonly link: boolean;
}

/**
 * The clearing convention for a link attribute: an empty value sends the
 * link with a null href. Array links clear by sending an empty array
 * instead (see listFieldValues).
 */
function clearLink(links: Record<string, LinkValue>, attribute: string): void {
  links[attribute] = { href: null };
}

/** Flags whose empty value is refused: the attribute cannot be empty. */
const REQUIRED_VALUE_FLAGS: ReadonlyArray<"type" | "status" | "priority"> = [
  "type",
  "status",
  "priority",
];

/** Flags whose empty value clears the link on update. */
const CLEARABLE_LINK_FLAGS: ReadonlyArray<
  "assignee" | "accountable" | "category" | "sprint" | "bucket" | "parent"
> = [
  "assignee",
  "accountable",
  "category",
  "sprint",
  "bucket",
  "parent",
];

/**
 * A work package sits in a sprint or in a backlog bucket, never both, so
 * one command naming both is refused whatever the values (#46). Moving
 * between the two is one command per placement.
 */
function refuseTwoPlacements(options: Pick<CreateValueFlags, "sprint" | "bucket">): void {
  refuseCombined(
    [
      options.sprint === undefined ? undefined : "--sprint",
      options.bucket === undefined ? undefined : "--bucket",
    ],
    "a work package sits in a sprint or in a backlog bucket; pass one of the two.",
  );
}

/** The repeatable version flags; their empty value is `[""]`. */
const VERSION_FLAGS = [
  { option: "version", flag: "--version" },
  { option: "observedIn", flag: "--observed-in" },
] as const;

/**
 * Refuse empty values that cannot mean anything, before any request: a
 * required attribute never clears, and a create has nothing to clear.
 * On update the clearable link flags pass through; the resolvers turn
 * their empty value into a null href.
 */
function refuseEmptyValues(
  options: CreateValueFlags & { readonly subject?: string },
  mode: "create" | "update",
): void {
  if (mode === "update" && options.subject === "") {
    throw new OpCliError(
      "USAGE_ERROR",
      "--subject cannot be empty.",
      "a work package always has a subject; give the new text.",
    );
  }
  for (const flag of REQUIRED_VALUE_FLAGS) {
    if (options[flag] === "") {
      throw new OpCliError(
        "USAGE_ERROR",
        `--${flag} cannot be empty.`,
        `a work package always has a ${flag}; give a name or id.`,
      );
    }
  }
  for (const { option, flag } of VERSION_FLAGS) {
    const values = options[option];
    if (values === undefined || !values.includes("")) {
      continue;
    }
    if (mode === "create") {
      throw new OpCliError(
        "USAGE_ERROR",
        `${flag} cannot be empty on create.`,
        "there is nothing to clear on a new work package; leave the flag out.",
      );
    }
    if (values.length > 1) {
      throw new OpCliError(
        "USAGE_ERROR",
        `${flag} mixes a clearing "" with other values.`,
        `either pass ${flag} "" alone to clear, or give every occurrence a value.`,
      );
    }
  }
  validateScalars(options);
  if (mode === "create") {
    for (const option of SCALAR_OPTIONS) {
      if (options[option] === "") {
        throw new OpCliError(
          "USAGE_ERROR",
          `${scalarFlag(option)} cannot be empty on create.`,
          "there is nothing to clear on a new work package; leave the flag out.",
        );
      }
    }
    for (const flag of CLEARABLE_LINK_FLAGS) {
      if (options[flag] === "") {
        throw new OpCliError(
          "USAGE_ERROR",
          `--${flag} cannot be empty on create.`,
          "there is nothing to clear on a new work package; leave the flag out.",
        );
      }
    }
  }
}

/**
 * Resolve one link-valued option into the payload. An all-digits value is
 * an id and goes straight in; anything else is resolved here and
 * remembered so a rejection that blames this exact attribute can be
 * retried after one real refresh.
 */
async function resolveLinkOption(
  links: Record<string, LinkValue>,
  attribute: string,
  hrefBase: string,
  flag: string,
  raw: string | undefined,
  source: LookupSource<number>,
  refs: Array<ResolvedAttribute>,
): Promise<void> {
  if (raw === undefined) {
    return;
  }
  if (raw === "") {
    clearLink(links, attribute);
    return;
  }
  const id = await resolveOneLinkId(raw, attribute, hrefBase, source, refs);
  links[attribute] = { href: `${hrefBase}${String(id)}` };
}

/**
 * One link value to its id: an id-form value is the caller's own and goes
 * straight through; a name is resolved and remembered in `refs`, so a
 * rejection that blames this attribute can be retried with a fresh id
 * (ADR-0002). Every link-valued flag records its refs here and only here.
 */
async function resolveOneLinkId(
  raw: string,
  attribute: string,
  hrefBase: string,
  source: LookupSource<number>,
  refs: Array<ResolvedAttribute>,
): Promise<number> {
  if (isIdForm(raw)) {
    return Number(raw);
  }
  const id = Number(await resolveName(raw, source));
  refs.push({ attribute, raw, idBefore: id, hrefBase, source, link: true });
  return id;
}

/** Same contract as resolveLinkOption for members: names, ids, and me. */
async function resolveUserOption(
  runtime: WpRuntime,
  profile: ActiveProfile,
  links: Record<string, LinkValue>,
  attribute: string,
  hrefBase: string,
  flag: string,
  raw: string | undefined,
  refs: Array<ResolvedAttribute>,
  memo?: ResolutionMemo,
): Promise<void> {
  if (raw === undefined) {
    return;
  }
  if (raw === "") {
    clearLink(links, attribute);
    return;
  }
  let id: number;
  if (raw.toLowerCase() === "me") {
    id = memo === undefined
      ? (await authenticate(profile.instanceUrl, profile.apiKey)).id
      : await memo.me();
  } else {
    id = await resolveOneLinkId(
      raw,
      attribute,
      hrefBase,
      membersSource(runtime, profile, flag, memo),
      refs,
    );
  }
  links[attribute] = { href: `${hrefBase}${String(id)}` };
}

function booleanFieldValue(field: StoredCustomField, raw: string): boolean {
  const lowered = raw.toLowerCase();
  if (lowered !== "true" && lowered !== "false") {
    throw new OpCliError(
      "USAGE_ERROR",
      `--field "${field.name}=${raw}" is not true or false.`,
      'boolean fields accept only true and false.',
    );
  }
  return lowered === "true";
}

async function userFieldValue(
  runtime: WpRuntime,
  profile: ActiveProfile,
  field: StoredCustomField,
  raw: string,
  payload: Record<string, unknown>,
  refs: Array<ResolvedAttribute>,
  memo?: ResolutionMemo,
): Promise<void> {
  let id: number;
  if (raw.toLowerCase() === "me") {
    id = memo === undefined
      ? (await authenticate(profile.instanceUrl, profile.apiKey)).id
      : await memo.me();
  } else if (isIdForm(raw)) {
    id = Number(raw);
  } else {
    const source = membersSource(runtime, profile, field.name, memo);
    id = Number(await resolveName(raw, source));
    // A user-typed custom field holds its resolved href at the top level
    // of the payload rather than under _links; record it like any
    // name-resolved value so a rejection can be retried with fresh ids.
    refs.push({
      attribute: field.key,
      raw,
      idBefore: id,
      hrefBase: "/api/v3/users/",
      source,
      link: false,
    });
  }
  payload[field.key] = { href: `/api/v3/users/${String(id)}` };
}

/** The options of one list field, as a vocabulary names resolve against. */
function listFieldSource(
  runtime: WpRuntime,
  profile: ActiveProfile,
  field: StoredCustomField,
  memo?: ResolutionMemo,
): LookupSource<number> {
  return projectSource<number>(
    runtime,
    profile,
    "field",
    field.name,
    // Read the options back out of the vocabulary rather than off the
    // captured definition: after a refresh the store holds fresh ids, and
    // a field attached to several types repeats one option list.
    (vocabulary) =>
      Object.values(vocabulary.custom_fields)
        .flat()
        .filter((entry) => entry.key === field.key)
        .flatMap((entry) => entry.allowed_options ?? [])
        .map((option) => ({
          name: option.name,
          owner: field.name,
          value: option.id,
        })),
    memo,
  );
}

/**
 * A list field's value is a CustomOption resource: the payload carries its
 * href under _links, never the option's text, which the API accepts and
 * then ignores. Clearing empties the same place, because a value that
 * lives under _links has no top-level form to null out.
 */
async function listFieldValues(
  runtime: WpRuntime,
  profile: ActiveProfile,
  field: StoredCustomField,
  values: ReadonlyArray<string>,
  links: Record<string, LinkValue>,
  refs: Array<ResolvedAttribute>,
  memo?: ResolutionMemo,
): Promise<void> {
  if (values.length > 1 && field.is_multi !== true) {
    throw new OpCliError(
      "USAGE_ERROR",
      `--field "${field.name}" holds one value.`,
      "a single-valued list field takes one option name or id.",
    );
  }
  const source = listFieldSource(runtime, profile, field, memo);
  const hrefs: Array<{ href: string }> = [];
  for (const value of values) {
    const id = isIdForm(value)
      ? Number(value)
      : Number(await resolveName(value, source));
    if (!isIdForm(value)) {
      refs.push({
        attribute: field.key,
        raw: value,
        idBefore: id,
        hrefBase: CUSTOM_OPTIONS_HREF,
        source,
        link: true,
      });
    }
    const href = `${CUSTOM_OPTIONS_HREF}${String(id)}`;
    if (!hrefs.some((entry) => entry.href === href)) {
      hrefs.push({ href });
    }
  }
  links[field.key] = field.is_multi === true
    ? hrefs
    : hrefs[0] ?? { href: null };
}

const RETRYABLE_WRITE_STATUSES: ReadonlyArray<number> = [404, 422];

/** The attribute an OpenProject rejection blames, e.g. "status". */
function pointedAttribute(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  const embedded = record._embedded as Record<string, unknown> | undefined;
  const details = embedded?.details ?? record.details ?? record.attribute;
  const name = typeof details === "string"
    ? details
    : typeof details === "object" && details !== null
      ? (details as Record<string, unknown>).attribute
      : undefined;
  if (typeof name !== "string") {
    return undefined;
  }
  // Link rejections sometimes spell the target "links/status".
  return name.replace(/^links[./]/i, "");
}

/**
 * Catalogue mapping for a write that survived the proof-carrying retry:
 * 404 stays NOT_FOUND, 5xx becomes the unknown-state NETWORK_ERROR, and
 * everything else is the shared refusal mapping.
 */
function writeRejection(status: number, body: unknown, verb = "create"): OpCliError {
  if (status === 404) {
    return new OpCliError("NOT_FOUND");
  }
  // A 409 is the optimistic-locking catalogue entry: the caller either
  // already handled the retry rule or has nothing safe left to try.
  if (status === 409) {
    return new OpCliError("CONFLICT");
  }
  // A 5xx means the request may still have been applied server-side, so
  // the honest answer is "unknown state", never a retry that could
  // duplicate the work package.
  if (status >= 500) {
    const unknownState = verb === "create"
      ? "whether the work package was created is unknown."
      : "whether the change was applied is unknown.";
    const hint = verb === "create"
      ? "check whether the work package exists before repeating the command."
      : "run op-cli wp get to see the stored values before repeating the command.";
    return new OpCliError(
      "NETWORK_ERROR",
      `the ${verb} failed with HTTP ${status}; ${unknownState}`,
      hint,
    );
  }
  return writeRefusal(verb, status, body);
}

/**
 * A create request whose failure to complete leaves the state unknown:
 * timeouts and network errors are never retried on writes, and exit 6
 * says so instead of inviting a duplicate.
 */
async function postCreate(
  profile: ActiveProfile,
  payload: Record<string, unknown>,
): Promise<RawWriteResponse> {
  try {
    return await apiPostRaw(
      profile.instanceUrl,
      profile.apiKey,
      "/api/v3/work_packages",
      payload,
    );
  } catch (error) {
    if (error instanceof OpCliError && error.code === "NETWORK_ERROR") {
      throw new OpCliError(
        "NETWORK_ERROR",
        "the create request did not complete; whether the work package was created is unknown.",
        "check whether the work package exists before repeating the command.",
      );
    }
    throw error;
  }
}

/**
 * An update request whose failure to complete leaves the state unknown:
 * like create, timeouts and network errors are never retried on writes.
 */
async function patchWp(
  profile: ActiveProfile,
  id: string,
  payload: Record<string, unknown>,
): Promise<RawWriteResponse> {
  try {
    return await apiPatchRaw(
      profile.instanceUrl,
      profile.apiKey,
      `/api/v3/work_packages/${id}`,
      payload,
    );
  } catch (error) {
    if (error instanceof OpCliError && error.code === "NETWORK_ERROR") {
      throw new OpCliError(
        "NETWORK_ERROR",
        "the update request did not complete; whether the change was applied is unknown.",
        "run op-cli wp get to see the stored values before repeating the command.",
      );
    }
    throw error;
  }
}

/** The lockVersion a stored record carries; without it there is no safe update. */
function lockVersionOf(record: unknown): number {
  const value = typeof record === "object" && record !== null
    ? (record as Record<string, unknown>).lockVersion
    : undefined;
  if (typeof value !== "number") {
    throw new OpCliError(
      "API_ERROR",
      "the work package response carried no lockVersion.",
      "check the instance version with op-cli doctor.",
    );
  }
  return value;
}

/** JSON-level equality: scalars, arrays, and link hrefs compare by value. */
function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Fields this update writes that somebody else touched between the two
 * reads. Only fields in the patch matter: a colleague's edit elsewhere
 * is exactly the race the single retry exists to absorb, so it never
 * blocks. Link attributes compare by href, scalar and custom-field keys
 * by JSON value. A multi-valued link attribute holds one link per value,
 * so its hrefs compare element-wise.
 */
function conflictingFields(
  before: unknown,
  after: unknown,
  payload: Record<string, unknown>,
): Array<string> {
  const beforeRecord = before as Record<string, unknown>;
  const afterRecord = after as Record<string, unknown>;
  const conflicts: Array<string> = [];
  for (const key of Object.keys(payload)) {
    if (key === "_links" || key === "lockVersion") {
      continue;
    }
    if (!sameJson(beforeRecord[key], afterRecord[key])) {
      conflicts.push(key);
    }
  }
  const payloadLinks = payload._links as Record<string, { href?: string }> | undefined;
  if (payloadLinks !== undefined) {
    for (const key of Object.keys(payloadLinks)) {
      if (key === "project") {
        continue;
      }
      const beforeLinks = beforeRecord._links as Record<string, unknown> | undefined;
      const afterLinks = afterRecord._links as Record<string, unknown> | undefined;
      const hrefs = (link: unknown): unknown =>
        Array.isArray(link)
          ? link.map(hrefs)
          : typeof link === "object" && link !== null
            ? (link as Record<string, unknown>).href
            : link;
      if (!sameJson(hrefs(beforeLinks?.[key]), hrefs(afterLinks?.[key]))) {
        conflicts.push(key);
      }
    }
  }
  return conflicts;
}

function conflictError(fields: ReadonlyArray<string>): OpCliError {
  return new OpCliError(
    "CONFLICT",
    `the work package was modified while this update ran: ${fields.join(", ")}.`,
    "read the current values, merge them with your change, and repeat the command.",
    { conflicting_fields: [...fields] },
  );
}

/**
 * The ADR-0002 resolution retry: after a rejected write, retry once only
 * when all three conditions hold — the status is 404 or 422, OpenProject's
 * body points at an attribute we built from a resolved name, and
 * refreshing metadata really changed that id. Otherwise the original
 * response stands untouched: a refresh that changes nothing means the
 * retry would fail identically, so we keep the honest error and spend no
 * second request.
 */
async function retryWithFreshIds(
  runtime: WpRuntime,
  profile: ActiveProfile,
  response: RawWriteResponse,
  payload: Record<string, unknown>,
  refs: ReadonlyArray<ResolvedAttribute>,
  resend: () => Promise<RawWriteResponse>,
  memo?: ResolutionMemo,
): Promise<RawWriteResponse> {
  if (!RETRYABLE_WRITE_STATUSES.includes(response.status)) {
    return response;
  }
  const pointed = pointedAttribute(response.body);
  if (pointed === undefined) {
    return response;
  }
  const suspects = refs.filter((ref) => ref.attribute === pointed);
  if (suspects.length === 0) {
    return response;
  }
  await refreshStoredMetadata(runtime.env, profile);
  memo?.invalidate();
  const links = payload._links as Record<string, LinkValue>;
  let changedAny = false;
  for (const suspect of suspects) {
    // After the refresh the cache holds the fresh snapshot; a value that
    // no longer resolves uniquely cannot prove its id moved, so it keeps
    // the original error too.
    const match = matchByName(suspect.raw, await suspect.source.load());
    if (match.kind !== "unique") {
      continue;
    }
    const refreshed = Number(match.entry.value);
    if (refreshed === suspect.idBefore) {
      continue;
    }
    changedAny = true;
    const patched = { href: `${suspect.hrefBase}${String(refreshed)}` };
    if (!suspect.link) {
      payload[suspect.attribute] = patched;
      continue;
    }
    // A multi-valued attribute keeps its other values: only the element
    // built from this very name moves.
    const current = links[suspect.attribute];
    links[suspect.attribute] = Array.isArray(current)
      ? current.map((entry) =>
          entry.href === `${suspect.hrefBase}${String(suspect.idBefore)}`
            ? patched
            : entry)
      : patched;
  }
  if (!changedAny) {
    return response;
  }
  return resend();
}

async function searchParentByName(
  profile: ActiveProfile,
  raw: string,
): Promise<number> {
  const query = encodeURIComponent(
    JSON.stringify([{ subject: { operator: "=", values: [raw] } }]),
  );
  const collection = (await apiGet(
    profile.instanceUrl,
    profile.apiKey,
    `/api/v3/work_packages?filters=${query}&pageSize=100`,
  )) as WorkPackagePage;
  const hits: Array<{ readonly id: number; readonly subject: string }> = [];
  for (const element of collection._embedded?.elements ?? []) {
    const record = element as { readonly id?: unknown; readonly subject?: unknown };
    if (typeof record.id === "number" && typeof record.subject === "string") {
      hits.push({ id: record.id, subject: record.subject });
    }
  }
  if (hits.length === 0) {
    throw new OpCliError(
      "USAGE_ERROR",
      `no work package has the subject "${raw}".`,
      "--parent accepts a work package id or an exact subject.",
    );
  }
  const distinct = [...new Map(hits.map((hit) => [hit.id, hit])).values()];
  if (distinct.length > 1) {
    const listed = distinct.map((hit) => `${hit.id} (${hit.subject})`).join(", ");
    throw new OpCliError(
      "USAGE_ERROR",
      `parent "${raw}" is ambiguous. Candidates: ${listed}.`,
      "repeat the value as the explicit id of one candidate.",
    );
  }
  const only = distinct[0];
  if (only === undefined) {
    throw new OpCliError("INTERNAL_ERROR");
  }
  return only.id;
}

async function resolveParents(
  profile: ActiveProfile,
  raws: ReadonlyArray<string>,
): Promise<Array<string>> {
  const ids: Array<string> = [];
  for (const raw of raws) {
    if (ids.includes(raw)) {
      continue;
    }
    ids.push(isIdForm(raw) ? raw : String(await searchParentByName(profile, raw)));
  }
  return ids;
}

async function resolveListFlags(
  runtime: WpRuntime,
  profile: ActiveProfile,
  options: FilterFlagOptions,
): Promise<WpListFlags> {
  const flags: {
    project?: string;
    statuses?: Array<string>;
    types?: Array<string>;
    assignees?: Array<string>;
    accountables?: Array<string>;
    authors?: Array<string>;
    versions?: Array<string>;
    observedIn?: Array<string>;
    categories?: Array<string>;
    sprints?: Array<string>;
    buckets?: Array<string>;
    priorities?: Array<string>;
    parents?: Array<string>;
    updatedAfter?: string;
    createdAfter?: string;
    dueBefore?: string;
    dueAfter?: string;
    search?: string;
  } = {};
  // The project in context scopes the listing itself, not just the
  // vocabularies resolved below; without it every listing is
  // instance-wide (#19).
  if (profile.project !== undefined) {
    flags.project = String(profile.project);
  }
  const status = options.status ?? [];
  if (status.length > 0) {
    flags.statuses = await resolveValues(
      status,
      instanceSource(runtime, profile, "status", (metadata) =>
        metadata.statuses.map((entry) => ({
          name: entry.name,
          owner: "Status",
          value: entry.id,
        })),
      ),
    );
  }
  const type = options.type ?? [];
  if (type.length > 0) {
    flags.types = await resolveValues(
      type,
      instanceSource(runtime, profile, "type", (metadata) =>
        metadata.types.map((entry) => ({
          name: entry.name,
          owner: "Type",
          value: entry.id,
        })),
      ),
    );
  }
  const assignee = options.assignee ?? [];
  if (assignee.length > 0) {
    flags.assignees = await resolveUserValues(runtime, profile, "assignee", assignee);
  }
  const accountable = options.accountable ?? [];
  if (accountable.length > 0) {
    flags.accountables = await resolveUserValues(runtime, profile, "accountable", accountable);
  }
  const author = options.author ?? [];
  if (author.length > 0) {
    flags.authors = await resolveUserValues(runtime, profile, "author", author);
  }
  const version = options.version ?? [];
  if (version.length > 0) {
    flags.versions = await resolveValues(
      version,
      versionSource(runtime, profile, "version"),
    );
  }
  const observedIn = options.observedIn ?? [];
  if (observedIn.length > 0) {
    if (profile.project !== undefined) {
      // A filter spans the whole project: the field is there when any type has it.
      const byType = await versionFieldsByType(runtime, profile, undefined, undefined, undefined);
      if (!Object.values(byType).some((fields) => fields.observedInVersions !== undefined)) {
        throw new OpCliError(
          "USAGE_ERROR",
          "--observed-in is not available in this project.",
          "its work package schema has no observedInVersions field.",
        );
      }
    }
    flags.observedIn = await resolveValues(
      observedIn,
      versionSource(runtime, profile, "observed-in"),
    );
  }
  const category = options.category ?? [];
  if (category.length > 0) {
    flags.categories = await resolveValues(
      category,
      categorySource(runtime, profile),
    );
  }
  const sprint = options.sprint ?? [];
  if (sprint.length > 0) {
    flags.sprints = await resolveValues(sprint, backlogSource(runtime, profile, "sprint"));
  }
  const bucket = options.bucket ?? [];
  if (bucket.length > 0) {
    flags.buckets = await resolveValues(bucket, backlogSource(runtime, profile, "bucket"));
  }
  const priority = options.priority ?? [];
  if (priority.length > 0) {
    flags.priorities = await resolveValues(
      priority,
      instanceSource(runtime, profile, "priority", (metadata) =>
        metadata.priorities.map((entry) => ({
          name: entry.name,
          owner: "Priority",
          value: entry.id,
        })),
      ),
    );
  }
  const parent = options.parent ?? [];
  if (parent.length > 0) {
    flags.parents = await resolveParents(profile, parent);
  }
  if (options.updatedAfter !== undefined && options.updatedAfter !== "") {
    flags.updatedAfter = options.updatedAfter;
  }
  if (options.createdAfter !== undefined && options.createdAfter !== "") {
    flags.createdAfter = options.createdAfter;
  }
  if (options.dueBefore !== undefined && options.dueBefore !== "") {
    flags.dueBefore = options.dueBefore;
  }
  if (options.dueAfter !== undefined && options.dueAfter !== "") {
    flags.dueAfter = options.dueAfter;
  }
  if (options.search !== undefined && options.search !== "") {
    flags.search = options.search;
  }
  return {
    ...flags,
    open: options.open,
    closed: options.closed,
    overdue: options.overdue,
    backlogInbox: options.backlogInbox,
  };
}

function workPackagesPath(filters: ReadonlyArray<WpFilter>): string {
  return `/api/v3/work_packages?filters=${filtersQuery(filters)}`;
}

function renderWorkPackages(records: ReadonlyArray<Record<string, unknown>>): string {
  return renderTable(
    LIST_COLUMNS.map((column) => column.title),
    records.map((record) =>
      LIST_COLUMNS.map((column) => formatCell(record[column.field])),
    ),
  );
}

/** The id at the end of a link's href, such as a type or project link. */
function typeIdOf(link: LinkValue | undefined): number | undefined {
  if (link === undefined || Array.isArray(link)) {
    return undefined;
  }
  const href = (link as { readonly href: string | null }).href;
  const match = href === null ? null : /(\d+)$/.exec(href);
  return match === null ? undefined : Number(match[1]);
}

/**
 * The version fields of every type of one project, as the cached schema
 * shape has them. A vocabulary stored before these fields were captured, or
 * one that predates the type being asked about, is refreshed once for that
 * project alone, so the decision always comes from the schema (ADR-0002).
 * The project is the work package's own when given, else the profile's.
 */
async function versionFieldsByType(
  runtime: WpRuntime,
  profile: ActiveProfile,
  typeId: number | undefined,
  memo: ResolutionMemo | undefined,
  projectId: number | undefined,
): Promise<Readonly<Record<string, StoredVersionFields>>> {
  const own = projectId !== undefined && projectId !== profile.project;
  const load = (): Promise<ProjectVocabulary> =>
    own
      ? loadProjectVocabularyById(runtime.env, profile, projectId)
      : memo === undefined
        ? loadProjectVocabulary(runtime.env, profile)
        : memo.vocabulary();
  let vocabulary = await load();
  const known = (candidate: ProjectVocabulary): boolean =>
    candidate.version_fields !== undefined
    && (typeId === undefined || candidate.version_fields[String(typeId)] !== undefined);
  if (!known(vocabulary)) {
    await refreshProjectVocabulary(runtime.env, profile, vocabulary.project_id);
    memo?.invalidate();
    vocabulary = await load();
  }
  return vocabulary.version_fields ?? {};
}

/**
 * The version fields the schema of this project and type exposes. A type of
 * unknown identity (a create without --type, whose default type the server
 * picks) is decided only when every type of the project agrees; otherwise
 * guessing would send a field the real type refuses.
 */
async function versionFieldsFor(
  runtime: WpRuntime,
  profile: ActiveProfile,
  typeId: number | undefined,
  memo: ResolutionMemo | undefined,
  projectId: number | undefined,
  /** The fields the caller will write; only these must be agreed on. */
  needs: ReadonlyArray<"targetVersions" | "observedInVersions">,
): Promise<StoredVersionFields> {
  const byType = await versionFieldsByType(runtime, profile, typeId, memo, projectId);
  const own = typeId === undefined ? undefined : byType[String(typeId)];
  if (own !== undefined) {
    return own;
  }
  const fields = Object.values(byType);
  const agreed = (name: "targetVersions" | "observedInVersions"): StoredVersionFields => {
    const found = fields.map((entry) => entry[name]);
    const present = found.filter((entry): entry is StoredVersionField => entry !== undefined);
    if (present.length === 0) {
      return {};
    }
    const first = present[0];
    if (
      present.length < found.length
      || present.some((entry) => entry.multiple !== first?.multiple)
    ) {
      throw new OpCliError(
        "USAGE_ERROR",
        "the project's types disagree on its version fields, so --version and --observed-in cannot be judged without a type.",
        "pass --type <name-or-id> (or a type in the stdin item) so the schema of that type decides.",
      );
    }
    return { [name]: { multiple: present[0]?.multiple === true } };
  };
  return Object.assign({}, ...needs.map(agreed)) as StoredVersionFields;
}

function categorySource(
  runtime: WpRuntime,
  profile: ActiveProfile,
  memo?: ResolutionMemo,
): LookupSource<number> {
  return projectSource<number>(runtime, profile, "category", "category", (vocabulary) =>
    requireVocabulary(vocabulary, "categories").map((entry) => ({
      name: entry.name,
      owner: "Category",
      value: entry.id,
    })), memo);
}

function versionSource(
  runtime: WpRuntime,
  profile: ActiveProfile,
  flag: string,
  memo?: ResolutionMemo,
): LookupSource<number> {
  return projectSource<number>(runtime, profile, flag, "version", (vocabulary) =>
    requireVocabulary(vocabulary, "versions").map((entry) => ({
      name: entry.name,
      owner: "Version",
      value: entry.id,
    })), memo);
}

/**
 * Write one repeatable version flag into an array link: `[{href}]`, or
 * `[]` to clear.
 */
async function resolveVersionList(
  runtime: WpRuntime,
  profile: ActiveProfile,
  links: Record<string, LinkValue>,
  attribute: string,
  flag: string,
  values: ReadonlyArray<string>,
  refs: Array<ResolvedAttribute>,
  memo?: ResolutionMemo,
): Promise<void> {
  if (values.length === 1 && values[0] === "") {
    links[attribute] = [];
    return;
  }
  const source = versionSource(runtime, profile, flag.replace(/^--/, ""), memo);
  const hrefs: Array<{ href: string }> = [];
  for (const value of values) {
    const id = await resolveOneLinkId(value, attribute, "/api/v3/versions/", source, refs);
    const href = `/api/v3/versions/${String(id)}`;
    if (!hrefs.some((entry) => entry.href === href)) {
      hrefs.push({ href });
    }
  }
  links[attribute] = hrefs;
}

/**
 * --version and --observed-in. The schema decides where --version lands:
 * `targetVersions` when the type exposes it, the deprecated `version`
 * otherwise; the server refuses both in one request, so exactly one is
 * ever sent.
 */
async function resolveVersionLinks(
  runtime: WpRuntime,
  profile: ActiveProfile,
  links: Record<string, LinkValue>,
  options: CreateValueFlags,
  typeId: number | undefined,
  refs: Array<ResolvedAttribute>,
  memo?: ResolutionMemo,
  projectId?: number,
): Promise<void> {
  if (options.version === undefined && options.observedIn === undefined) {
    return;
  }
  const fields = await versionFieldsFor(runtime, profile, typeId, memo, projectId, [
    ...(options.version === undefined ? [] : ["targetVersions" as const]),
    ...(options.observedIn === undefined ? [] : ["observedInVersions" as const]),
  ]);
  if (options.version !== undefined) {
    const target = fields.targetVersions;
    if (target === undefined) {
      if (options.version.length > 1) {
        throw new OpCliError(
          "USAGE_ERROR",
          "--version holds one value on this work package.",
          "its schema has no targetVersions, only the single version field.",
        );
      }
      await resolveLinkOption(
        links,
        "version",
        "/api/v3/versions/",
        "--version",
        options.version[0],
        versionSource(runtime, profile, "version", memo),
        refs,
      );
    } else {
      if (!target.multiple && options.version.length > 1) {
        throw new OpCliError(
          "USAGE_ERROR",
          "--version holds one value for this work package.",
          "the schema's targetVersions takes a single version; pass --version once.",
        );
      }
      await resolveVersionList(
        runtime,
        profile,
        links,
        "targetVersions",
        "--version",
        options.version,
        refs,
        memo,
      );
    }
  }
  if (options.observedIn !== undefined) {
    const observed = fields.observedInVersions;
    if (observed === undefined) {
      throw new OpCliError(
        "USAGE_ERROR",
        "--observed-in is not available for this work package.",
        "its schema has no observedInVersions field; leave the flag out.",
      );
    }
    if (!observed.multiple && options.observedIn.length > 1) {
      throw new OpCliError(
        "USAGE_ERROR",
        "--observed-in holds one value for this work package.",
        "the schema's observedInVersions takes a single version; pass --observed-in once.",
      );
    }
    await resolveVersionList(
      runtime,
      profile,
      links,
      "observedInVersions",
      "--observed-in",
      options.observedIn,
      refs,
      memo,
    );
  }
}

/**
 * Everything create and update share: every value flag resolved by name
 * into payload entries, with the name-resolved ones remembered so a
 * rejection can be retried with fresh ids (the ADR-0002 refs).
 */
async function resolveNamedValues(
  runtime: WpRuntime,
  profile: ActiveProfile,
  options: CreateValueFlags,
  memo?: ResolutionMemo,
  /**
   * What an update's work package already has: its type, when --type does
   * not name one, and its project, whose schema decides the version fields.
   */
  existing: {
    readonly typeId?: number | undefined;
    readonly projectId?: number | undefined;
  } = {},
): Promise<{ payload: Record<string, unknown>; refs: Array<ResolvedAttribute> }> {
  const refs: Array<ResolvedAttribute> = [];
  const links: Record<string, LinkValue> = {};
  await resolveLinkOption(
    links,
    "type",
    "/api/v3/types/",
    "--type",
    options.type,
    instanceSource(runtime, profile, "type", (metadata) =>
      metadata.types.map((entry) => ({
        name: entry.name,
        owner: "Type",
        value: entry.id,
      })), memo),
    refs,
  );
  await resolveLinkOption(
    links,
    "status",
    "/api/v3/statuses/",
    "--status",
    options.status,
    instanceSource(runtime, profile, "status", (metadata) =>
      metadata.statuses.map((entry) => ({
        name: entry.name,
        owner: "Status",
        value: entry.id,
      })), memo),
    refs,
  );
  await resolveLinkOption(
    links,
    "priority",
    "/api/v3/priorities/",
    "--priority",
    options.priority,
    instanceSource(runtime, profile, "priority", (metadata) =>
      metadata.priorities.map((entry) => ({
        name: entry.name,
        owner: "Priority",
        value: entry.id,
      })), memo),
    refs,
  );
  await resolveUserOption(
    runtime,
    profile,
    links,
    "assignee",
    "/api/v3/users/",
    "assignee",
    options.assignee,
    refs,
    memo,
  );
  // Accountable is the API's `responsible` link.
  await resolveUserOption(
    runtime,
    profile,
    links,
    "responsible",
    "/api/v3/users/",
    "accountable",
    options.accountable,
    refs,
    memo,
  );
  await resolveVersionLinks(
    runtime,
    profile,
    links,
    options,
    typeIdOf(links.type) ?? existing.typeId,
    refs,
    memo,
    existing.projectId,
  );
  await resolveLinkOption(
    links,
    "category",
    "/api/v3/categories/",
    "--category",
    options.category,
    categorySource(runtime, profile, memo),
    refs,
  );
  await resolveLinkOption(
    links,
    "sprint",
    "/api/v3/sprints/",
    "--sprint",
    options.sprint,
    backlogSource(runtime, profile, "sprint", memo),
    refs,
  );
  await resolveLinkOption(
    links,
    "backlogBucket",
    "/api/v3/backlog_buckets/",
    "--bucket",
    options.bucket,
    backlogSource(runtime, profile, "bucket", memo),
    refs,
  );

  // The parent is a live lookup over work packages, not cached metadata,
  // so it never joins the ADR-0002 refs: an id given here is already the
  // caller's own, and a subject search re-runs against current state.
  if (options.parent === "") {
    clearLink(links, "parent");
  } else if (options.parent !== undefined) {
    const parentId = isIdForm(options.parent)
      ? options.parent
      : String(await searchParentByName(profile, options.parent));
    links.parent = { href: `/api/v3/work_packages/${parentId}` };
  }

  const payload: Record<string, unknown> = { _links: links };

  // Description is a Formattable on the wire: OpenProject drops a plain
  // string silently, so it always travels as its raw property (#22).
  if (options.description !== undefined) {
    payload.description = { raw: options.description };
  }
  applyScalars(payload, options);
  const groups = new Map<string, {
    field: StoredCustomField;
    pairs: Array<FieldPair>;
  }>();
  for (const pair of (options.field ?? []).map(splitFieldPair)) {
    const field = await resolveFieldDefinition(runtime, profile, pair.name, memo);
    const group = groups.get(field.key);
    if (group === undefined) {
      groups.set(field.key, { field, pairs: [pair] });
    } else {
      group.pairs.push(pair);
    }
  }
  for (const { field, pairs } of groups.values()) {
    const cleared = pairs.some((pair) => pair.value === "");
    if (cleared && pairs.length > 1) {
      throw new OpCliError(
        "USAGE_ERROR",
        `--field mixes cleared and set values for "${field.name}".`,
        'either clear with "Name=" or give every occurrence a value.',
      );
    }
    if (cleared) {
      if (field.is_list === true) {
        // Nothing to resolve, but the empty value still belongs where the
        // option would have gone.
        await listFieldValues(runtime, profile, field, [], links, refs, memo);
      } else if (field.is_formattable === true) {
        payload[field.key] = toFormattable("");
      } else {
        payload[field.key] = null;
      }
      continue;
    }
    if (field.is_list === true) {
      await listFieldValues(
        runtime,
        profile,
        field,
        pairs.map((pair) => pair.value),
        links,
        refs,
        memo,
      );
      continue;
    }
    if (field.is_boolean === true) {
      if (pairs.length > 1) {
        throw new OpCliError(
          "USAGE_ERROR",
          `--field "${field.name}" takes a single true or false.`,
          "boolean fields hold one value.",
        );
      }
      payload[field.key] = booleanFieldValue(field, pairs[0]?.value ?? "");
      continue;
    }
    if (field.is_user === true) {
      if (pairs.length > 1) {
        throw new OpCliError(
          "USAGE_ERROR",
          `--field "${field.name}" holds one user.`,
          "user fields take a single name, id, or me.",
        );
      }
      await userFieldValue(
        runtime,
        profile,
        field,
        pairs[0]?.value ?? "",
        payload,
        refs,
        memo,
      );
      continue;
    }
    if (field.is_formattable === true) {
      if (pairs.length > 1) {
        throw new OpCliError(
          "USAGE_ERROR",
          `--field "${field.name}" holds one value.`,
          "long-text fields take a single value.",
        );
      }
      payload[field.key] = toFormattable(pairs[0]?.value ?? "");
      continue;
    }
    const values = pairs.map((pair) => pair.value);

    payload[field.key] = values.length === 1 ? values[0] : values;
  }

  return { payload, refs };
}

// ---------------------------------------------------------------------------
// Activities, relations, schemas

// The activity's text is called `comment` by the API, by these columns,
// and by --fields on every command that renders one. It had two names
// before, so --fields refused the name the table itself was using.
export const COMMENT_COLUMNS = [
  { title: "ID", field: "id" },
  { title: "AUTHOR", field: "user" },
  { title: "COMMENT", field: "comment" },
  { title: "CREATED", field: "createdAt" },
] as const;

export const HISTORY_COLUMNS = [
  { title: "ID", field: "id" },
  { title: "KIND", field: "kind" },
  { title: "AUTHOR", field: "user" },
  { title: "COMMENT", field: "comment" },
  { title: "DETAILS", field: "details" },
  { title: "CREATED", field: "createdAt" },
] as const;

export const RELATION_COLUMNS = [
  { title: "ID", field: "id" },
  { title: "TYPE", field: "type" },
  { title: "FROM", field: "from" },
  { title: "TO", field: "to" },
  { title: "LAG", field: "lag" },
  { title: "DESCRIPTION", field: "description" },
] as const;

export const SCHEMA_COLUMNS = [
  { title: "FIELD", field: "field" },
  { title: "NAME", field: "name" },
  { title: "TYPE", field: "type" },
  { title: "REQUIRED", field: "required" },
  { title: "WRITABLE", field: "writable" },
] as const;

// Relations are named by type ("follows"), never by id.
const DEFAULT_RELATION_TYPE = "relates";

// The API speaks relation type names ("follows"), never ids.
const RELATION_TYPES: ReadonlyArray<string> = [
  "relates",
  "duplicates",
  "duplicated",
  "blocks",
  "blocked",
  "precedes",
  "follows",
  "includes",
  "partof",
  "requires",
  "required",
];

function normalizeRelationType(raw: string): string {
  const type = raw.trim().toLowerCase();
  if (!RELATION_TYPES.includes(type)) {
    throw new OpCliError(
      "USAGE_ERROR",
      `relation type "${raw}" is not valid.`,
      `valid types: ${RELATION_TYPES.join(", ")}.`,
    );
  }
  return type;
}

/** The relations endpoint filters by involvement, not by work package path. */
function involvedRelationsPath(id: string): string {
  return `/api/v3/relations?filters=${encodeURIComponent(JSON.stringify([
    { involved: { operator: "=", values: [Number(id)] } },
  ]))}`;
}

function linkIdOf(link: unknown): number | null {
  return isFlatLink(link) ? link.id : null;
}
/**
 * One flat row per activity; the raw _type becomes the KIND column and
 * survives flattening because flattenHalRecord drops _type from records.
 * The formattable `comment` collapses to its raw text so the one name
 * means one thing wherever an activity is rendered.
 *
 * `details` carries the audit half the comment never could: the changes
 * behind a system activity, one instance-spelled sentence per attribute
 * ("Status changed from New to In progress"). A comment activity changed
 * nothing, so its details render empty rather than absent.
 */
export function activityRow(element: unknown): Record<string, unknown> {
  const resource = element as { readonly _type?: unknown };
  const kind = typeof resource._type === "string"
    ? resource._type.replace(/^Activity::/, "")
    : "";
  const record = flattenHalRecord(element);
  const comment = record.comment as { raw?: unknown } | null | undefined;
  return {
    id: record.id,
    kind,
    user: record.user,
    comment: typeof comment?.raw === "string" ? comment.raw : "",
    details: activityDetails(record.details),
    createdAt: record.createdAt,
  };
}

/**
 * The changes of one activity as a single line: each detail arrives as the
 * instance already spells it, so joining the raw texts keeps the summary
 * honest in every locale instead of re-deriving it from values the API
 * does not hand back. Details without raw text contribute nothing.
 */
function activityDetails(details: unknown): string {
  if (!Array.isArray(details)) {
    return "";
  }
  return details
    .map((detail) => {
      const raw = (detail as { raw?: unknown } | null)?.raw;
      return typeof raw === "string" ? raw : "";
    })
    .filter((text) => text !== "")
    .join("; ");
}

/**
 * The key set of an activityRow output, so `wp comment` can refuse a bad
 * --fields before it writes. Taken FROM the row builder rather than
 * restated beside it: a declaration that drifts from the record it
 * describes is the bug this ticket is about.
 */
const ACTIVITY_ROW_SHAPE: Record<string, unknown> = activityRow({});

/**
 * One principal's name, or null when this instance will not give it. The
 * principals collection is the only one filterable by id, so a single
 * request answers for one author.
 *
 * A name is a nicety: an instance whose key cannot read principals must
 * still be able to list comments, so a refusal degrades to null. Network
 * and server failures are NOT swallowed; turning those into a bare id
 * would hide a broken instance behind a cosmetic fallback.
 */
async function principalName(
  getPage: (path: string) => Promise<unknown>,
  id: number,
): Promise<string | null> {
  const filters = encodeURIComponent(
    JSON.stringify([{ id: { operator: "=", values: [String(id)] } }]),
  );
  try {
    const page = (await getPage(`/api/v3/principals?filters=${filters}`)) as {
      _embedded?: { elements?: ReadonlyArray<{ name?: unknown }> };
    };
    const name = page._embedded?.elements?.[0]?.name;
    return typeof name === "string" ? name : null;
  } catch (error) {
    if (
      error instanceof OpCliError
      && (error.code === "AUTH_FAILED"
        || error.code === "PERMISSION_DENIED"
        || error.code === "NOT_FOUND")
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * Fills in the author name an activities collection leaves out: a real
 * instance links the user by href with no title, and this CLI exists to
 * show names rather than the ids the API speaks. Each id is looked up at
 * most once per run, and a row that already carries a name costs nothing.
 */
function authorResolver(
  getPage: (path: string) => Promise<unknown>,
): (row: Record<string, unknown>) => Promise<Record<string, unknown>> {
  const named = new Map<number, string | null>();
  return async (row) => {
    const user = row.user;
    if (!isFlatLink(user) || user.id === null || user.name !== null) {
      return row;
    }
    const id = user.id;
    if (!named.has(id)) {
      named.set(id, await principalName(getPage, id));
    }
    const name = named.get(id) ?? null;
    return name === null ? row : { ...row, user: { id, name } };
  };
}

/** Comments are the Comment-kind slice of the same activity stream. */
export function commentRow(element: unknown): Record<string, unknown> | undefined {
  const row = activityRow(element);
  return row.kind === "Comment" ? row : undefined;
}

/** Only the typed fields and both ends; the action links carry no data. */
export function relationRow(element: unknown): Record<string, unknown> {
  const record = flattenHalRecord(element);
  return {
    id: record.id,
    type: record.type,
    reverseType: record.reverseType,
    lag: record.lag,
    description: record.description,
    from: record.from,
    to: record.to,
  };
}

/** One row per available field of the project-and-type schema. */
export function schemaRows(schema: unknown): Array<Record<string, unknown>> {
  return Object.entries(schema as Record<string, unknown>)
    .filter(([key, value]) =>
      !key.startsWith("_")
      && typeof value === "object"
      && value !== null
      && !Array.isArray(value))
    .map(([field, definition]) => {
      const spec = definition as Record<string, unknown>;
      return {
        field,
        name: spec.name ?? "",
        type: spec.type ?? "",
        required: spec.required ?? false,
        writable: spec.writable ?? false,
      };
    });
}

/**
 * The exact key set of a relationRow output; `wp unrelate` validates
 * --fields against it before deleting anything.
 */
const RELATION_ROW_SHAPE: Record<string, unknown> = {
  id: 0,
  type: "",
  reverseType: "",
  lag: null,
  description: null,
  from: { id: 0, name: "" },
  to: { id: 0, name: "" },
};

export function registerWpCommands(wp: Command, runtime: WpRuntime): void {
  wp.description("Inspect and manage work packages");
  addFilterFlags(
    wp.command("list")
      .description("List work packages by name-resolved filters")
      .option("--json", PAGED_JSON_HELP)
      .option("--limit <n>", "maximum number of results to show")
      .option("--all", "fetch every page instead of one limited page"),
  ).action(async (options: FilterFlagOptions & { json?: boolean; limit?: string; all?: boolean }) => {
    runtime.setJsonMode(options.json === true);
    // Refuse impossible flag combinations before any traffic or resolution.
    buildWpFilters(rawListFlags(options), new Date());
    const profile = await runtime.resolve({
      profile: options.profile,
      project: parseProjectOverride(options.project),
    });
    const now = new Date();
    const limit = parsePageSize(options.limit);
    const filters = buildWpFilters(await resolveListFlags(runtime, profile, options), now);
    const getPage = (path: string): Promise<unknown> =>
      apiGet(profile.instanceUrl, profile.apiKey, path);
    // --all sizes pages by the instance's advertised maximum; --limit
    // only ever sizes the single non-all page.
    const startPath = withPageSize(
      workPackagesPath(filters),
      options.all === true ? await allPageSize(getPage) : limit,
    );

    if (options.all === true) {
      const rows: Array<Record<string, unknown>> = [];
      for await (const element of halElements<unknown>(getPage, startPath)) {
        const record = flattenHalRecord(element);
        if (options.json === true) {
          runtime.write(`${JSON.stringify(record)}\n`);
        } else {
          rows.push(record);
        }
      }
      if (options.json !== true) {
        runtime.write(renderWorkPackages(rows));
      }
      return;
    }

    const page = (await getPage(startPath)) as WorkPackagePage;
    const records = (page._embedded?.elements ?? []).map((element) =>
      flattenHalRecord(element),
    );
    if (options.json === true) {
      runtime.write(`${JSON.stringify(records)}\n`);
    } else {
      runtime.write(renderWorkPackages(records));
    }
    const total = typeof page.total === "number" ? page.total : records.length;
    if (total > records.length) {
      runtime.writeErr(
        `Showing ${records.length} of ${total} work packages. `
          + "Pass --all to fetch every result.\n",
      );
    }
  });

  addFilterFlags(wp.command("count").description("Count work packages matching the filters")).action(
    async (options: FilterFlagOptions) => {
      buildWpFilters(rawListFlags(options), new Date());
      const profile = await runtime.resolve({
        profile: options.profile,
        project: parseProjectOverride(options.project),
      });
      const filters = buildWpFilters(
        await resolveListFlags(runtime, profile, options),
        new Date(),
      );
      const body = (await apiGet(
        profile.instanceUrl,
        profile.apiKey,
        `${workPackagesPath(filters)}&pageSize=1`,
      )) as WorkPackagePage;
      if (typeof body.total !== "number") {
        throw new OpCliError(
          "API_ERROR",
          "the response carried no total.",
          "check the instance version with op-cli doctor.",
        );
      }
      runtime.write(`${String(body.total)}\n`);
    },
  );

  wp.command("get")
    .description("Show one work package")
    .argument("<id>")
    .option("--json", "emit a flat JSON record")
    .option("--fields <list>", "comma-separated columns to show")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <name-or-id>", "override the profile default project")
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
        requireWpId(reference);
        const profile = await runtime.resolve({
          profile: options.profile,
          project: parseProjectOverride(options.project),
        });
        const record = flattenHalRecord(
          await apiGet(
            profile.instanceUrl,
            profile.apiKey,
            `/api/v3/work_packages/${reference}`,
          ),
        );
        renderRecord(runtime, options, record);
      },
    );
  // The clearing convention is a promise about syntax, so it belongs in
  // this help text and not only in the skill.
  wp.command("create")
    .description("Create one work package, or many from a JSON array on stdin")
    .argument("[subject]", "subject of the one work package to create")
    .option(
      "--stdin",
      "read a JSON array of work packages and report one NDJSON line per item",
    )
    .option("--fail-fast", "with --stdin: stop the batch at the first failing item")
    .option(
      "--dry-run",
      "with --stdin: resolve and validate everything, create nothing",
    )
    .option("--type <name-or-id>", "work package type, by name or id")
    .option("--status <name-or-id>", "initial status, by name or id")
    .option("--priority <name-or-id>", "priority, by name or id")
    .option("--assignee <name-or-id>", "assignee, by name, id, or me")
    .option(
      "--accountable <name-or-id>",
      "Accountable (API field responsible), by name, id, or me",
    )
    .option(
      "--version <name-or-id>",
      "version of the project, by name or id; repeat when the schema allows several",
      collectOptional,
    )
    .option(
      "--observed-in <name-or-id>",
      "observed-in version, by name or id; repeat when the schema allows several",
      collectOptional,
    )
    .option("--category <name-or-id>", "category of the project, by name or id")
    .option("--sprint <name-or-id>", "sprint of the project, by name or id; not with --bucket")
    .option(
      "--bucket <name-or-id>",
      "backlog bucket of the project, by name or id; not with --sprint",
    )
    .option("--parent <id-or-subject>", "parent work package, by id or exact subject")
    .option("--description <text>", "markdown description of the work package")
    .option("--start <date>", "start date, YYYY-MM-DD")
    .option("--due <date>", "due date, YYYY-MM-DD")
    .option("--estimate <duration>", "estimated time such as 4h, 1h30m, or PT4H")
    .option("--remaining <duration>", "remaining work such as 2h, 1h30m, or PT2H")
    .option("--done <percent>", "percent complete, 0-100")
    .option("--story-points <n>", "story points, a whole number")
    .option(
      "--field <pair>",
      'set a custom field by human name as "Name=Value"; repeat the flag '
        + 'for several values; "Name=" clears the field',
      collectValue,
      [],
    )
    .option("--json", "emit a flat JSON record")
    .option("--fields <list>", "comma-separated columns to show")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <name-or-id>", "override the profile default project")
    .action(async (subject: string | undefined, options: CreateOptions) => {
      if (options.stdin === true) {
        await runBulkCreate(runtime, subject, options);
        return;
      }
      runtime.setJsonMode(options.json === true);
      // --dry-run and --fail-fast are declared on the shared command, so
      // without this guard a single-subject create would silently ignore
      // them and still write for real.
      if (options.dryRun === true || options.failFast === true) {
        throw new OpCliError(
          "USAGE_ERROR",
          "--dry-run and --fail-fast belong to wp create --stdin.",
          "pipe a JSON array with --stdin, or drop both flags to create one.",
        );
      }
      if (subject === undefined) {
        throw new OpCliError(
          "USAGE_ERROR",
          "wp create needs a subject or --stdin with an array of work packages.",
          "give <subject> to create one, or pipe a JSON array with --stdin.",
        );
      }
      refuseTwoPlacements(options);
      refuseEmptyValues(options, "create");
      const profile = await runtime.resolve({
        profile: options.profile,
        project: parseProjectOverride(options.project),
      });
      if (profile.project === undefined) {
        throw new OpCliError(
          "USAGE_ERROR",
          "wp create needs a project to create the work package in.",
          "pass --project <name-or-id> or set a default project on the profile.",
        );
      }
      const { payload, refs } = await prepareCreatePayload(
        runtime,
        profile,
        subject,
        options,
      );
      const body = await submitCreate(runtime, profile, payload, refs);
      const created = flattenHalRecord(body);
      renderRecord(
        runtime,
        options,
        created,
        `work package ${String(created.id)} was created`,
      );
    });

  wp.command("update")
    .description("Update one work package with every value given by name")
    .argument("<id>")
    .option("--subject <text>", "new subject")
    .option("--type <name-or-id>", "work package type, by name or id")
    .option("--status <name-or-id>", "status, by name or id")
    .option("--priority <name-or-id>", "priority, by name or id")
    .option("--assignee <name-or-id>", 'assignee, by name, id, or me; "" clears')
    .option(
      "--accountable <name-or-id>",
      'Accountable (API field responsible), by name, id, or me; "" clears',
    )
    .option(
      "--version <name-or-id>",
      'version of the project, by name or id; repeat when the schema allows several; "" clears',
      collectOptional,
    )
    .option(
      "--observed-in <name-or-id>",
      'observed-in version, by name or id; repeat when the schema allows several; "" clears',
      collectOptional,
    )
    .option("--category <name-or-id>", 'category of the project, by name or id; "" clears')
    .option(
      "--sprint <name-or-id>",
      'sprint of the project, by name or id; "" clears; not with --bucket',
    )
    .option(
      "--bucket <name-or-id>",
      'backlog bucket of the project, by name or id; "" clears; not with --sprint',
    )
    .option("--parent <id-or-subject>", 're-parent under this work package, by id or exact subject; "" clears')
    .option("--description <text>", "new markdown description of the work package")
    .option("--start <date>", 'start date, YYYY-MM-DD; "" clears')
    .option("--due <date>", 'due date, YYYY-MM-DD; "" clears')
    .option("--estimate <duration>", 'estimated time such as 4h, 1h30m, or PT4H; "" clears')
    .option("--remaining <duration>", 'remaining work such as 2h, 1h30m, or PT2H; "" clears')
    .option("--done <percent>", 'percent complete, 0-100; "" clears')
    .option("--story-points <n>", 'story points, a whole number; "" clears')
    .option(
      "--field <pair>",
      'set a custom field by human name as "Name=Value"; repeat the flag '
        + 'for several values; "Name=" clears the field',
      collectValue,
      [],
    )
    .option("--json", "emit a flat JSON record")
    .option("--fields <list>", "comma-separated columns to show")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <name-or-id>", "override the profile default project")
    .action(async (reference: string, options: UpdateOptions) => {
      runtime.setJsonMode(options.json === true);
      requireWpId(reference);
      // A flag counts when it carries a value; --field defaults to [].
      const touchesSomething = options.subject !== undefined
        || (Object.keys(VALUE_OPTIONS) as Array<keyof CreateValueFlags>).some((option) =>
          option === "field"
            ? (options.field?.length ?? 0) > 0
            : options[option] !== undefined);
      if (!touchesSomething) {
        throw new OpCliError(
          "USAGE_ERROR",
          "wp update needs at least one value to change.",
          "pass --subject, an attribute flag like --status or --due, or --field Name=Value.",
        );
      }
      refuseTwoPlacements(options);
      refuseEmptyValues(options, "update");
      const profile = await runtime.resolve({
        profile: options.profile,
        project: parseProjectOverride(options.project),
      });
      const path = `/api/v3/work_packages/${reference}`;
      // The optimistic-locking read: everything below compares against
      // this snapshot.
      const before = await apiGet(profile.instanceUrl, profile.apiKey, path);
      // The read already names every column, so a bad --fields name is
      // refused while the work package is still untouched.
      selectedFields(options.fields, flattenHalRecord(before));
      const beforeLinks = (before as { _links?: Record<string, LinkValue> })._links;
      const { payload, refs } = await resolveNamedValues(
        runtime,
        profile,
        options,
        undefined,
        {
          typeId: typeIdOf(beforeLinks?.type),
          projectId: typeIdOf(beforeLinks?.project),
        },
      );
      if (options.subject !== undefined) {
        payload.subject = options.subject;
      }
      payload.lockVersion = lockVersionOf(before);

      let response = await patchWp(profile, reference, payload);
      if (response.status >= 400) {
        if (response.status === 409) {
          // The second retry rule: re-read and compare against the
          // original read. Fields nobody touched mean the conflict was
          // a race; one retry with the fresh lockVersion is safe.
          // A field somebody touched means a blind retry would discard
          // their work, so stop and name it.
          const after = await apiGet(profile.instanceUrl, profile.apiKey, path);
          const conflicts = conflictingFields(before, after, payload);
          if (conflicts.length > 0) {
            throw conflictError(conflicts);
          }
          payload.lockVersion = lockVersionOf(after);
          response = await patchWp(profile, reference, payload);
        } else {
          response = await retryWithFreshIds(
            runtime,
            profile,
            response,
            payload,
            refs,
            () => patchWp(profile, reference, payload),
          );
        }
      }
      if (response.status >= 400) {
        throw writeRejection(response.status, response.body, "update");
      }
      const updated = flattenHalRecord(response.body);
      renderRecord(runtime, options, updated);
    });

  // -------------------------------------------------------------------------
  // wp move

  wp.command("move")
    .description("Move one work package to another project")
    .argument("<id>")
    .argument("<project>", "target project, by id, identifier, or name")
    .option("--json", "emit a flat JSON record")
    .option("--fields <list>", "comma-separated columns to show")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <name-or-id>", "override the profile default project")
    .action(async (
      reference: string,
      projectRef: string,
      options: { json?: boolean; fields?: string; profile?: string; project?: string },
    ) => {
      runtime.setJsonMode(options.json === true);
      requireWpId(reference);
      const profile = await openProfile(runtime, options);
      const target = await resolveProjectRef(
        (query) => apiGet(profile.instanceUrl, profile.apiKey, query),
        projectRef,
      );
      const path = `/api/v3/work_packages/${reference}`;
      // The optimistic-locking read: the payload below carries its
      // lockVersion, and the refusal path names the project it came from.
      const before = await apiGet(profile.instanceUrl, profile.apiKey, path);
      const flatBefore = flattenHalRecord(before);
      // A bad --fields name is refused while the work package is still
      // untouched.
      selectedFields(options.fields, flatBefore);
      const currentProjectId = isFlatLink(flatBefore.project)
        ? flatBefore.project.id
        : null;
      if (currentProjectId === target.id) {
        throw new OpCliError(
          "USAGE_ERROR",
          `work package ${reference} is already in project ${target.name} (${String(target.id)}).`,
          "pass a different project to move it to.",
        );
      }
      const payload: Record<string, unknown> = {
        lockVersion: lockVersionOf(before),
        _links: { project: { href: `/api/v3/projects/${String(target.id)}` } },
      };
      let response = await patchWp(profile, reference, payload);
      if (response.status === 409) {
        // Same race rule as wp update, but project-centric: the generic
        // checker skips `project` on purpose, so the comparison here is
        // explicit. A concurrent edit elsewhere is absorbed by one retry
        // with the fresh lockVersion; a concurrent move is never
        // overwritten, and a move that already landed exactly where this
        // one aimed is reported as done.
        const after = await apiGet(profile.instanceUrl, profile.apiKey, path);
        const flatAfter = flattenHalRecord(after);
        const afterProjectId = isFlatLink(flatAfter.project)
          ? flatAfter.project.id
          : null;
        if (afterProjectId === target.id) {
          renderRecord(runtime, options, flatAfter);
          return;
        }
        if (afterProjectId !== currentProjectId) {
          throw new OpCliError(
            "CONFLICT",
            `the work package was moved while this move ran: it is now in project ${String(afterProjectId)}.`,
            "read the current project, decide again, and repeat the move.",
            { moved_to: afterProjectId },
          );
        }
        payload.lockVersion = lockVersionOf(after);
        response = await patchWp(profile, reference, payload);
      }
      if (response.status >= 400) {
        // A move the instance refuses is usually a type the target
        // project does not offer; writeRejection quotes the instance's
        // own explanation.
        throw writeRejection(response.status, response.body, "move");
      }
      const moved = flattenHalRecord(response.body);
      renderRecord(runtime, options, moved);
    });

  // ---------------------------------------------------------------------------
  // wp delete

  /**
   * How many work packages the server would cascade-delete beside this
   * one: every descendant, children and deeper, matched by the ancestor
   * filter. Undefined when the instance will not say; a read that fails
   * must not block a confirmed deletion, and the DELETE below stays the
   * authority on what actually happened.
   */
  const countDescendants = async (
    profile: ActiveProfile,
    id: string,
  ): Promise<number | undefined> => {
    try {
      const page = (await apiGet(
        profile.instanceUrl,
        profile.apiKey,
        `${workPackagesPath([{ name: "ancestor", operator: "=", values: [id] }])}&pageSize=1`,
      )) as WorkPackagePage;
      return typeof page.total === "number" ? page.total : undefined;
    } catch {
      return undefined;
    }
  };

  wp.command("delete")
    .description("Delete one work package after explicit confirmation")
    .argument("<id>")
    .option("--yes", "confirm the deletion")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <name-or-id>", "override the profile default project")
    .action(async (reference: string, options: {
      yes?: boolean;
      profile?: string;
      project?: string;
    }) => {
      requireWpId(reference);
      const profile = await runtime.resolve({
        profile: options.profile,
        project: parseProjectOverride(options.project),
      });
      // Without --yes the only traffic is the descendant read: the
      // refusal names what the cascade would destroy, but no write ever
      // leaves without the flag, terminal or not.
      const descendants = await countDescendants(profile, reference);
      if (options.yes !== true) {
        throw new OpCliError(
          "USAGE_ERROR",
          `wp delete refuses to remove work package ${reference} without confirmation.`
            + (descendants !== undefined && descendants > 0
              ? ` Work package ${reference} has ${descendants} `
                + `${descendants === 1 ? "descendant" : "descendants"};`
                + " they are deleted with it."
              : ""),
          "repeat the command with --yes to confirm the deletion.",
        );
      }
      await apiDelete(
        profile.instanceUrl,
        profile.apiKey,
        `/api/v3/work_packages/${reference}`,
      );
      runtime.write(
        `Deleted work package ${reference}`
          + (descendants !== undefined && descendants > 0
            ? ` and its ${descendants} `
              + `${descendants === 1 ? "descendant" : "descendants"}`
            : "")
          + ".\n",
      );
    });

  // ---------------------------------------------------------------------------
  // Discussion, history, relations, schema

  const collectionRuntime: CollectionRuntime = {
    connect: async (options) => {
      const profile = await runtime.resolve({
        profile: typeof options.profile === "string" ? options.profile : undefined,
        project: typeof options.project === "string"
          ? parseProjectOverride(options.project)
          : undefined,
      });
      return (path) => apiGet(profile.instanceUrl, profile.apiKey, path);
    },
    write: runtime.write,
    writeErr: runtime.writeErr,
    setJsonMode: runtime.setJsonMode,
  };

  wp.addCommand(defineCollectionCommand(
    {
      name: "comments",
      description: "List comments of one work package (API v3 has no comment delete)",
      path: (id) => `/api/v3/work_packages/${id}/activities`,
      row: commentRow,
      columns: COMMENT_COLUMNS,
      resolve: authorResolver,
    },
    collectionRuntime,
  ));

  wp.addCommand(defineCollectionCommand(
    {
      name: "history",
      description: "Show the activity history of one work package",
      path: (id) => `/api/v3/work_packages/${id}/activities`,
      row: activityRow,
      columns: HISTORY_COLUMNS,
      resolve: authorResolver,
    },
    collectionRuntime,
  ));

  wp.addCommand(defineCollectionCommand(
    {
      name: "relations",
      description: "List the relations of one work package",
      path: involvedRelationsPath,
      row: relationRow,
      columns: RELATION_COLUMNS,
    },
    collectionRuntime,
  ));

  const recordOptions = {
    json: "--json",
    fields: "--fields <list>",
    profile: "--profile <name>",
    project: "--project <name-or-id>",
  };

  wp.command("comment")
    .description("Add a comment to one work package")
    .argument("<id>")
    .argument("<text>", "markdown body of the comment")
    .option(recordOptions.json, "emit a flat JSON record")
    .option(recordOptions.fields, "comma-separated columns to show")
    .option(recordOptions.profile, "use this profile for this command only")
    .option(recordOptions.project, "override the profile default project")
    .action(async (reference: string, text: string, options: {
      json?: boolean;
      fields?: string;
      profile?: string;
      project?: string;
    }) => {
      requireWpId(reference);
      // Writing: --fields misuse is refused before the comment exists, so
      // a caller who fixes the flag and retries cannot post it twice.
      selectedFields(options.fields, ACTIVITY_ROW_SHAPE);
      const profile = await openProfile(runtime, options);
      const created = activityRow(await apiPost(
        profile.instanceUrl,
        profile.apiKey,
        `/api/v3/work_packages/${reference}/activities`,
        { comment: { raw: text } },
      ));
      const named = await authorResolver(
        (path) => apiGet(profile.instanceUrl, profile.apiKey, path),
      )(created);
      renderRecord(runtime, options, named);
    });

  // A separate command rather than `wp comment --edit`: the target is an
  // activity id, not a work package id, so the `<id>` of `wp comment`
  // would mean two different things. The API has no activity delete, so
  // there is deliberately no `comment-delete`.
  wp.command("comment-edit")
    .description(
      "Edit an existing comment by activity id (see `wp comments`); API v3 has no comment delete",
    )
    .argument("<activity-id>", "id of the comment, as listed by `wp comments`")
    .argument("<text>", "new markdown body of the comment")
    .option(recordOptions.json, "emit a flat JSON record")
    .option(recordOptions.fields, "comma-separated columns to show")
    .option(recordOptions.profile, "use this profile for this command only")
    // An activity id is global, so the project never matters here; the flag
    // stays so a call copied from `wp comment` is not refused.
    .option(recordOptions.project, "accepted and ignored: activity ids are global")
    .action(async (activityId: string, text: string, options: {
      json?: boolean;
      fields?: string;
      profile?: string;
      project?: string;
    }) => {
      if (!isIdForm(activityId)) {
        throw new OpCliError(
          "USAGE_ERROR",
          `activity "${activityId}" is not an id.`,
          "comments are addressed by the numeric id `wp comments` lists.",
        );
      }
      if (text.trim() === "") {
        throw new OpCliError(
          "USAGE_ERROR",
          "the new comment text is empty.",
          "an edit cannot blank a comment; the API has no comment delete either.",
        );
      }
      // Writing: --fields misuse is refused before the comment changes.
      selectedFields(options.fields, ACTIVITY_ROW_SHAPE);
      const profile = await openProfile(runtime, options);
      const path = `/api/v3/activities/${activityId}`;
      const current = activityRow(
        await apiGet(profile.instanceUrl, profile.apiKey, path),
      );
      if (current.kind !== "Comment" || current.comment === "") {
        throw new OpCliError(
          "USAGE_ERROR",
          `activity ${activityId} is a change journal, not a comment.`,
          "only entries listed by `wp comments` can be edited.",
        );
      }
      let updated: Record<string, unknown>;
      try {
        updated = activityRow(await apiPatch(
          profile.instanceUrl,
          profile.apiKey,
          path,
          { comment: { raw: text } },
        ));
      } catch (error) {
        // A 401 stays AUTH_FAILED as http.ts raised it; only a 403 is
        // this key lacking the right to edit someone else's comment.
        if (error instanceof OpCliError && error.code === "PERMISSION_DENIED") {
          throw new OpCliError(
            "PERMISSION_DENIED",
            `this key may not edit comment ${activityId}.`,
            "only your own comments, or any comment with the \"Edit notes\" permission, can be edited.",
            error.details,
          );
        }
        throw error;
      }
      const named = await authorResolver(
        (lookup) => apiGet(profile.instanceUrl, profile.apiKey, lookup),
      )(updated);
      renderRecord(runtime, options, named);
    });

  wp.command("relate")
    .description("Relate one work package to another")
    .argument("<id>")
    .argument("<to>", "work package id this one relates to")
    .option("--type <name>", `relation type: ${RELATION_TYPES.join(", ")}`, DEFAULT_RELATION_TYPE)
    .option(recordOptions.json, "emit a flat JSON record")
    .option(recordOptions.fields, "comma-separated columns to show")
    .option(recordOptions.profile, "use this profile for this command only")
    .option(recordOptions.project, "override the profile default project")
    .action(async (reference: string, toReference: string, options: {
      type?: string;
      json?: boolean;
      fields?: string;
      profile?: string;
      project?: string;
    }) => {
      requireWpId(reference);
      requireWpId(toReference);
      const type = normalizeRelationType(options.type ?? DEFAULT_RELATION_TYPE);
      const profile = await openProfile(runtime, options);
      const created = flattenHalRecord(await apiPost(
        profile.instanceUrl,
        profile.apiKey,
        `/api/v3/work_packages/${reference}/relations`,
        { type, _links: { to: { href: `/api/v3/work_packages/${toReference}` } } },
      ));
      renderRecord(runtime, options, created);
    });

  wp.command("unrelate")
    .description("Remove every relation between two work packages")
    .argument("<id>")
    .argument("<other>", "work package id to unlink from")
    .option(recordOptions.json, "emit a flat JSON array")
    .option(recordOptions.fields, "comma-separated columns to show")
    .option(recordOptions.profile, "use this profile for this command only")
    .option(recordOptions.project, "override the profile default project")
    .action(async (reference: string, other: string, options: {
      json?: boolean;
      fields?: string;
      profile?: string;
      project?: string;
    }) => {
      requireWpId(reference);
      requireWpId(other);
      // Destructive: --fields misuse is refused before any traffic, so a
      // typo can never delete relations and then exit 1.
      selectedFields(options.fields, RELATION_ROW_SHAPE);
      const profile = await openProfile(runtime, options);
      const pair = [Number(reference), Number(other)];
      const removed: Array<Record<string, unknown>> = [];
      const getPage = (path: string): Promise<unknown> =>
        apiGet(profile.instanceUrl, profile.apiKey, path);
      for await (const element of halElements(
        getPage,
        withPageSize(involvedRelationsPath(reference), DEFAULT_PAGE_SIZE),
      )) {
        const relation = relationRow(element);
        const from = linkIdOf(relation.from);
        const to = linkIdOf(relation.to);
        if (
          (from === pair[0] && to === pair[1]) || (from === pair[1] && to === pair[0])
        ) {
          await apiDelete(
            profile.instanceUrl,
            profile.apiKey,
            `/api/v3/relations/${String(relation.id)}`,
          );
          removed.push(relation);
        }
      }
      if (removed.length === 0) {
        throw new OpCliError(
          "NOT_FOUND",
          `no relation links work package ${reference} with ${other}.`,
          "run wp relations <id> to see what is related.",
        );
      }
      if (options.json === true) {
        const picked = removed.map((relation) =>
          Object.fromEntries(
            selectedFields(options.fields, relation).map((field) => [
              field,
              relation[field],
            ]),
          ),
        );
        runtime.write(`${JSON.stringify(picked)}\n`);
        return;
      }
      for (const relation of removed) {
        renderRecord(runtime, options, relation);
      }
    });

  wp.command("schema")
    .description("Show the available fields of a work package's project and type")
    .argument("<id>")
    .option(recordOptions.json, "emit a flat JSON array")
    .option(recordOptions.fields, "comma-separated columns to show")
    .option(recordOptions.profile, "use this profile for this command only")
    .option(recordOptions.project, "override the profile default project")
    .action(async (reference: string, options: {
      json?: boolean;
      fields?: string;
      profile?: string;
      project?: string;
    }) => {
      requireWpId(reference);
      const profile = await openProfile(runtime, options);
      const workPackage = flattenHalRecord(await apiGet(
        profile.instanceUrl,
        profile.apiKey,
        `/api/v3/work_packages/${reference}`,
      ));
      const projectId = linkIdOf(workPackage.project);
      const typeId = linkIdOf(workPackage.type);
      if (projectId === null || typeId === null) {
        throw new OpCliError(
          "API_ERROR",
          "the work package carried no project or type to resolve its schema.",
          "check the work package with wp get.",
        );
      }
      const schema = await apiGet(
        profile.instanceUrl,
        profile.apiKey,
        `/api/v3/work_packages/schemas/${String(projectId)}-${String(typeId)}`,
      );
      emitRows(
        { write: runtime.write, writeErr: runtime.writeErr },
        SCHEMA_COLUMNS,
        schemaRows(schema),
        options,
      );
    });
}
