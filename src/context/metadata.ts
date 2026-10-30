import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { halRefId } from "../core/hal.js";
import { apiGet, apiPost } from "../core/http.js";
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

export interface StoredMemberRole {
  readonly id: number;
  readonly title: string;
}

export interface StoredMember {
  readonly membership_id: number;
  readonly user_id: number;
  readonly name: string;
  readonly type: "User" | "Group" | "Placeholder";
  readonly roles: ReadonlyArray<StoredMemberRole>;
}

export interface StoredVersion {
  readonly id: number;
  readonly name: string;
  readonly status: string;
}

export interface StoredCategory {
  readonly id: number;
  readonly name: string;
}

/**
 * One sprint of the project (#46). The status is the tail of the API's
 * status urn ("in_planning", "active"), not its title, which the instance
 * localizes.
 */
export interface StoredSprint {
  readonly id: number;
  readonly name: string;
  readonly start_date: string | null;
  readonly finish_date: string | null;
  readonly status: string;
}

/** One backlog bucket of the project (#46). */
export interface StoredBucket {
  readonly id: number;
  readonly name: string;
}

export interface StoredActivity {
  readonly id: number;
  readonly name: string;
  readonly is_default: boolean;
}

/** One selectable value of a list field, with the id behind its name. */
export interface StoredCustomOption {
  readonly id: number;
  readonly name: string;
}

export interface StoredCustomField {
  readonly key: string;
  readonly id: number;
  readonly name: string;
  readonly allowed_values?: ReadonlyArray<string>;
  // Captured from the work package schema so `wp create` can validate
  // input without refetching: booleans accept only true/false and
  // user-typed fields resolve values like --assignee.
  readonly is_boolean?: true;
  readonly is_user?: true;
  /**
   * A long-text field: API v3 requires a Formattable `{ raw }` object on
   * write and empties the field if handed a bare string (#41).
   */
  readonly is_formattable?: true;
  /**
   * A list field: its value is a CustomOption resource, so the payload
   * carries an href under _links and never the option's text.
   */
  readonly is_list?: true;
  /**
   * The schema spells a multi-valued field "[]Kind". Only the list path
   * reads this today; every other kind holds one value by construction.
   */
  readonly is_multi?: true;
  /**
   * The schema marks the field required: a work package of a type that
   * carries it cannot be created without it.
   */
  readonly is_required?: true;
  /**
   * Every option of a list field, uncapped: resolution needs the id
   * behind any name the caller may type, not a readable sample.
   */
  readonly allowed_options?: ReadonlyArray<StoredCustomOption>;
}

/**
 * The project vocabularies a user may be refused without the project being
 * unusable: each is fetched on its own, and a 403 or 404 stores it empty
 * with a marker instead of failing the whole load (#44). A new optional
 * source joins by adding its name here.
 */
export type OptionalVocabularySource =
  | "versions"
  | "categories"
  | "activities"
  | "sprints"
  | "buckets";

/** Why one optional source could not be read when it was fetched. */
export interface UnavailableSource {
  readonly status: 403 | 404;
  readonly message: string;
}

/**
 * Whether a type's schema carries one of the version-valued link fields,
 * and whether it holds several versions. Absence of the key means the
 * schema does not expose the field.
 */
export interface StoredVersionField {
  readonly multiple: boolean;
}

/** The version-valued fields one type's schema exposes (#47). */
export interface StoredVersionFields {
  readonly targetVersions?: StoredVersionField;
  readonly observedInVersions?: StoredVersionField;
}

export interface ProjectVocabulary {
  readonly project_id: number;
  readonly fetched_at: string;
  readonly members: ReadonlyArray<StoredMember>;
  readonly versions: ReadonlyArray<StoredVersion>;
  readonly categories: ReadonlyArray<StoredCategory>;
  readonly activities: ReadonlyArray<StoredActivity>;
  /**
   * Absent in a vocabulary stored before sprints and backlog buckets were
   * captured (#46); a command that needs them refreshes once.
   */
  readonly sprints?: ReadonlyArray<StoredSprint>;
  readonly buckets?: ReadonlyArray<StoredBucket>;
  readonly custom_fields: Readonly<Record<string, ReadonlyArray<StoredCustomField>>>;
  /**
   * Optional sources the instance refused, keyed by source. Absent when
   * every source answered, which is also how a store written before this
   * marker existed reads.
   */
  readonly unavailable?: Readonly<Partial<Record<OptionalVocabularySource, UnavailableSource>>>;
  /**
   * Keyed by type id. Absent in a vocabulary stored before the schema's
   * version fields were captured; a refresh fills it in.
   */
  readonly version_fields?: Readonly<Record<string, StoredVersionFields>>;
}

