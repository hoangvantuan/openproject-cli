import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { apiGet } from "../core/http.js";
import { halElements } from "../core/paginate.js";
import { OpCliError } from "../core/errors.js";

import { ENV_PROFILE_NAME, type ActiveProfile } from "./profile.js";
import type { RunEnvironment } from "../run.js";

export interface StoredType {
  readonly id: number;
  readonly name: string;
  readonly is_milestone: boolean;
}

export interface StoredStatus {
  readonly id: number;
  readonly name: string;
  readonly is_closed: boolean;
  readonly is_default: boolean;
}

export interface StoredPriority {
  readonly id: number;
  readonly name: string;
  readonly is_default: boolean;
}

export interface StoredProjectRef {
  readonly id: number;
  readonly identifier: string;
  readonly name: string;
}

export interface StoredInstanceInfo {
  readonly url: string;
  readonly api_version: string | null;
  readonly core_version: string | null;
  readonly fetched_at: string;
}

export interface StoredMetadata {
  readonly types: ReadonlyArray<StoredType>;
  readonly statuses: ReadonlyArray<StoredStatus>;
  readonly priorities: ReadonlyArray<StoredPriority>;
  readonly instance: StoredInstanceInfo;
  readonly project?: StoredProjectRef;
  /**
   * Project-scoped sections (members, versions, categories, fields,
   * activities) are filled in by issue #5; lookups render what is here.
   */
  readonly projectScoped?: Readonly<Record<string, ReadonlyArray<LookupRow>>>;
}

export interface LookupRow {
  readonly id: number;
  readonly name: string;
}

export type MetadataSection =
  | "types"
  | "statuses"
  | "priorities"
  | "project"
  | "instance";

export interface MetadataChange {
  readonly section: MetadataSection;
  readonly kind: "added" | "removed" | "changed";
  readonly id: number | null;
  readonly detail: string;
}

interface HalElement {
  readonly [key: string]: unknown;
}

function cacheRoot(env: RunEnvironment): string {
  const root =
    env.OP_CLI_CACHE_DIR ??
    (env.HOME !== undefined ? join(env.HOME, ".cache", "op-cli") : undefined);
  if (root === undefined) {
    throw new OpCliError("INTERNAL_ERROR");
  }
  return root;
}

export function metadataPath(env: RunEnvironment, profile: ActiveProfile): string {
  const key =
    profile.name === ENV_PROFILE_NAME
      ? `env-${createHash("sha1").update(profile.instanceUrl).digest("hex")}`
      : profile.name;
  return join(cacheRoot(env), key, "metadata.json");
}

export async function readStoredMetadata(
  env: RunEnvironment,
  profile: ActiveProfile,
): Promise<StoredMetadata | undefined> {
  try {
    return JSON.parse(
      await readFile(metadataPath(env, profile), "utf8"),
    ) as StoredMetadata;
  } catch {
    return undefined;
  }
}

