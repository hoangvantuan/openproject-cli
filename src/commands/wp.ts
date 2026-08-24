import type { Command } from "commander";

import { OpCliError } from "../core/errors.js";
import {
  buildWpFilters,
  filtersQuery,
  type WpFilter,
  type WpListFlags,
} from "../core/filters.js";
import { defineCollectionCommand, emitRows, type CollectionRuntime } from "../core/define.js";
import { flattenHalRecord, isFlatLink } from "../core/hal.js";
import {
  apiDelete,
  apiGet,
  apiPost,
  apiPatchRaw,
  apiPostRaw,
  authenticate,
  type RawWriteResponse,
} from "../core/http.js";
import {
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
  parseOptionalId,
  type ActiveProfile,
  type ContextOverrides,
} from "../context/profile.js";
import {
  loadProjectVocabulary,
  loadStoredMetadata,
  refreshStoredMetadata,
  type ProjectVocabulary,
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
  "category",
  "startDate",
  "dueDate",
  "createdAt",
  "updatedAt",
  "lockVersion",
] as const;

// The list table is fixed: these are the columns an agent scans first.
const LIST_COLUMNS: ReadonlyArray<{ readonly title: string; readonly field: string }> = [
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
): void {
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
    project: parseOptionalId(options.project),
  });
}

function collectValue(value: string, previous: Array<string>): Array<string> {
  return [...previous, value];
}

interface FilterFlagOptions {
  readonly status?: Array<string>;
  readonly type?: Array<string>;
  readonly assignee?: Array<string>;
  readonly author?: Array<string>;
  readonly version?: Array<string>;
  readonly category?: Array<string>;
  readonly priority?: Array<string>;
  readonly parent?: Array<string>;
  readonly updatedAfter?: string;
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
    .option("--author <name>", "user name, id, or me; repeat to OR values", collectValue, [])
    .option("--version <name>", "version name or id; repeat to OR values", collectValue, [])
    .option("--category <name>", "category name or id; repeat to OR values", collectValue, [])
    .option("--priority <name>", "priority name or id; repeat to OR values", collectValue, [])
    .option("--parent <reference>", "parent work package id or exact subject", collectValue, [])
    .option(
      "--updated-after <value>",
      "today, yesterday, days back such as 7d, or YYYY-MM-DD",
    )
    .option("--open", "shorthand for every open status")
    .option("--closed", "shorthand for every closed status")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <id>", "override the profile default project");
}