export interface StoredMetadata {
  readonly types: ReadonlyArray<StoredType>;
  readonly statuses: ReadonlyArray<StoredStatus>;
  readonly priorities: ReadonlyArray<StoredPriority>;
  readonly instance: StoredInstanceInfo;
  readonly project?: StoredProjectRef;
  /** Project-scoped vocabularies keyed by the numeric project id. */
  readonly projectScoped?: Readonly<Record<string, ProjectVocabulary>>;
}

export type MetadataSection =
  | "types"
  | "statuses"
  | "priorities"
  | "project"
  | "instance"
  | "members"
  | "versions"
  | "categories"
  | "activities"
  | "sprints"
  | "buckets"
  | "fields";

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

function hrefId(value: unknown): number {
  const href = asString((value as HalElement | undefined)?.href);
  const match = /(\d+)\/?$/.exec(href);
  return match === null ? 0 : Number(match[1]);
}

function principalKind(element: HalElement): StoredMember["type"] {
  switch (asString(element._type)) {
    case "Group":
      return "Group";
    case "PlaceholderUser":
    case "Placeholder":
      return "Placeholder";
    default:
      return "User";
  }
}

function toStoredMember(element: HalElement): StoredMember {
  const links = (element._links ?? {}) as HalElement;
  const embedded = (element._embedded ?? {}) as HalElement;
  const principal = (embedded.principal ?? {}) as HalElement;
  const principalLink = (links.principal ?? {}) as HalElement;
  const roles = Array.isArray(links.roles) ? links.roles : [];
  return {
    membership_id: Number(element.id),
    user_id: typeof principal.id === "number"
      ? principal.id
      : hrefId(principalLink),
    name: asString(principal.name) || asString(principalLink.title),
    type: principalKind(principal),
    roles: roles.map((role) => ({
      id: hrefId(role),
      title: asString((role as HalElement).title),
    })),
  };
}

function toStoredVersion(element: HalElement): StoredVersion {
  return {
    id: Number(element.id),
    name: asString(element.name),
    status: asString(element.status),
  };
}

function toStoredCategory(element: HalElement): StoredCategory {
  return {
    id: Number(element.id),
    name: asString(element.name),
  };
}

function toStoredSprint(element: HalElement): StoredSprint {
  const links = (element._links ?? {}) as HalElement;
  const status = asString((links.status as HalElement | undefined)?.href);
  return {
    id: Number(element.id),
    name: asString(element.name),
    start_date: typeof element.startDate === "string" ? element.startDate : null,
    finish_date: typeof element.finishDate === "string" ? element.finishDate : null,
    status: status.slice(status.lastIndexOf(":") + 1),
  };
}

function toStoredBucket(element: HalElement): StoredBucket {
  return {
    id: Number(element.id),
    name: asString(element.name),
  };
}

// Above this size an allowed-values list is noise in the store, not a
// usable dropdown; the field keeps working, just without the list.
const MAX_ALLOWED_VALUES = 50;

/**
 * The selectable values of one schema property, in either shape an
 * instance uses: full resources under `_embedded.allowedValues`, which is
 * what the create form returns, or bare links under `_links.allowedValues`,
 * which is all the schema endpoint ever carries. Anything without a
 * readable id is dropped rather than resolved to a fabricated one.
 */
function allowedOptionsOf(property: HalElement): ReadonlyArray<StoredCustomOption> {
  const embedded = (property._embedded ?? {}) as HalElement;
  const resources = Array.isArray(embedded.allowedValues)
    ? (embedded.allowedValues as ReadonlyArray<unknown>)
    : [];
  if (resources.length > 0) {
    return resources.flatMap((value) => {
      const option = value as HalElement;
      const id = Number(option.id);
      if (!Number.isFinite(id)) {
        return [];
      }
      return [{
        id,
        // A CustomOption spells its text "value"; every other resource
        // spells it "name".
        name: asString(option.value ?? option.name),
      }];
    });
  }
  const links = (property._links ?? {}) as HalElement;
  const values = Array.isArray(links.allowedValues)
    ? (links.allowedValues as ReadonlyArray<unknown>)
    : [];
  return values.flatMap((value) => {
    const link = value as HalElement;
    const id = halRefId(typeof link.href === "string" ? link.href : null);
    return id === null ? [] : [{ id, name: asString(link.title) }];
  });
}

