import type { Command } from "commander";

import { formatCell, renderTable } from "../output/table.js";

import { OpCliError } from "../core/errors.js";
import { filtersQuery, type WpFilter } from "../core/filters.js";
import { emitRows, type CollectionColumn, type CollectionRuntime } from "../core/define.js";
import { flattenHalRecord } from "../core/hal.js";
import {
  apiDelete,
  apiGet,
  apiPatchRaw,
  apiPost,
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
  isIdForm,
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

export interface ProjectRuntime {
  readonly resolve: (overrides?: ContextOverrides) => Promise<ActiveProfile>;
  readonly write: (text: string) => void;
  readonly writeErr: (text: string) => void;
  readonly setJsonMode: (on: boolean) => void;
}

const LIST_COLUMNS: ReadonlyArray<CollectionColumn> = [
  { title: "ID", field: "id" },
  { title: "IDENTIFIER", field: "identifier" },
  { title: "NAME", field: "name" },
  { title: "PUBLIC", field: "public" },
  { title: "FAVORITED", field: "favorited" },
];

const VERSION_COLUMNS: ReadonlyArray<CollectionColumn> = [
  { title: "ID", field: "id" },
  { title: "NAME", field: "name" },
  { title: "STATUS", field: "status" },
];

const CATEGORY_COLUMNS: ReadonlyArray<CollectionColumn> = [
  { title: "ID", field: "id" },
  { title: "NAME", field: "name" },
];

const TYPE_COLUMNS: ReadonlyArray<CollectionColumn> = [
  { title: "ID", field: "id" },
  { title: "NAME", field: "name" },
  { title: "MILESTONE", field: "isMilestone" },
];

type OutputOptions = {
  readonly json?: boolean;
  readonly fields?: string;
};

type ScopeOptions = OutputOptions & {
  readonly profile?: string;
  readonly project?: string;
};

type GetPage = (path: string) => Promise<unknown>;

/** The shared opening: JSON mode first, then the profile behind the flags. */
async function connect(
  runtime: ProjectRuntime,
  options: ScopeOptions,
): Promise<{ getPage: GetPage }> {
  runtime.setJsonMode(options.json === true);
  const profile = await runtime.resolve({
    profile: options.profile,
    project: parseOptionalId(options.project),
  });
  return {
    getPage: (path) => apiGet(profile.instanceUrl, profile.apiKey, path),
  };
}

function collectValue(value: string, previous: Array<string>): Array<string> {
  return [...previous, value];
}

/**
 * One project a reference can resolve to. Every resolution goes through
 * this shape so ambiguity and suggestions speak in ids and names only.
 */
interface ProjectHit {
  readonly id: number;
  readonly identifier: string;
  readonly name: string;
}

function hitOf(element: unknown): ProjectHit | undefined {
  const candidate = element as {
    readonly id?: unknown;
    readonly identifier?: unknown;
    readonly name?: unknown;
  };
  return typeof candidate.id === "number"
    && typeof candidate.identifier === "string"
    && typeof candidate.name === "string"
    ? { id: candidate.id, identifier: candidate.identifier, name: candidate.name }
    : undefined;
}

const PROJECTS_COLLECTION = "/api/v3/projects";

const PRINCIPALS_COLLECTION = "/api/v3/principals";
const ROLES_COLLECTION = "/api/v3/roles";
const MEMBERSHIPS_COLLECTION = "/api/v3/memberships";

/**
 * Every visible project, page by page in server order. Resolution walks
 * instead of filtering server-side because the exact-match filter set
 * differs between instance versions; the collection endpoint does not.
 */
async function walkProjects(getPage: GetPage): Promise<Array<ProjectHit>> {
  const hits: Array<ProjectHit> = [];
  for await (const element of halElements<unknown>(
    getPage,
    withPageSize(PROJECTS_COLLECTION, DEFAULT_PAGE_SIZE),
  )) {
    const hit = hitOf(element);
    if (hit !== undefined) {
      hits.push(hit);
    }
  }
  return hits;
}

function missingProjectError(raw: string, known: ReadonlyArray<string>): OpCliError {
  return new OpCliError(
    "NOT_FOUND",
    `project "${raw}" not found.`,
    known.length > 0
      ? `known projects, closest first: ${rankByCloseness(raw, known).slice(0, 6).join(", ")}.`
      : "check the spelling or list projects with op-cli project list.",
  );
}

/**
 * Resolve one reference that may be an id, an identifier, or a name.
 * All-digits means an id and is fetched directly. Anything else matches
 * identifier and name exactly across every visible project; one distinct
 * match wins, several distinct projects fail loudly instead of guessing.
 */
async function resolveProjectRef(
  getPage: GetPage,
  raw: string,
): Promise<ProjectHit> {
  if (isIdForm(raw)) {
    try {
      const hit = hitOf(await getPage(`${PROJECTS_COLLECTION}/${raw}`));
      if (hit !== undefined) {
        return hit;
      }
      throw new OpCliError(
        "NOT_FOUND",
        `project "${raw}" not found.`,
        "check the id; run op-cli project list to see what is visible.",
      );
    } catch (error) {
      if (error instanceof OpCliError && error.code === "USAGE_ERROR") {
        throw error;
      }
      if (error instanceof OpCliError && error.code === "NOT_FOUND") {
        throw new OpCliError(
          "NOT_FOUND",
          `project "${raw}" not found.`,
          "check the id; run op-cli project list to see what is visible.",
        );
      }
      throw error;
    }
  }
  const all = await walkProjects(getPage);
  const matches = all.filter((hit) => hit.identifier === raw || hit.name === raw);
  const distinct = [...new Map(matches.map((hit) => [hit.id, hit])).values()];
  if (distinct.length === 1) {
    return distinct[0] as ProjectHit;
  }
  if (distinct.length > 1) {
    const listed = distinct.map((hit) => `${String(hit.id)} (${hit.name})`).join(", ");
    throw new OpCliError(
      "USAGE_ERROR",
      `project "${raw}" is ambiguous. Candidates: ${listed}.`,
      "repeat the value as the explicit id of one candidate.",
    );
  }
  throw missingProjectError(
    raw,
    all.flatMap((hit) => [hit.identifier, hit.name]),
  );
}

/**
 * One live lookup over an uncached collection. Stored metadata has a
 * refresh to re-read the disk store; here refresh simply walks again.
 */
function liveSource<V>(
  label: string,
  walk: () => Promise<ReadonlyArray<NamedEntry<V>>>,
): LookupSource<V> {
  let cache: Promise<ReadonlyArray<NamedEntry<V>>> | undefined;
  return {
    label,
    load: () => {
      cache ??= walk();
      return cache;
    },
    refresh: async () => {
      cache = walk();
      await cache;
    },
  };
}

/** Every principal of the instance, walked page by page in server order. */
async function walkPrincipals(
  getPage: GetPage,
): Promise<ReadonlyArray<NamedEntry<number>>> {
  const entries: Array<NamedEntry<number>> = [];
  for await (const element of halElements<Record<string, unknown>>(
    getPage,
    withPageSize(PRINCIPALS_COLLECTION, DEFAULT_PAGE_SIZE),
  )) {
    if (typeof element.id === "number" && typeof element.name === "string") {
      entries.push({
        name: element.name,
        owner: "principal",
        value: element.id,
      });
    }
  }
  return entries;
}

/** Every role of the instance; the API names them `title`. */
async function walkRoles(
  getPage: GetPage,
): Promise<ReadonlyArray<NamedEntry<number>>> {
  const entries: Array<NamedEntry<number>> = [];
  for await (const element of halElements<Record<string, unknown>>(
    getPage,
    withPageSize(ROLES_COLLECTION, DEFAULT_PAGE_SIZE),
  )) {
    if (typeof element.id === "number" && typeof element.title === "string") {
      entries.push({ name: element.title, owner: "role", value: element.id });
    }
  }
  return entries;
}

/**
 * One membership principal, by name, id, or me. Ids pass through
 * untouched; only a name costs the principals walk.
 */
async function resolvePrincipalId(
  profile: ActiveProfile,
  raw: string,
): Promise<number> {
  if (raw === "me") {
    return (await authenticate(profile.instanceUrl, profile.apiKey)).id;
  }
  if (isIdForm(raw)) {
    return Number(raw);
  }
  const getPage: GetPage = (path) =>
    apiGet(profile.instanceUrl, profile.apiKey, path);
  return resolveName(
    raw,
    liveSource("principal", () => walkPrincipals(getPage)),
  );
}

/** Membership roles, each by title or id; one walk serves them all. */
async function resolveRoleIds(
  profile: ActiveProfile,
  raws: ReadonlyArray<string>,
): Promise<Array<number>> {
  const getPage: GetPage = (path) =>
    apiGet(profile.instanceUrl, profile.apiKey, path);
  const source = liveSource("role", () => walkRoles(getPage));
  const ids: Array<number> = [];
  for (const raw of raws) {
    ids.push(isIdForm(raw) ? Number(raw) : await resolveName(raw, source));
  }
  return ids;
}

/**
 * The shared tail of every single-record command: --fields validated
 * against the actual record, then the FIELD/VALUE table or picked JSON.
 */
function selectedRecordFields(
  raw: string,
  record: Record<string, unknown>,
): Array<string> {
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
      "run the command without --fields to list every available field.",
    );
  }
  return requested;
}

