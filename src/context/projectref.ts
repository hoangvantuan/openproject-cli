import { apiGet } from "../core/http.js";
import { OpCliError } from "../core/errors.js";
import {
  DEFAULT_PAGE_SIZE,
  halElements,
  halNextPath,
  withPageSize,
} from "../core/paginate.js";
import { isIdForm, rankByCloseness } from "./resolve.js";

type GetPage = (path: string) => Promise<unknown>;

/**
 * The collection paths a project resource links to (#57). Instances that
 * renamed projects to workspaces serve them under /api/v3/workspaces/, so
 * the linked path is followed instead of a hardcoded one. A key is absent
 * when the resource did not carry that link; callers then build the path.
 */
export interface ProjectLinks {
  readonly versions?: string;
  readonly categories?: string;
  readonly types?: string;
  readonly work_packages?: string;
  readonly create_work_package?: string;
  readonly memberships?: string;
}

/** Link name on the project resource to the key kept for it. */
const PROJECT_LINK_KEYS: ReadonlyArray<readonly [string, keyof ProjectLinks]> = [
  ["versions", "versions"],
  ["categories", "categories"],
  ["types", "types"],
  ["workPackages", "work_packages"],
  ["createWorkPackage", "create_work_package"],
  ["memberships", "memberships"],
];

/** The collection paths a project resource links to; undefined when it links none. */
export function projectLinksOf(project: unknown): ProjectLinks | undefined {
  const rawLinks = ((project as { readonly _links?: unknown })._links ?? {}) as
    Record<string, { readonly href?: unknown } | undefined>;
  const found: { -readonly [K in keyof ProjectLinks]?: string } = {};
  for (const [name, key] of PROJECT_LINK_KEYS) {
    const href = rawLinks[name]?.href;
    const path = typeof href === "string" ? halNextPath(href) : undefined;
    if (path !== undefined) {
      found[key] = path;
    }
  }
  return Object.keys(found).length === 0 ? undefined : found;
}

/**
 * One project a reference can resolve to. Every resolution goes through
 * this shape so ambiguity and suggestions speak in ids and names only.
 */
export interface ProjectHit {
  readonly id: number;
  readonly identifier: string;
  readonly name: string;
  /** The collection paths the resource linked, when it linked any. */
  readonly links?: ProjectLinks;
}

function linksField(element: unknown): { links?: ProjectLinks } {
  const links = projectLinksOf(element);
  return links === undefined ? {} : { links };
}

export function hitOf(element: unknown): ProjectHit | undefined {
  const candidate = element as {
    readonly id?: unknown;
    readonly identifier?: unknown;
    readonly name?: unknown;
  };
  return typeof candidate.id === "number"
    && typeof candidate.identifier === "string"
    && typeof candidate.name === "string"
    ? {
      id: candidate.id,
      identifier: candidate.identifier,
      name: candidate.name,
      ...linksField(element),
    }
    : undefined;
}

export const PROJECTS_COLLECTION = "/api/v3/projects";

/**
 * Every visible project, page by page in server order. Resolution walks
 * instead of filtering server-side because the exact-match filter set
 * differs between instance versions; the collection endpoint does not.
 */
export async function walkProjects(getPage: GetPage): Promise<Array<ProjectHit>> {
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
export async function resolveProjectRef(
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
 * The project half of a resolved profile: a numeric id passes through
 * untouched, a name or identifier resolves against the instance (#34).
 * Callers hand this the parsed `--project` value or OP_CLI_PROJECT, so
 * the fast path costs no traffic and only a name pays for the walk.
 */
export async function resolveProjectOverride(
  instanceUrl: string,
  apiKey: string,
  override: number | string,
): Promise<number> {
  if (typeof override === "number") {
    return override;
  }
  const hit = await resolveProjectRef(
    (path) => apiGet(instanceUrl, apiKey, path),
    override,
  );
  return hit.id;
}