/**
 * The allowed values of one custom field as humans read them: the names of
 * a list field's options, or the values the schema listed for any other
 * kind. A vocabulary longer than MAX_ALLOWED_VALUES teaches nothing in a
 * table cell, so it renders as nothing.
 */
export function customFieldAllowedNames(
  field: StoredCustomField,
): ReadonlyArray<string> {
  const names = field.allowed_options === undefined
    ? field.allowed_values ?? []
    : field.allowed_options.map((option) => option.name);
  return names.length > MAX_ALLOWED_VALUES ? [] : names;
}

function customFieldEntries(schema: HalElement): Array<StoredCustomField> {
  const fields: Array<StoredCustomField> = [];
  for (const [key, property] of Object.entries(schema)) {
    if (!/^customField\d+$/.test(key)) {
      continue;
    }
    // The schema `type` decides input validation downstream; anything
    // beyond Boolean/User/Formattable/CustomOption stays unmarked and
    // passes through as text. A multi-valued field spells its kind "[]Kind".
    const kind = asString((property as HalElement).type).toLowerCase();
    const single = kind.replace(/^\[\]/, "");
    const isUser = kind === "user";
    // A user field's allowed values are the project's members, which
    // meta members already lists; keeping them here would only bloat the
    // store.
    const options = isUser ? [] : allowedOptionsOf(property as HalElement);
    const isList = single === "customoption";
    fields.push({
      key,
      id: Number(key.slice("customField".length)),
      name: asString((property as HalElement).name),
      ...((property as HalElement).required === true
        ? { is_required: true as const }
        : {}),
      ...(!isList && options.length > 0 && options.length <= MAX_ALLOWED_VALUES
        ? { allowed_values: options.map((option) => option.name) }
        : {}),
      ...(kind === "boolean" ? { is_boolean: true as const } : {}),
      ...(isUser ? { is_user: true as const } : {}),
      ...(kind === "formattable" ? { is_formattable: true as const } : {}),
      ...(isList ? { is_list: true as const, allowed_options: options } : {}),
      ...(kind.startsWith("[]") ? { is_multi: true as const } : {}),
    });
  }
  return fields;
}

async function fetchMembers(
  profile: ActiveProfile,
  projectId: number,
): Promise<ReadonlyArray<StoredMember>> {
  const filters = encodeURIComponent(
    JSON.stringify([{ project: { operator: "=", values: [String(projectId)] } }]),
  );
  const members = await fetchVocabulary(
    profile,
    `/api/v3/memberships?filters=${filters}`,
    toStoredMember,
  );
  return sortByName(members);
}

async function fetchVersions(
  profile: ActiveProfile,
  projectId: number,
): Promise<ReadonlyArray<StoredVersion>> {
  const versions = await fetchVocabulary(
    profile,
    `/api/v3/projects/${String(projectId)}/versions`,
    toStoredVersion,
  );
  return sortByName(versions);
}

async function fetchCategories(
  profile: ActiveProfile,
  projectId: number,
): Promise<ReadonlyArray<StoredCategory>> {
  const categories = await fetchVocabulary(
    profile,
    `/api/v3/projects/${String(projectId)}/categories`,
    toStoredCategory,
  );
  return sortByName(categories);
}

async function fetchSprints(
  profile: ActiveProfile,
  projectId: number,
): Promise<ReadonlyArray<StoredSprint>> {
  const sprints = await fetchVocabulary(
    profile,
    `/api/v3/projects/${String(projectId)}/sprints`,
    toStoredSprint,
  );
  return sortByName(sprints);
}

async function fetchBuckets(
  profile: ActiveProfile,
  projectId: number,
): Promise<ReadonlyArray<StoredBucket>> {
  const buckets = await fetchVocabulary(
    profile,
    `/api/v3/projects/${String(projectId)}/backlog_buckets`,
    toStoredBucket,
  );
  return sortByName(buckets);
}