function renderFieldTable(
  fields: ReadonlyArray<string>,
  record: Record<string, unknown>,
): string {
  return renderTable(
    ["FIELD", "VALUE"],
    fields.map((field) => [field, formatCell(record[field])]),
  );
}

function renderRecord(
  runtime: Pick<ProjectRuntime, "write">,
  options: OutputOptions,
  record: Record<string, unknown>,
): void {
  const fields = typeof options.fields === "string"
    ? selectedRecordFields(options.fields, record)
    : Object.keys(record);
  if (options.json === true) {
    const picked: Record<string, unknown> = {};
    for (const field of fields) {
      picked[field] = record[field];
    }
    runtime.write(`${JSON.stringify(picked)}\n`);
    return;
  }
  runtime.write(renderFieldTable(fields, record));
}

/**
 * A write whose failure to complete leaves the state unknown: timeouts
 * and network errors are never retried, and exit 6 says so instead of
 * inviting a duplicate. A surviving rejection maps through the closed
 * catalogue: 404 stays NOT_FOUND, 5xx becomes the unknown-state
 * NETWORK_ERROR, everything else carries the server's message.
 */
async function projectWrite(
  attempt: () => Promise<RawWriteResponse>,
  verb: string,
): Promise<unknown> {
  let response: RawWriteResponse;
  try {
    response = await attempt();
  } catch (error) {
    if (error instanceof OpCliError && error.code === "NETWORK_ERROR") {
      throw new OpCliError(
        "NETWORK_ERROR",
        `the ${verb} request did not complete; whether it was applied is unknown.`,
        verb === "update"
          ? "run op-cli project get to see the stored values before repeating the command."
          : "check whether the project exists before repeating the command.",
      );
    }
    throw error;
  }
  if (response.status < 400) {
    return response.body;
  }
  if (response.status === 404) {
    throw new OpCliError("NOT_FOUND");
  }
  if (response.status >= 500) {
    throw new OpCliError(
      "NETWORK_ERROR",
      `the ${verb} failed with HTTP ${String(response.status)}; `
        + "whether it was applied is unknown.",
      verb === "update"
        ? "run op-cli project get to see the stored values before repeating the command."
        : "check whether the project exists before repeating the command.",
    );
  }
  const detail = typeof response.body === "object"
    && response.body !== null
    && typeof (response.body as Record<string, unknown>).message === "string"
    ? (response.body as Record<string, unknown>).message as string
    : undefined;
  throw new OpCliError(
    "API_ERROR",
    detail === undefined ? undefined : `OpenProject rejected the ${verb}: ${detail}`,
  );
}