async function persistMetadata(
  env: RunEnvironment,
  profile: ActiveProfile,
  metadata: StoredMetadata,
): Promise<void> {
  const path = metadataPath(env, profile);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function sortByName<T extends { readonly name: string }>(
  entries: ReadonlyArray<T>,
): Array<T> {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

function toStoredType(element: HalElement): StoredType {
  return {
    id: Number(element.id),
    name: asString(element.name),
    is_milestone: asBoolean(element.isMilestone),
  };
}

function toStoredStatus(element: HalElement): StoredStatus {
  return {
    id: Number(element.id),
    name: asString(element.name),
    is_closed: asBoolean(element.isClosed),
    is_default: asBoolean(element.isDefault),
  };
}

function toStoredPriority(element: HalElement): StoredPriority {
  return {
    id: Number(element.id),
    name: asString(element.name),
    is_default: asBoolean(element.isDefault),
  };
}

async function fetchVocabulary<T>(
  profile: ActiveProfile,
  path: string,
  convert: (element: HalElement) => T,
): Promise<Array<T>> {
  const elements: Array<T> = [];
  for await (const element of halElements<HalElement>((page) => apiGet(
    profile.instanceUrl,
    profile.apiKey,
    page,
  ), path)) {
    elements.push(convert(element));
  }
  return elements;
}

async function fetchInstanceInfo(profile: ActiveProfile): Promise<StoredInstanceInfo> {
  let apiVersion: string | null = null;
  let coreVersion: string | null = null;
  try {
    const root = (await apiGet(profile.instanceUrl, profile.apiKey, "/api/v3/")) as HalElement;
    apiVersion = typeof root.apiVersion === "string" ? root.apiVersion : null;
    coreVersion = typeof root.coreVersion === "string" ? root.coreVersion : null;
  } catch {
    // The root probe only enriches the store; stock instances may omit it.
  }
  return {
    url: profile.instanceUrl,
    api_version: apiVersion,
    core_version: coreVersion,
    fetched_at: new Date().toISOString(),
  };
}

async function fetchProjectRef(
  profile: ActiveProfile,
  projectId: number,
): Promise<StoredProjectRef> {
  const project = (await apiGet(
    profile.instanceUrl,
    profile.apiKey,
    `/api/v3/projects/${String(projectId)}`,
  )) as HalElement;
  return {
    id: Number(project.id),
    identifier: asString(project.identifier),
    name: asString(project.name),
  };
}

export async function fetchStoredMetadata(
  env: RunEnvironment,
  profile: ActiveProfile,
): Promise<StoredMetadata> {
  const types = sortByName(
    await fetchVocabulary(profile, "/api/v3/types", toStoredType),
  );
  const statuses = sortByName(
    await fetchVocabulary(profile, "/api/v3/statuses", toStoredStatus),
  );
  const priorities = sortByName(
    await fetchVocabulary(profile, "/api/v3/priorities", toStoredPriority),
  );
  const instance = await fetchInstanceInfo(profile);
  const project = profile.project === undefined
    ? undefined
    : await fetchProjectRef(profile, profile.project);
  return {
    types,
    statuses,
    priorities,
    instance,
    ...(project === undefined ? {} : { project }),
  };
}

export async function loadStoredMetadata(
  env: RunEnvironment,
  profile: ActiveProfile,
): Promise<StoredMetadata> {
  const stored = await readStoredMetadata(env, profile);
  if (stored !== undefined) {
    return stored;
  }
  const fetched = await fetchStoredMetadata(env, profile);
  await persistMetadata(env, profile, fetched);
  return fetched;
}

export async function refreshStoredMetadata(
  env: RunEnvironment,
  profile: ActiveProfile,
): Promise<Array<MetadataChange>> {
  const previous = await readStoredMetadata(env, profile);
  const next = await fetchStoredMetadata(env, profile);
  await persistMetadata(env, profile, next);

  const changes: Array<MetadataChange> = [
    ...diffEntries("types", previous?.types, next.types),
    ...diffEntries("statuses", previous?.statuses, next.statuses),
    ...diffEntries("priorities", previous?.priorities, next.priorities),
    ...diffProject(previous?.project, next.project),
    ...diffInstance(previous?.instance, next.instance),
  ];
  return changes;
}

export async function clearStoredMetadata(
  env: RunEnvironment,
  profile: ActiveProfile,
): Promise<void> {
  await rm(metadataPath(env, profile), { force: true });
}

function formatValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  return String(value);
}

function fieldDiffs(before: object, after: object): Array<string> {
  const beforeRecord = before as Record<string, unknown>;
  const afterRecord = after as Record<string, unknown>;
  const keys = new Set([
    ...Object.keys(beforeRecord),
    ...Object.keys(afterRecord),
  ]);
  const diffs: Array<string> = [];
  for (const key of keys) {
    if (!Object.is(beforeRecord[key], afterRecord[key])) {
      diffs.push(
        `${key}: ${formatValue(beforeRecord[key])} -> ${formatValue(afterRecord[key])}`,
      );
    }
  }
  return diffs.sort();
}

function diffEntries<Entry extends { readonly id: number; readonly name: string }>(
  section: MetadataSection,
  before: ReadonlyArray<Entry> | undefined,
  after: ReadonlyArray<Entry>,
): Array<MetadataChange> {
  const changes: Array<MetadataChange> = [];
  const beforeById = new Map(
    (before ?? []).map((entry) => [entry.id, entry] as const),
  );
  const afterIds = new Set(after.map((entry) => entry.id));
  for (const entry of after) {
    const previous = beforeById.get(entry.id);
    if (previous === undefined) {
      changes.push({
        section,
        kind: "added",
        id: entry.id,
        detail: `added ${entry.name} (${String(entry.id)})`,
      });
      continue;
    }
    const diffs = fieldDiffs(previous, entry);
    if (diffs.length > 0) {
      changes.push({
        section,
        kind: "changed",
        id: entry.id,
        detail: `${diffs.join("; ")} (${String(entry.id)})`,
      });
    }
  }
  for (const entry of before ?? []) {
    if (!afterIds.has(entry.id)) {
      changes.push({
        section,
        kind: "removed",
        id: entry.id,
        detail: `removed ${entry.name} (${String(entry.id)})`,
      });
    }
  }
  return changes;
}
function diffProject(
  before: StoredProjectRef | undefined,
  after: StoredProjectRef | undefined,
): Array<MetadataChange> {
  if (before === undefined && after !== undefined) {
    return [{
      section: "project",
      kind: "added",
      id: after.id,
      detail: `added ${after.name} (${String(after.id)})`,
    }];
  }
  if (before !== undefined && after === undefined) {
    return [{
      section: "project",
      kind: "removed",
      id: before.id,
      detail: `removed ${before.name} (${String(before.id)})`,
    }];
  }
  if (before === undefined || after === undefined) {
    return [];
  }
  const diffs = fieldDiffs(before, after);
  return diffs.length === 0
    ? []
    : [{ section: "project", kind: "changed", id: after.id, detail: diffs.join("; ") }];
}

function diffInstance(
  before: StoredInstanceInfo | undefined,
  after: StoredInstanceInfo,
): Array<MetadataChange> {
  if (before === undefined) {
    return [];
  }
  const comparable = (info: StoredInstanceInfo): HalElement => ({
    api_version: info.api_version,
    core_version: info.core_version,
  });
  const diffs = fieldDiffs(comparable(before), comparable(after));
  return diffs.length === 0
    ? []
    : [{ section: "instance", kind: "changed", id: null, detail: diffs.join("; ") }];
}