// The bare schema endpoint builds its values from TimeEntry.new, so its
// activity list is never populated. Only the create form (form_embedded)
// fills the activities that are active in the referenced project; its
// payload carries linked resources under _links, and the embedded schema
// lists full activity representations under activity/_embedded/allowedValues.
async function fetchActivities(
  profile: ActiveProfile,
  projectId: number,
): Promise<ReadonlyArray<StoredActivity>> {
  const form = (await apiPost(
    profile.instanceUrl,
    profile.apiKey,
    "/api/v3/time_entries/form",
    { _links: { project: { href: `/api/v3/projects/${String(projectId)}` } } },
  )) as HalElement;
  const formEmbedded = (form._embedded ?? {}) as HalElement;
  const schema = (formEmbedded.schema ?? {}) as HalElement;
  const activity = (schema.activity ?? {}) as HalElement;
  const activityEmbedded = (activity._embedded ?? {}) as HalElement;
  const values = Array.isArray(activityEmbedded.allowedValues)
    ? (activityEmbedded.allowedValues as ReadonlyArray<HalElement>)
    : [];
  const activities = values.map((option) => ({
    id: Number(option.id),
    name: asString(option.name),
    is_default: option.default === true,
  }));
  return sortByName(activities);
}

/**
 * The schema of one project-and-type pair, from the richest source that
 * answers. The bare schema endpoint names every custom field but leaves a
 * list field's allowed values empty; only the create form fills them, so
 * the form is asked first. A caller who may not open a create form still
 * gets every field, just without the options.
 */
async function fetchTypeSchema(
  profile: ActiveProfile,
  projectId: number,
  typeId: number,
): Promise<HalElement> {
  try {
    const form = (await apiPost(
      profile.instanceUrl,
      profile.apiKey,
      `/api/v3/projects/${String(projectId)}/work_packages/form`,
      { _links: { type: { href: `/api/v3/types/${String(typeId)}` } } },
    )) as HalElement;
    const embedded = (form._embedded ?? {}) as HalElement;
    const schema = embedded.schema;
    if (typeof schema === "object" && schema !== null && !Array.isArray(schema)) {
      return schema as HalElement;
    }
  } catch {
    // The form is an enrichment, never the only source.
  }
  return (await apiGet(
    profile.instanceUrl,
    profile.apiKey,
    `/api/v3/work_packages/schemas/${String(projectId)}-${String(typeId)}`,
  )) as HalElement;
}

function versionFieldsOf(schema: HalElement): StoredVersionFields {
  const entry = (key: "targetVersions" | "observedInVersions"): StoredVersionFields => {
    const property = schema[key] as HalElement | undefined;
    if (typeof property !== "object" || property === null) {
      return {};
    }
    const options = (property.options ?? {}) as HalElement;
    const multiple = options.multiple === true
      || asString(property.type).startsWith("[]");
    return { [key]: { multiple } };
  };
  return { ...entry("targetVersions"), ...entry("observedInVersions") };
}

async function fetchTypeSchemas(
  profile: ActiveProfile,
  projectId: number,
): Promise<Pick<ProjectVocabulary, "custom_fields" | "version_fields">> {
  const typeIds = await fetchVocabulary(
    profile,
    `/api/v3/projects/${String(projectId)}/types`,
    (element) => Number(element.id),
  );
  const byType: Record<string, ReadonlyArray<StoredCustomField>> = {};
  const versionFields: Record<string, StoredVersionFields> = {};
  for (const typeId of typeIds) {
    const schema = await fetchTypeSchema(profile, projectId, typeId);
    byType[String(typeId)] = sortByName(customFieldEntries(schema));
    versionFields[String(typeId)] = versionFieldsOf(schema);
  }
  return { custom_fields: byType, version_fields: versionFields };
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
  const fetched = await fetchStoredMetadata(profile);
  await persistMetadata(env, profile, fetched);
  return fetched;
}