function requireIdentifier(options: { identifier?: string }, verb: string): string {
  if (options.identifier === undefined || options.identifier === "") {
    throw new OpCliError(
      "USAGE_ERROR",
      `project ${verb} needs an explicit identifier.`,
      "pass --identifier <value>; OpenProject requires a machine-readable "
        + "identifier next to the human name.",
    );
  }
  return options.identifier;
}

function optionalBooleanFlag(
  raw: boolean | undefined,
  value: string | undefined,
  flag: string,
): boolean | undefined {
  if (raw !== true) {
    return undefined;
  }
  const lowered = (value ?? "").trim().toLowerCase();
  if (lowered !== "true" && lowered !== "false") {
    throw new OpCliError(
      "USAGE_ERROR",
      `--${flag} accepts true or false, not "${value ?? ""}".`,
      "pass --flag true or --flag false explicitly.",
    );
  }
  return lowered === "true";
}

export function registerProjectCommands(
  project: Command,
  runtime: ProjectRuntime,
): void {
  project.description("Inspect and manage projects");

  // ---------------------------------------------------------------------------
  // project list

  project
    .command("list")
    .description("List visible projects with documented filters")
    .option("--search <text>", "substring match over name and identifier")
    .option("--active", "only projects that are not archived")
    .option("--archived", "only archived projects")
    .option("--favorite", "only projects favourited by the current user")
    .option("--parent <id>", "parent project id; repeat to OR values", collectValue, [])
    .option("--json", "emit a flat JSON array")
    .option("--limit <n>", "maximum number of results to show")
    .option("--all", "fetch every page instead of one limited page")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <id>", "override the profile default project")
    .action(async (options: {
      search?: string;
      active?: boolean;
      archived?: boolean;
      favorite?: boolean;
      parent?: Array<string>;
      json?: boolean;
      limit?: string;
      all?: boolean;
      profile?: string;
      project?: string;
    }) => {
      runtime.setJsonMode(options.json === true);
      // Flag misuse is refused before any traffic.
      if (options.active === true && options.archived === true) {
        throw new OpCliError(
          "USAGE_ERROR",
          "--active and --archived cannot be combined.",
          "pass only one of the two shorthands.",
        );
      }
      for (const parent of options.parent ?? []) {
        if (!isIdForm(parent)) {
          throw new OpCliError(
            "USAGE_ERROR",
            `--parent "${parent}" is not a project id.`,
            "--parent takes the numeric id of the parent project.",
          );
        }
      }
      const { getPage } = await connect(runtime, options);
      const filters: Array<WpFilter> = [];
      if (options.active === true || options.archived === true) {
        filters.push({
          name: "active",
          operator: "=",
          values: [options.active === true ? "t" : "f"],
        });
      }
      if (options.favorite === true) {
        filters.push({ name: "favorited", operator: "=", values: ["t"] });
      }
      if ((options.parent ?? []).length > 0) {
        filters.push({ name: "parent_id", operator: "=", values: options.parent ?? [] });
      }
      if (options.search !== undefined && options.search !== "") {
        filters.push({
          name: "name_and_identifier",
          operator: "~",
          values: [options.search],
        });
      }
      // No filter means a bare collection path, not an empty filters
      // parameter: the wire stays readable and mockable.
      const basePath = filters.length > 0
        ? `${PROJECTS_COLLECTION}?filters=${filtersQuery(filters)}`
        : PROJECTS_COLLECTION;
      const startPath = withPageSize(basePath, parsePageSize(options.limit));

      if (options.all === true) {
        if (options.json === true) {
          for await (const element of halElements<unknown>(getPage, startPath)) {
            runtime.write(`${JSON.stringify(flattenHalRecord(element))}\n`);
          }
          return;
        }
        const rows: Array<Record<string, unknown>> = [];
        for await (const element of halElements<unknown>(getPage, startPath)) {
          rows.push(flattenHalRecord(element));
        }
        runtime.write(renderTable(
          LIST_COLUMNS.map((column) => column.title),
          rows.map((row) =>
            LIST_COLUMNS.map((column) => formatCell(row[column.field]))),
        ));
        return;
      }

      const page = (await getPage(startPath)) as {
        total?: unknown;
        _embedded?: { elements?: readonly unknown[] };
      };
      const elements = page._embedded?.elements ?? [];
      const records = elements.map((element) => flattenHalRecord(element));
      emitRows(
        { write: runtime.write, writeErr: runtime.writeErr },
        LIST_COLUMNS,
        records,
        { json: options.json },
      );
      const total = typeof page.total === "number" ? page.total : elements.length;
      if (total > elements.length) {
        runtime.writeErr(
          `Showing ${records.length} of ${String(total)} projects. `
            + "Pass --all to fetch every result.\n",
        );
      }
    });

  // ---------------------------------------------------------------------------
  // project get

  project
    .command("get")
    .description("Show one project by id, identifier, or name")
    .argument("<reference>")
    .option("--json", "emit a flat JSON record")
    .option("--fields <list>", "comma-separated fields to show")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <id>", "override the profile default project")
    .action(async (reference: string, options: ScopeOptions) => {
      const { getPage } = await connect(runtime, options);
      const hit = await resolveProjectRef(getPage, reference);
      const record = flattenHalRecord(
        await getPage(`${PROJECTS_COLLECTION}/${String(hit.id)}`),
      );
      renderRecord(runtime, options, record);
    });

  // ---------------------------------------------------------------------------
  // project create

  project
    .command("create")
    .description("Create one project with an explicit identifier")
    .argument("<name>")
    .option("--identifier <value>", "machine-readable identifier of the new project")
    .option("--description <text>", "markdown description of the project")
    .option("--public", "make the project accessible for everybody")
    .option("--parent <reference>", "parent project, by id, identifier, or name")
    .option("--json", "emit a flat JSON record")
    .option("--fields <list>", "comma-separated fields to show")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <id>", "override the profile default project")
    .action(async (name: string, options: {
      identifier?: string;
      description?: string;
      public?: boolean;
      parent?: string;
    } & ScopeOptions) => {
      const identifier = requireIdentifier(options, "create");
      const { getPage } = await connect(runtime, options);
      const profile = await runtime.resolve({
        profile: options.profile,
        project: parseOptionalId(options.project),
      });
      const payload: Record<string, unknown> = { name, identifier };
      if (options.description !== undefined) {
        payload.description = options.description;
      }
      if (options.public === true) {
        payload.public = true;
      }
      if (options.parent !== undefined) {
        const parent = await resolveProjectRef(getPage, options.parent);
        payload._links = {
          parent: { href: `${PROJECTS_COLLECTION}/${String(parent.id)}` },
        };
      }
      const body = await projectWrite(
        () => apiPostRaw(profile.instanceUrl, profile.apiKey, PROJECTS_COLLECTION, payload),
        "create",
      );
      renderRecord(runtime, options, flattenHalRecord(body));
    });

  // ---------------------------------------------------------------------------
  // project update

  project
    .command("update")
    .description("Update one project by id, identifier, or name")
    .argument("<reference>")
    .option("--name <text>", "new display name")
    .option("--description <text>", "new markdown description")
    .option("--public <bool>", "true or false: accessibility for everybody")
    .option("--json", "emit a flat JSON record")
    .option("--fields <list>", "comma-separated fields to show")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <id>", "override the profile default project")
    .action(async (reference: string, options: {
      name?: string;
      description?: string;
      public?: string;
    } & ScopeOptions) => {
      const isPublic = optionalBooleanFlag(
        options.public !== undefined,
        options.public,
        "public",
      );
      const touchesSomething = options.name !== undefined
        || options.description !== undefined
        || isPublic !== undefined;
      if (!touchesSomething) {
        throw new OpCliError(
          "USAGE_ERROR",
          "project update needs at least one value to change.",
          "pass --name, --description, or --public true|false.",
        );
      }
      const { getPage } = await connect(runtime, options);
      const profile = await runtime.resolve({
        profile: options.profile,
        project: parseOptionalId(options.project),
      });
      const hit = await resolveProjectRef(getPage, reference);
      const payload: Record<string, unknown> = {};
      if (options.name !== undefined) {
        payload.name = options.name;
      }
      if (options.description !== undefined) {
        payload.description = options.description;
      }
      if (isPublic !== undefined) {
        payload.public = isPublic;
      }
      const body = await projectWrite(
        () => apiPatchRaw(
          profile.instanceUrl,
          profile.apiKey,
          `${PROJECTS_COLLECTION}/${String(hit.id)}`,
          payload,
        ),
        "update",
      );
      renderRecord(runtime, options, flattenHalRecord(body));
    });

  // ---------------------------------------------------------------------------
  // project copy

  project
    .command("copy")
    .description(
      "Create a new project carrying the source's description, visibility, and parent",
    )
    .argument("<reference>", "source project, by id, identifier, or name")
    .argument("<name>", "display name of the copy")
    .option("--identifier <value>", "machine-readable identifier of the copy")
    .option("--json", "emit a flat JSON record")
    .option("--fields <list>", "comma-separated fields to show")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <id>", "override the profile default project")
    .action(async (reference: string, name: string, options: {
      identifier?: string;
    } & ScopeOptions) => {
      const identifier = requireIdentifier(options, "copy");
      const { getPage } = await connect(runtime, options);
      const profile = await runtime.resolve({
        profile: options.profile,
        project: parseOptionalId(options.project),
      });
      const hit = await resolveProjectRef(getPage, reference);
      const source = (await getPage(
        `${PROJECTS_COLLECTION}/${String(hit.id)}`,
      )) as Record<string, unknown>;
      const payload: Record<string, unknown> = { name, identifier };
      for (const attribute of ["description", "public", "active"] as const) {
        if (source[attribute] !== undefined) {
          payload[attribute] = source[attribute];
        }
      }
      const sourceLinks = source._links as
        | Record<string, { href?: string }>
        | undefined;
      const parentHref = sourceLinks?.parent?.href;
      if (parentHref !== undefined) {
        payload._links = { parent: { href: parentHref } };
      }
      const body = await projectWrite(
        () => apiPostRaw(profile.instanceUrl, profile.apiKey, PROJECTS_COLLECTION, payload),
        "copy",
      );
      renderRecord(runtime, options, flattenHalRecord(body));
    });

  // ---------------------------------------------------------------------------
  // project star / unstar

  project
    .command("star")
    .description("Mark one project as favourited for the current user")
    .argument("<reference>")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <id>", "override the profile default project")
    .action(async (reference: string, options: { profile?: string; project?: string }) => {
      const { getPage } = await connect(runtime, options);
      const profile = await runtime.resolve({
        profile: options.profile,
        project: parseOptionalId(options.project),
      });
      const hit = await resolveProjectRef(getPage, reference);
      await apiPost(
        profile.instanceUrl,
        profile.apiKey,
        `${PROJECTS_COLLECTION}/${String(hit.id)}/favorite`,
        {},
      );
      runtime.write(`Starred project ${hit.name} (${String(hit.id)}).\n`);
    });

  project
    .command("unstar")
    .description("Remove one project from the current user's favourites")
    .argument("<reference>")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <id>", "override the profile default project")
    .action(async (reference: string, options: { profile?: string; project?: string }) => {
      const { getPage } = await connect(runtime, options);
      const profile = await runtime.resolve({
        profile: options.profile,
        project: parseOptionalId(options.project),
      });
      const hit = await resolveProjectRef(getPage, reference);
      await apiDelete(
        profile.instanceUrl,
        profile.apiKey,
        `${PROJECTS_COLLECTION}/${String(hit.id)}/favorite`,
      );
      runtime.write(`Unstarred project ${hit.name} (${String(hit.id)}).\n`);
    });

  // ---------------------------------------------------------------------------
  // project versions / categories / types

  const vocabularyRuntime: Omit<CollectionRuntime, "connect"> = {
    write: runtime.write,
    writeErr: runtime.writeErr,
    setJsonMode: runtime.setJsonMode,
  };

  const registerVocabulary = (
    name: string,
    description: string,
    endpoint: (projectId: number) => string,
    columns: ReadonlyArray<CollectionColumn>,
  ): Command =>
    project
      .command(name)
      .description(description)
      .argument("<reference>", "project, by id, identifier, or name")
      .option("--json", "emit a flat JSON array")
      .option("--fields <list>", "comma-separated columns to show")
      .option("--profile <name>", "use this profile for this command only")
      .option("--project <id>", "override the profile default project")
      .action(async (reference: string, options: ScopeOptions) => {
        const { getPage } = await connect(runtime, options);
        const hit = await resolveProjectRef(getPage, reference);
        const startPath = withPageSize(
          endpoint(hit.id),
          DEFAULT_PAGE_SIZE,
        );
        const rows: Array<Record<string, unknown>> = [];
        for await (const element of halElements<unknown>(getPage, startPath)) {
          rows.push(flattenHalRecord(element));
        }
        emitRows(vocabularyRuntime, columns, rows, options);
      });

  registerVocabulary(
    "versions",
    "List the versions a work package in this project may use",
    (projectId) => `${PROJECTS_COLLECTION}/${String(projectId)}/versions`,
    VERSION_COLUMNS,
  );
  registerVocabulary(
    "categories",
    "List the categories a work package in this project may use",
    (projectId) => `${PROJECTS_COLLECTION}/${String(projectId)}/categories`,
    CATEGORY_COLUMNS,
  );
  registerVocabulary(
    "types",
    "List the work package types usable in this project",
    (projectId) => `${PROJECTS_COLLECTION}/${String(projectId)}/types`,
    TYPE_COLUMNS,
  );

  // ---------------------------------------------------------------------------
  // project member add / remove

  const member = project
    .command("member")
    .description("Manage the members of one project");

  member
    .command("add")
    .description("Grant one principal a membership with one or more roles")
    .argument("<reference>", "project, by id, identifier, or name")
    .argument("<principal>", "user or group, by name, id, or me")
    .argument("<role...>", "role or roles, by title or id")
    .option("--json", "emit a flat JSON record")
    .option("--fields <list>", "comma-separated fields to show")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <id>", "override the profile default project")
    .action(async (
      reference: string,
      principal: string,
      roles: Array<string>,
      options: ScopeOptions,
    ) => {
      runtime.setJsonMode(options.json === true);
      const { getPage } = await connect(runtime, options);
      const profile = await runtime.resolve({
        profile: options.profile,
        project: parseOptionalId(options.project),
      });
      const hit = await resolveProjectRef(getPage, reference);
      const principalId = await resolvePrincipalId(profile, principal);
      const roleIds = await resolveRoleIds(profile, roles);
      const payload = {
        _links: {
          project: { href: `${PROJECTS_COLLECTION}/${String(hit.id)}` },
          principal: { href: `${PRINCIPALS_COLLECTION}/${String(principalId)}` },
          roles: roleIds.map((roleId) => ({
            href: `${ROLES_COLLECTION}/${String(roleId)}`,
          })),
        },
      };
      const body = await projectWrite(
        () => apiPostRaw(
          profile.instanceUrl,
          profile.apiKey,
          MEMBERSHIPS_COLLECTION,
          payload,
        ),
        "member add",
      );
      renderRecord(runtime, options, flattenHalRecord(body));
    });

  member
    .command("remove")
    .description("Remove one principal's membership from the project")
    .argument("<reference>", "project, by id, identifier, or name")
    .argument("<principal>", "user or group, by name, id, or me")
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <id>", "override the profile default project")
    .action(async (reference: string, principal: string, options: {
      profile?: string;
      project?: string;
    }) => {
      const { getPage } = await connect(runtime, options);
      const profile = await runtime.resolve({
        profile: options.profile,
        project: parseOptionalId(options.project),
      });
      const hit = await resolveProjectRef(getPage, reference);
      const principalId = await resolvePrincipalId(profile, principal);
      // One membership per (project, principal): filter both ends and
      // expect exactly one record back.
      const filters: Array<WpFilter> = [
        { name: "project", operator: "=", values: [String(hit.id)] },
        { name: "principal", operator: "=", values: [String(principalId)] },
      ];
      const page = await apiGet(
        profile.instanceUrl,
        profile.apiKey,
        withPageSize(
          `${MEMBERSHIPS_COLLECTION}?filters=${filtersQuery(filters)}`,
          DEFAULT_PAGE_SIZE,
        ),
      ) as { _embedded?: { elements?: readonly unknown[] } };
      const ids: Array<number> = [];
      for (const element of page._embedded?.elements ?? []) {
        if (
          typeof element === "object"
          && element !== null
          && typeof (element as Record<string, unknown>).id === "number"
        ) {
          ids.push((element as Record<string, unknown>).id as number);
        }
      }
      if (ids.length === 0) {
        throw new OpCliError(
          "NOT_FOUND",
          `"${principal}" is not a member of project ${hit.name} `
            + `(${String(hit.id)}).`,
          "run op-cli meta members to see the current members.",
        );
      }
      if (ids.length > 1) {
        throw new OpCliError(
          "API_ERROR",
          `the instance reports ${String(ids.length)} memberships for `
            + `"${principal}" in this project; refusing to guess.`,
          "report this to the instance administrator.",
        );
      }
      const membershipId = ids[0];
      if (membershipId === undefined) {
        throw new OpCliError("INTERNAL_ERROR");
      }
      await apiDelete(
        profile.instanceUrl,
        profile.apiKey,
        `${MEMBERSHIPS_COLLECTION}/${String(membershipId)}`,
      );
      runtime.write(
        `Removed membership ${String(membershipId)} from project `
          + `${hit.name} (${String(hit.id)}).\n`,
      );
    });

  // ---------------------------------------------------------------------------
  // project delete

  project
    .command("delete")
    .description("Delete one project after explicit confirmation")
    .argument("<reference>", "project, by id, identifier, or name")
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
          `project delete refuses to remove "${reference}" without confirmation; `
            + "deleting a project is irreversible.",
          "repeat the command with --yes to confirm the deletion.",
        );
      }
      const { getPage } = await connect(runtime, options);
      const profile = await runtime.resolve({
        profile: options.profile,
        project: parseOptionalId(options.project),
      });
      const hit = await resolveProjectRef(getPage, reference);
      await apiDelete(
        profile.instanceUrl,
        profile.apiKey,
        `${PROJECTS_COLLECTION}/${String(hit.id)}`,
      );
      runtime.write(`Deleted project ${hit.name} (${String(hit.id)}).\n`);
    });
}