function rawListFlags(options: FilterFlagOptions): WpListFlags {
  return {
    statuses: options.status,
    types: options.type,
    assignees: options.assignee,
    authors: options.author,
    versions: options.version,
    categories: options.category,
    priorities: options.priority,
    parents: options.parent,
    updatedAfter: options.updatedAfter,
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
          "pass --project <id> or set a default project on the profile.",
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


/** The value flags shared verbatim by one create and every stdin item. */
interface CreateValueFlags {
  readonly type?: string;
  readonly status?: string;
  readonly priority?: string;
  readonly assignee?: string;
  readonly version?: string;
  readonly category?: string;
  readonly parent?: string;
  readonly description?: string;
  readonly field?: Array<string>;
}

interface CreateOptions extends CreateValueFlags {
  readonly stdin?: boolean;
  readonly dryRun?: boolean;
  readonly failFast?: boolean;
  readonly json?: boolean;
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
  const links = payload._links as Record<string, { href: string }>;
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

/** Keys one stdin item may carry; everything else is a loud usage error. */
const BULK_ITEM_KEYS: ReadonlyArray<string> = [
  "subject",
  "type",
  "status",
  "priority",
  "assignee",
  "version",
  "category",
  "parent",
  "description",
  "field",
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
  const record = raw as Record<string, unknown>;
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
  const values: {
    type?: string;
    status?: string;
    priority?: string;
    assignee?: string;
    version?: string;
    category?: string;
    parent?: string;
    description?: string;
    field?: Array<string>;
  } = {};
  const scalarKeys: ReadonlyArray<Exclude<keyof CreateValueFlags, "field">> = [
    "type",
    "status",
    "priority",
    "assignee",
    "version",
    "category",
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
    project: parseOptionalId(options.project),
  });
  if (profile.project === undefined) {
    throw new OpCliError(
      "USAGE_ERROR",
      "wp create needs a project to create the work package in.",
      "pass --project <id> or set a default project on the profile.",
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

interface UpdateOptions {
  readonly subject?: string;
  readonly type?: string;
  readonly status?: string;
  readonly priority?: string;
  readonly assignee?: string;
  readonly version?: string;
  readonly category?: string;
  readonly parent?: string;
  readonly description?: string;
  readonly field?: Array<string>;
  readonly json?: boolean;
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
      "pass --project <id> or set a default project on the profile.",
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
 * Resolve one link-valued option into the payload. An all-digits value is
 * an id and goes straight in; anything else is resolved here and
 * remembered so a rejection that blames this exact attribute can be
 * retried after one real refresh.
 */
async function resolveLinkOption(
  links: Record<string, { href: string }>,
  attribute: string,
  hrefBase: string,
  flag: string,
  raw: string | undefined,
  source: LookupSource<number>,
  refs: Array<ResolvedAttribute>,
): Promise<void> {
  if (raw === undefined || raw === "") {
    return;
  }
  let id: number;
  if (isIdForm(raw)) {
    id = Number(raw);
  } else {
    id = Number(await resolveName(raw, source));
    refs.push({ attribute, raw, idBefore: id, hrefBase, source, link: true });
  }
  links[attribute] = { href: `${hrefBase}${String(id)}` };
}

/** Same contract as resolveLinkOption for members: names, ids, and me. */
async function resolveUserOption(
  runtime: WpRuntime,
  profile: ActiveProfile,
  links: Record<string, { href: string }>,
  attribute: string,
  hrefBase: string,
  flag: string,
  raw: string | undefined,
  refs: Array<ResolvedAttribute>,
  memo?: ResolutionMemo,
): Promise<void> {
  if (raw === undefined || raw === "") {
    return;
  }
  let id: number;
  if (raw.toLowerCase() === "me") {
    id = memo === undefined
      ? (await authenticate(profile.instanceUrl, profile.apiKey)).id
      : await memo.me();
  } else if (isIdForm(raw)) {
    id = Number(raw);
  } else {
    const source = membersSource(runtime, profile, flag, memo);
    id = Number(await resolveName(raw, source));
    refs.push({ attribute, raw, idBefore: id, hrefBase, source, link: true });
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
 * everything else is API_ERROR carrying the server's own message when it
 * has one.
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
  const detail = typeof body === "object" && body !== null
    && typeof (body as Record<string, unknown>).message === "string"
    ? (body as Record<string, unknown>).message as string
    : undefined;
  return new OpCliError(
    "API_ERROR",
    detail === undefined ? undefined : `OpenProject rejected the ${verb}: ${detail}`,
  );
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
 * by JSON value.
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
      const href = (link: unknown): unknown =>
        typeof link === "object" && link !== null
          ? (link as Record<string, unknown>).href
          : link;
      if (!sameJson(href(beforeLinks?.[key]), href(afterLinks?.[key]))) {
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
  const links = payload._links as Record<string, { href: string }>;
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
    if (suspect.link) {
      links[suspect.attribute] = { href: `${suspect.hrefBase}${String(refreshed)}` };
    } else {
      payload[suspect.attribute] = { href: `${suspect.hrefBase}${String(refreshed)}` };
    }
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
    statuses?: Array<string>;
    types?: Array<string>;
    assignees?: Array<string>;
    authors?: Array<string>;
    versions?: Array<string>;
    categories?: Array<string>;
    priorities?: Array<string>;
    parents?: Array<string>;
    updatedAfter?: string;
  } = {};
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
  const author = options.author ?? [];
  if (author.length > 0) {
    flags.authors = await resolveUserValues(runtime, profile, "author", author);
  }
  const version = options.version ?? [];
  if (version.length > 0) {
    flags.versions = await resolveValues(
      version,
      projectSource<number>(runtime, profile, "version", "version", (vocabulary) =>
        vocabulary.versions.map((entry) => ({
          name: entry.name,
          owner: "Version",
          value: entry.id,
        })),
      ),
    );
  }
  const category = options.category ?? [];
  if (category.length > 0) {
    flags.categories = await resolveValues(
      category,
      projectSource<number>(runtime, profile, "category", "category", (vocabulary) =>
        vocabulary.categories.map((entry) => ({
          name: entry.name,
          owner: "Category",
          value: entry.id,
        })),
      ),
    );
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
  return { ...flags, open: options.open, closed: options.closed };
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
): Promise<{ payload: Record<string, unknown>; refs: Array<ResolvedAttribute> }> {
  const refs: Array<ResolvedAttribute> = [];
  const links: Record<string, { href: string }> = {};
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
  await resolveLinkOption(
    links,
    "version",
    "/api/v3/versions/",
    "--version",
    options.version,
    projectSource<number>(runtime, profile, "version", "version", (vocabulary) =>
      vocabulary.versions.map((entry) => ({
        name: entry.name,
        owner: "Version",
        value: entry.id,
      })), memo),
    refs,
  );
  await resolveLinkOption(
    links,
    "category",
    "/api/v3/categories/",
    "--category",
    options.category,
    projectSource<number>(runtime, profile, "category", "category", (vocabulary) =>
      vocabulary.categories.map((entry) => ({
        name: entry.name,
        owner: "Category",
        value: entry.id,
      })), memo),
    refs,
  );

  // The parent is a live lookup over work packages, not cached metadata,
  // so it never joins the ADR-0002 refs: an id given here is already the
  // caller's own, and a subject search re-runs against current state.
  if (options.parent !== undefined) {
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
      payload[field.key] = null;
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
    const values = pairs.map((pair) => pair.value);

    payload[field.key] = values.length === 1 ? values[0] : values;
  }

  return { payload, refs };
}

// ---------------------------------------------------------------------------
// Activities, relations, schemas

const COMMENT_COLUMNS = [
  { title: "ID", field: "id" },
  { title: "AUTHOR", field: "user" },
  { title: "COMMENT", field: "note" },
  { title: "CREATED", field: "createdAt" },
] as const;

const HISTORY_COLUMNS = [
  { title: "ID", field: "id" },
  { title: "KIND", field: "kind" },
  { title: "AUTHOR", field: "user" },
  { title: "NOTE", field: "note" },
  { title: "CREATED", field: "createdAt" },
] as const;

const RELATION_COLUMNS = [
  { title: "ID", field: "id" },
  { title: "TYPE", field: "type" },
  { title: "FROM", field: "from" },
  { title: "TO", field: "to" },
  { title: "LAG", field: "lag" },
  { title: "DESCRIPTION", field: "description" },
] as const;

const SCHEMA_COLUMNS = [
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
 */
function activityRow(element: unknown): Record<string, unknown> | undefined {
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
    note: typeof comment?.raw === "string" ? comment.raw : "",
    createdAt: record.createdAt,
  };
}

/** Comments are the Comment-kind slice of the same activity stream. */
function commentRow(element: unknown): Record<string, unknown> | undefined {
  const row = activityRow(element);
  return row?.kind === "Comment" ? row : undefined;
}

/** Only the typed fields and both ends; the action links carry no data. */
function relationRow(element: unknown): Record<string, unknown> {
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
function schemaRows(schema: unknown): Array<Record<string, unknown>> {
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
      .option("--json", "emit a flat JSON array")
      .option("--limit <n>", "maximum number of results to show")
      .option("--all", "fetch every page instead of one limited page"),
  ).action(async (options: FilterFlagOptions & { json?: boolean; limit?: string; all?: boolean }) => {
    runtime.setJsonMode(options.json === true);
    // Refuse impossible flag combinations before any traffic or resolution.
    buildWpFilters(rawListFlags(options), new Date());
    const profile = await runtime.resolve({
      profile: options.profile,
      project: parseOptionalId(options.project),
    });
    const now = new Date();
    const limit = parsePageSize(options.limit);
    const filters = buildWpFilters(await resolveListFlags(runtime, profile, options), now);
    const startPath = withPageSize(workPackagesPath(filters), limit);
    const getPage = (path: string): Promise<unknown> =>
      apiGet(profile.instanceUrl, profile.apiKey, path);

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
        project: parseOptionalId(options.project),
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
        requireWpId(reference);
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
    .option("--version <name-or-id>", "version of the project, by name or id")
    .option("--category <name-or-id>", "category of the project, by name or id")
    .option("--parent <id-or-subject>", "parent work package, by id or exact subject")
    .option("--description <text>", "markdown description of the work package")
    .option(
      "--field <pair>",
      'set a custom field by human name as "Name=Value"; repeat the flag '
        + 'for several values; "Name=" clears the field',
      collectValue,
      [],
    )
    .option("--json", "emit a flat JSON record")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <id>", "override the profile default project")
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
      const profile = await runtime.resolve({
        profile: options.profile,
        project: parseOptionalId(options.project),
      });
      if (profile.project === undefined) {
        throw new OpCliError(
          "USAGE_ERROR",
          "wp create needs a project to create the work package in.",
          "pass --project <id> or set a default project on the profile.",
        );
      }
      const { payload, refs } = await prepareCreatePayload(
        runtime,
        profile,
        subject,
        options,
      );
      const body = await submitCreate(runtime, profile, payload, refs);
      renderRecord(runtime, options, flattenHalRecord(body));
    });

  wp.command("update")
    .description("Update one work package with every value given by name")
    .argument("<id>")
    .option("--subject <text>", "new subject")
    .option("--type <name-or-id>", "work package type, by name or id")
    .option("--status <name-or-id>", "status, by name or id")
    .option("--priority <name-or-id>", "priority, by name or id")
    .option("--assignee <name-or-id>", "assignee, by name, id, or me")
    .option("--version <name-or-id>", "version of the project, by name or id")
    .option("--category <name-or-id>", "category of the project, by name or id")
    .option("--parent <id-or-subject>", "re-parent under this work package, by id or exact subject")
    .option("--description <text>", "new markdown description of the work package")
    .option(
      "--field <pair>",
      'set a custom field by human name as "Name=Value"; repeat the flag '
        + 'for several values; "Name=" clears the field',
      collectValue,
      [],
    )
    .option("--json", "emit a flat JSON record")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <id>", "override the profile default project")
    .action(async (reference: string, options: UpdateOptions) => {
      runtime.setJsonMode(options.json === true);
      requireWpId(reference);
      const touchesSomething = options.subject !== undefined
        || options.type !== undefined
        || options.status !== undefined
        || options.priority !== undefined
        || options.parent !== undefined
        || options.assignee !== undefined
        || options.version !== undefined
        || options.category !== undefined
        || options.description !== undefined
        || (options.field?.length ?? 0) > 0;
      if (!touchesSomething) {
        throw new OpCliError(
          "USAGE_ERROR",
          "wp update needs at least one value to change.",
          "pass --subject, an attribute flag like --status, or --field Name=Value.",
        );
      }
      const profile = await runtime.resolve({
        profile: options.profile,
        project: parseOptionalId(options.project),
      });
      const path = `/api/v3/work_packages/${reference}`;
      // The optimistic-locking read: everything below compares against
      // this snapshot.
      const before = await apiGet(profile.instanceUrl, profile.apiKey, path);
      const { payload, refs } = await resolveNamedValues(runtime, profile, options);
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

  // ---------------------------------------------------------------------------
  // wp delete

  wp.command("delete")
    .description("Delete one work package after explicit confirmation")
    .argument("<id>")
    .option("--yes", "confirm the deletion")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <id>", "override the profile default project")
    .action(async (reference: string, options: {
      yes?: boolean;
      profile?: string;
      project?: string;
    }) => {
      // The guard fires before any resolution or traffic: without --yes
      // nothing is read, nothing is sent, with or without a terminal.
      if (options.yes !== true) {
        throw new OpCliError(
          "USAGE_ERROR",
          `wp delete refuses to remove work package ${reference} without confirmation.`,
          "repeat the command with --yes to confirm the deletion.",
        );
      }
      requireWpId(reference);
      const profile = await runtime.resolve({
        profile: options.profile,
        project: parseOptionalId(options.project),
      });
      await apiDelete(
        profile.instanceUrl,
        profile.apiKey,
        `/api/v3/work_packages/${reference}`,
      );
      runtime.write(`Deleted work package ${reference}.\n`);
    });

  // ---------------------------------------------------------------------------
  // Discussion, history, relations, schema

  const collectionRuntime: CollectionRuntime = {
    connect: async (options) => {
      const profile = await runtime.resolve({
        profile: typeof options.profile === "string" ? options.profile : undefined,
        project: typeof options.project === "string"
          ? parseOptionalId(options.project)
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
      description: "List comments of one work package",
      path: (id) => `/api/v3/work_packages/${id}/activities`,
      row: commentRow,
      columns: COMMENT_COLUMNS,
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
    project: "--project <id>",
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
      const profile = await openProfile(runtime, options);
      const created = flattenHalRecord(await apiPost(
        profile.instanceUrl,
        profile.apiKey,
        `/api/v3/work_packages/${reference}/activities`,
        { comment: { raw: text } },
      ));
      renderRecord(runtime, options, created);
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