export async function refreshStoredMetadata(
  env: RunEnvironment,
  profile: ActiveProfile,
): Promise<Array<MetadataChange>> {
  const previous = await readStoredMetadata(env, profile);
  const next = await fetchStoredMetadata(profile);
  const previousScoped = previous?.projectScoped ?? {};
  const projectScoped: Record<string, ProjectVocabulary> = {};
  const dropped: Array<MetadataChange> = [];
  for (const projectId of Object.keys(previousScoped)) {
    try {
      projectScoped[projectId] = await fetchProjectVocabulary(profile, Number(projectId));
    } catch (error) {
      // A project deleted on the instance must not wedge the refresh for
      // good: drop its stored vocabulary, report it, and keep refreshing
      // everything else. Any other failure is still the caller's to see.
      if (!(error instanceof OpCliError && error.code === "NOT_FOUND")) {
        throw error;
      }
      dropped.push({
        section: "project",
        kind: "removed",
        id: Number(projectId),
        detail: `removed cached vocabulary of project ${projectId}`,
      });
    }
  }
  await persistMetadata(env, profile, {
    ...next,
    ...(Object.keys(projectScoped).length > 0 ? { projectScoped } : {}),
  });

  const changes: Array<MetadataChange> = [
    ...diffEntries("types", previous?.types, next.types),
    ...diffEntries("statuses", previous?.statuses, next.statuses),
    ...diffEntries("priorities", previous?.priorities, next.priorities),
    ...diffProject(previous?.project, next.project),
    ...dropped,
    ...diffInstance(previous?.instance, next.instance),
  ];
  for (const projectId of Object.keys(projectScoped)) {
    changes.push(
      ...diffVocabulary(previousScoped[projectId], projectScoped[projectId]),
    );
  }
  return changes;
}

/**
 * One optional source, read so that a refusal empties it rather than
 * failing the load. Only a 403 or 404 counts as a refusal; a 5xx, a
 * timeout, or a 401 still fails, since an empty list there would hide an
 * outage as "no values".
 */
async function fetchOptional<T>(
  source: OptionalVocabularySource,
  unavailable: Partial<Record<OptionalVocabularySource, UnavailableSource>>,
  fetch: () => Promise<ReadonlyArray<T>>,
): Promise<ReadonlyArray<T>> {
  try {
    return await fetch();
  } catch (error) {
    if (
      error instanceof OpCliError
      && (error.code === "PERMISSION_DENIED" || error.code === "NOT_FOUND")
    ) {
      unavailable[source] = {
        status: error.code === "PERMISSION_DENIED" ? 403 : 404,
        message: error.message,
      };
      return [];
    }
    throw error;
  }
}

export async function fetchProjectVocabulary(
  profile: ActiveProfile,
  projectId: number,
): Promise<ProjectVocabulary> {
  const unavailable: Partial<Record<OptionalVocabularySource, UnavailableSource>> = {};
  // Members come first and stay required: a deleted project answers 404
  // there, which the refresh reads as "drop this project".
  const members = await fetchMembers(profile, projectId);
  const versions = await fetchOptional("versions", unavailable,
    () => fetchVersions(profile, projectId));
  const categories = await fetchOptional("categories", unavailable,
    () => fetchCategories(profile, projectId));
  const activities = await fetchOptional("activities", unavailable,
    () => fetchActivities(profile, projectId));
  // A project without the backlogs module answers 404 on both.
  const sprints = await fetchOptional("sprints", unavailable,
    () => fetchSprints(profile, projectId));
  const buckets = await fetchOptional("buckets", unavailable,
    () => fetchBuckets(profile, projectId));
  return {
    project_id: projectId,
    fetched_at: new Date().toISOString(),
    members,
    versions,
    categories,
    activities,
    sprints,
    buckets,
    ...(await fetchTypeSchemas(profile, projectId)),
    ...(Object.keys(unavailable).length > 0 ? { unavailable } : {}),
  };
}

/**
 * The entries of one optional source for a command that cannot proceed
 * without them. A source the instance refused fails here with
 * PERMISSION_DENIED naming it, instead of reading as an empty vocabulary
 * where every name misses.
 */
export function requireVocabulary<S extends OptionalVocabularySource>(
  vocabulary: ProjectVocabulary,
  source: S,
): NonNullable<ProjectVocabulary[S]> {
  const refusal = vocabulary.unavailable?.[source];
  if (refusal !== undefined) {
    throw new OpCliError(
      "PERMISSION_DENIED",
      `The ${source} of project ${String(vocabulary.project_id)} are unavailable`
        + ` to this account (HTTP ${String(refusal.status)}): ${refusal.message}`,
      "ask a project administrator for the permission or module, then run op-cli meta refresh.",
      { source, project_id: vocabulary.project_id, status: refusal.status },
    );
  }
  // A store from before a source was captured reads as empty here; the
  // callers that need sprints or buckets refresh such a store first.
  return vocabulary[source] ?? [];
}

/** One refused source of one stored project, flattened for reporting. */
export interface UnavailableEntry {
  readonly project_id: number;
  readonly source: OptionalVocabularySource;
  readonly status: 403 | 404;
  readonly message: string;
}

export function unavailableSources(metadata: StoredMetadata): Array<UnavailableEntry> {
  const entries: Array<UnavailableEntry> = [];
  for (const vocabulary of Object.values(metadata.projectScoped ?? {})) {
    for (const [source, refusal] of Object.entries(vocabulary.unavailable ?? {})) {
      entries.push({
        project_id: vocabulary.project_id,
        source: source as OptionalVocabularySource,
        status: refusal.status,
        message: refusal.message,
      });
    }
  }
  return entries.sort((a, b) =>
    a.project_id - b.project_id || a.source.localeCompare(b.source));
}

export async function loadProjectVocabulary(
  env: RunEnvironment,
  profile: ActiveProfile,
): Promise<ProjectVocabulary> {
  if (profile.project === undefined) {
    throw new OpCliError(
      "USAGE_ERROR",
      "the lookup needs a project to read its vocabulary from.",
      "pass --project <id> or set a default project on the profile.",
    );
  }
  return loadProjectVocabularyById(env, profile, profile.project);
}

/**
 * The same cache-and-fetch flow for an explicit project id, used when the
 * project is not the profile default but a resource's own (a time entry
 * resolves its activity against the project of its work package).
 */
export async function loadProjectVocabularyById(
  env: RunEnvironment,
  profile: ActiveProfile,
  projectId: number,
): Promise<ProjectVocabulary> {
  const stored = await readStoredMetadata(env, profile);
  const cached = stored?.projectScoped?.[String(projectId)];
  if (cached !== undefined) {
    return cached;
  }
  const base = stored ?? (await fetchStoredMetadata(profile));
  const vocabulary = await fetchProjectVocabulary(profile, projectId);
  await persistMetadata(env, profile, {
    ...base,
    projectScoped: {
      ...base.projectScoped,
      [String(projectId)]: vocabulary,
    },
  });
  return vocabulary;
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
  // Arrays (roles, allowed values) arrive as fresh objects on every fetch;
  // compare them by value or every refresh would flag them as changed.
  const sameValue = (before: unknown, after: unknown): boolean =>
    Array.isArray(before) || Array.isArray(after)
      ? JSON.stringify(before) === JSON.stringify(after)
      : Object.is(before, after);
  const diffs: Array<string> = [];
  for (const key of keys) {
    if (!sameValue(beforeRecord[key], afterRecord[key])) {
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


function diffVocabulary(
  before: ProjectVocabulary | undefined,
  after: ProjectVocabulary | undefined,
): Array<MetadataChange> {
  if (after === undefined) {
    return [];
  }
  // diffEntries keys on id; members identify by their membership id.
  const memberEntry = (member: StoredMember) => ({
    id: member.membership_id,
    name: member.name,
    roles: member.roles,
  });
  const fields = (vocabulary: ProjectVocabulary | undefined) =>
    Object.values(vocabulary?.custom_fields ?? {}).flat();
  return [
    ...diffEntries(
      "members",
      before?.members.map(memberEntry),
      after.members.map(memberEntry),
    ),
    ...diffOptional("versions", before, after),
    ...diffOptional("categories", before, after),
    ...diffOptional("activities", before, after),
    ...diffOptional("sprints", before, after),
    ...diffOptional("buckets", before, after),
    ...diffEntries("fields", fields(before), fields(after)),
  ];
}

/**
 * The entry diff of one optional source, unless either side was refused:
 * an emptied list is a lost permission, not every entry being removed, so
 * it reports the flip once instead of one removal per entry.
 */
function diffOptional(
  source: OptionalVocabularySource,
  before: ProjectVocabulary | undefined,
  after: ProjectVocabulary,
): Array<MetadataChange> {
  const was = before?.unavailable?.[source];
  const is = after.unavailable?.[source];
  if (was === undefined && is === undefined) {
    return diffEntries(source, before?.[source], after[source] ?? []);
  }
  if (before === undefined || was?.status === is?.status) {
    return [];
  }
  const project = String(after.project_id);
  return [{
    section: source,
    kind: "changed",
    id: null,
    detail: is === undefined
      ? `became available in project ${project}`
      : `became unavailable in project ${project} (${String(is.status)})`,
  }];
}
