import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, expect, test } from "vitest";

import { run } from "../src/run.js";

// Sprints and backlog buckets as project vocabulary (#46): read from the
// project-scoped collections, written as single links on work packages,
// filterable on wp list/count.
const INSTANCE_URL = "https://openproject.example";
const PROJECT = 16;
const MEMBER_FILTERS = encodeURIComponent(
  JSON.stringify([{ project: { operator: "=", values: [String(PROJECT)] } }]),
);
const NOT_FOUND = {
  _type: "Error",
  errorIdentifier: "urn:openproject-org:api:v3:errors:NotFound",
  message: "The requested resource could not be found.",
};

interface Reply {
  readonly status: number;
  readonly body?: unknown;
  /** Answers given once each before this reply, in order. */
  readonly first?: Array<Reply>;
}

function collection(elements: unknown[]): Record<string, unknown> {
  return {
    _type: "Collection",
    total: elements.length,
    count: elements.length,
    _embedded: { elements },
    _links: { self: { href: "/self" } },
  };
}

function sprint(
  id: number,
  name: string,
  status: string,
  startDate: string,
  finishDate: string,
): Record<string, unknown> {
  return {
    _type: "Sprint",
    id,
    name,
    startDate,
    finishDate,
    startedAt: null,
    completedAt: null,
    _links: {
      self: { href: `/api/v3/sprints/${String(id)}`, title: name },
      // The title is localized; the urn tail is what the store keeps.
      status: { href: `urn:openproject-org:api:v3:sprints:status:${status}`, title: "計画中" },
      definingWorkspace: { href: `/api/v3/projects/${String(PROJECT)}`, title: "Mobile" },
    },
  };
}

function bucket(id: number, name: string): Record<string, unknown> {
  return {
    _type: "BacklogBucket",
    id,
    name,
    _links: {
      self: { href: `/api/v3/backlog_buckets/${String(id)}`, title: name },
      definingWorkspace: { href: `/api/v3/projects/${String(PROJECT)}`, title: "Mobile" },
    },
  };
}

const SPRINTS = [
  sprint(58, "Sprint 14", "in_planning", "2026-10-26", "2026-10-30"),
  sprint(57, "Sprint 13", "active", "2026-10-19", "2026-10-23"),
];
const BUCKETS = [bucket(2, "Managements"), bucket(4, "PoC")];

function workPackage(lockVersion: number): Record<string, unknown> {
  return {
    _type: "WorkPackage",
    id: 42,
    lockVersion,
    subject: "Ship the thing",
    createdAt: "2026-08-23T09:00:00Z",
    updatedAt: "2026-08-23T09:00:00Z",
    _links: {
      self: { href: "/api/v3/work_packages/42" },
      project: { href: `/api/v3/projects/${String(PROJECT)}`, title: "Mobile" },
      type: { href: "/api/v3/types/2", title: "Task" },
      status: { href: "/api/v3/statuses/1", title: "New" },
      priority: { href: "/api/v3/priorities/3", title: "High" },
      sprint: { href: null },
      backlogBucket: { href: null },
    },
  };
}

function routes(): Record<string, Reply> {
  return {
    "GET /api/v3/": { status: 200, body: { _type: "Root", apiVersion: "3", coreVersion: "17.0.0" } },
    "GET /api/v3/types": {
      status: 200,
      body: collection([{ _type: "Type", id: 2, name: "Task", isMilestone: false }]),
    },
    "GET /api/v3/statuses": {
      status: 200,
      body: collection([{ _type: "Status", id: 1, name: "New", isClosed: false, isDefault: true }]),
    },
    "GET /api/v3/priorities": {
      status: 200,
      body: collection([{ _type: "Priority", id: 3, name: "High", isDefault: true }]),
    },
    [`GET /api/v3/projects/${String(PROJECT)}`]: {
      status: 200,
      body: { _type: "Project", id: PROJECT, identifier: "mobile", name: "Mobile" },
    },
    [`GET /api/v3/memberships?filters=${MEMBER_FILTERS}`]: { status: 200, body: collection([]) },
    [`GET /api/v3/projects/${String(PROJECT)}/versions`]: { status: 200, body: collection([]) },
    [`GET /api/v3/projects/${String(PROJECT)}/categories`]: { status: 200, body: collection([]) },
    [`GET /api/v3/projects/${String(PROJECT)}/sprints`]: { status: 200, body: collection(SPRINTS) },
    [`GET /api/v3/projects/${String(PROJECT)}/backlog_buckets`]: {
      status: 200,
      body: collection(BUCKETS),
    },
    // A 404 on the projects path retries here once (#57); this instance
    // has no such route.
    [`GET /api/v3/workspaces/${String(PROJECT)}/sprints`]: { status: 404, body: NOT_FOUND },
    [`GET /api/v3/workspaces/${String(PROJECT)}/backlog_buckets`]: { status: 404, body: NOT_FOUND },
    [`GET /api/v3/projects/${String(PROJECT)}/types`]: {
      status: 200,
      body: collection([{ _type: "Type", id: 2, name: "Task" }]),
    },
    [`POST /api/v3/projects/${String(PROJECT)}/work_packages/form`]: {
      status: 200,
      body: { _type: "Form", _embedded: { schema: { _type: "Schema" } } },
    },
    "POST /api/v3/time_entries/form": { status: 200, body: { _embedded: { schema: {} } } },
    "GET /api/v3/work_packages/42": { status: 200, body: workPackage(1) },
    "PATCH /api/v3/work_packages/42": { status: 200, body: workPackage(2) },
    "POST /api/v3/work_packages": { status: 201, body: workPackage(1) },
  };
}

let root: string;
let env: Record<string, string>;
let mockAgent: MockAgent;
let requests: Array<{ key: string; body: unknown }>;
let table: Record<string, Reply>;

/** Serves the routes table; anything unlisted answers 599 and is recorded. */
function install(overrides: Record<string, Reply> = {}): void {
  table = { ...routes(), ...overrides };
  mockAgent.get(INSTANCE_URL)
    .intercept({ path: () => true, method: () => true })
    .reply((call) => {
      const key = `${call.method} ${call.path}`;
      requests.push({
        key,
        body: typeof call.body === "string" ? JSON.parse(call.body) as unknown : undefined,
      });
      const listing = /^GET \/api\/v3\/((projects|workspaces)\/\d+\/)?work_packages\?/.test(key)
        ? { status: 200, body: collection([]) }
        : undefined;
      const entry = table[key];
      const reply = entry?.first?.shift() ?? entry ?? listing
        ?? { status: 599, body: { unexpected: key } };
      return { statusCode: reply.status, data: reply.body ?? {} };
    })
    .persist();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "op-cli-sprint-"));
  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      default_profile: "default",
      profiles: { default: { url: INSTANCE_URL, project: PROJECT } },
    }),
  );
  await writeFile(
    join(configDir, "credentials.json"),
    JSON.stringify({ default: { api_key: "secret-key" } }),
    { mode: 0o600 },
  );
  env = { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: join(root, "cache") };
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  requests = [];
});

afterEach(async () => {
  await mockAgent.close();
  setGlobalDispatcher(new Agent());
  await rm(root, { recursive: true, force: true });
});

function storePath(): string {
  return join(root, "cache", "default", "metadata.json");
}

async function storedVocabulary(): Promise<Record<string, unknown>> {
  const stored = JSON.parse(await readFile(storePath(), "utf8")) as {
    projectScoped: Record<string, Record<string, unknown>>;
  };
  return stored.projectScoped[String(PROJECT)] as Record<string, unknown>;
}

function sent(key: string): unknown {
  return requests.find((entry) => entry.key === key)?.body;
}

// ---------------------------------------------------------------------------
// Vocabulary

test("the project vocabulary stores sprints and buckets sorted by name", async () => {
  install();

  const result = await run(["meta", "sprints", "--json"], env, {});

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  const vocabulary = await storedVocabulary();
  expect(vocabulary.sprints).toEqual([
    { id: 57, name: "Sprint 13", start_date: "2026-10-19", finish_date: "2026-10-23", status: "active" },
    { id: 58, name: "Sprint 14", start_date: "2026-10-26", finish_date: "2026-10-30", status: "in_planning" },
  ]);
  expect(vocabulary.buckets).toEqual([
    { id: 2, name: "Managements" },
    { id: 4, name: "PoC" },
  ]);
  expect(vocabulary.unavailable).toBeUndefined();
});

test("meta sprints and meta buckets list the stored vocabulary", async () => {
  install();

  const sprints = await run(["meta", "sprints"], env, {});
  expect(sprints.stderr).toBe("");
  expect(sprints.exitCode).toBe(0);
  expect(sprints.stdout).toMatch(/ID\s+NAME\s+START\s+FINISH\s+STATUS/);
  expect(sprints.stdout).toMatch(/58\s+Sprint 14\s+2026-10-26\s+2026-10-30\s+in_planning/);

  const buckets = await run(["meta", "buckets", "--json"], env, {});
  expect(buckets.exitCode).toBe(0);
  expect(JSON.parse(buckets.stdout)).toEqual([
    { id: 2, name: "Managements" },
    { id: 4, name: "PoC" },
  ]);
});

test("a project without the backlogs module stores both sources as unavailable", async () => {
  install({
    [`GET /api/v3/projects/${String(PROJECT)}/sprints`]: { status: 404, body: NOT_FOUND },
    [`GET /api/v3/projects/${String(PROJECT)}/backlog_buckets`]: { status: 404, body: NOT_FOUND },
  });

  const versions = await run(["meta", "versions"], env, {});
  expect(versions.exitCode).toBe(0);
  const vocabulary = await storedVocabulary();
  expect(vocabulary.sprints).toEqual([]);
  expect(vocabulary.unavailable).toMatchObject({
    sprints: { status: 404 },
    buckets: { status: 404 },
  });

  const sprints = await run(["meta", "sprints"], env, {});
  expect(sprints.exitCode).toBe(8);
  expect(sprints.stderr).toMatch(/^\[PERMISSION_DENIED\] .*sprints of project 16/);
});

test("a forbidden sprint source is unavailable with its 403", async () => {
  install({
    [`GET /api/v3/projects/${String(PROJECT)}/sprints`]: {
      status: 403,
      body: { _type: "Error", message: "You are not authorized to access this resource." },
    },
  });

  expect((await run(["meta", "buckets"], env, {})).exitCode).toBe(0);
  const vocabulary = await storedVocabulary();
  expect(vocabulary.unavailable).toEqual({
    sprints: { status: 403, message: expect.stringContaining("not authorized") as unknown },
  });
});

test("meta refresh diffs sprints and buckets", async () => {
  install();
  expect((await run(["meta", "sprints"], env, {})).exitCode).toBe(0);
  table[`GET /api/v3/projects/${String(PROJECT)}/sprints`] = {
    status: 200,
    body: collection([
      SPRINTS[0],
      sprint(59, "Sprint 15", "in_planning", "2026-11-02", "2026-11-06"),
    ]),
  };
  table[`GET /api/v3/projects/${String(PROJECT)}/backlog_buckets`] = {
    status: 200,
    body: collection([bucket(2, "Management")]),
  };

  const refreshed = await run(["meta", "refresh", "--json"], env, {});

  expect(refreshed.stderr).toBe("");
  expect(refreshed.exitCode).toBe(0);
  const changes = JSON.parse(refreshed.stdout).changes as Array<Record<string, unknown>>;
  expect(changes).toEqual(expect.arrayContaining([
    { section: "sprints", kind: "added", id: 59, detail: "added Sprint 15 (59)" },
    { section: "sprints", kind: "removed", id: 57, detail: "removed Sprint 13 (57)" },
    {
      section: "buckets",
      kind: "changed",
      id: 2,
      detail: "name: Managements -> Management (2)",
    },
    { section: "buckets", kind: "removed", id: 4, detail: "removed PoC (4)" },
  ]));
});

// ---------------------------------------------------------------------------
// wp list / count filters

/** The filter clauses of the last work package listing, decoded. */
function listedFilters(): unknown {
  const listing = [...requests].reverse()
    .find((entry) => entry.key.startsWith("GET /api/v3/work_packages?"));
  const query = new URLSearchParams((listing?.key ?? "").split("?")[1]);
  return JSON.parse(query.get("filters") ?? "null") as unknown;
}

const PROJECT_CLAUSE = { project: { operator: "=", values: [String(PROJECT)] } };

test("wp list --sprint resolves names and ids into one sprint clause", async () => {
  install();

  const result = await run(
    ["wp", "list", "--sprint", "Sprint 14", "--sprint", "57", "--json"],
    env,
    {},
  );

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(listedFilters()).toEqual([
    PROJECT_CLAUSE,
    { sprint: { operator: "=", values: ["58", "57"] } },
  ]);
});

test("wp count --bucket and --backlog-inbox build their clauses", async () => {
  install();

  const bucketed = await run(["wp", "count", "--bucket", "PoC"], env, {});
  expect(bucketed.stderr).toBe("");
  expect(bucketed.exitCode).toBe(0);
  expect(listedFilters()).toEqual([
    PROJECT_CLAUSE,
    { backlogBucket: { operator: "=", values: ["4"] } },
  ]);

  const inbox = await run(["wp", "count", "--backlog-inbox"], env, {});
  expect(inbox.exitCode).toBe(0);
  expect(listedFilters()).toEqual([
    PROJECT_CLAUSE,
    { backlogInbox: { operator: "=", values: ["t"] } },
  ]);
});

test("the backlog inbox flag is --backlog-inbox, apart from the notification inbox", async () => {
  install();

  const help = await run(["wp", "list", "--help"], env, {});
  expect(help.stdout).toContain("--backlog-inbox");
  expect(help.stdout).not.toMatch(/--inbox\b/);

  const old = await run(["wp", "list", "--inbox"], env, {});
  expect(old.exitCode).not.toBe(0);
  expect(requests).toEqual([]);
});

test("wp list refuses --sprint with --backlog-inbox before any traffic", async () => {
  install();

  const result = await run(["wp", "list", "--sprint", "58", "--backlog-inbox"], env, {});

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/^\[USAGE_ERROR\] --sprint and --backlog-inbox cannot be combined/);
  expect(requests).toEqual([]);
});

test("an unknown sprint name lists the valid ones", async () => {
  install();

  const result = await run(["wp", "list", "--sprint", "Sprint 41"], env, {});

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('sprint "Sprint 41" not found');
  expect(result.stderr).toContain("Sprint 14");
});

test("a project without sprints says so, naming the project", async () => {
  install({
    [`GET /api/v3/projects/${String(PROJECT)}/sprints`]: { status: 200, body: collection([]) },
  });

  const result = await run(["wp", "list", "--sprint", "Sprint 14"], env, {});

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/^\[USAGE_ERROR\] .*project 16 has no sprints/);
  // The empty list was re-read once before giving up.
  expect(requests.filter((entry) =>
    entry.key === `GET /api/v3/projects/${String(PROJECT)}/sprints`)).toHaveLength(2);
});

test("an unavailable bucket source fails --bucket with PERMISSION_DENIED", async () => {
  install({
    [`GET /api/v3/projects/${String(PROJECT)}/backlog_buckets`]: { status: 404, body: NOT_FOUND },
  });

  const result = await run(["wp", "count", "--bucket", "PoC"], env, {});

  expect(result.exitCode).toBe(8);
  expect(result.stderr).toMatch(/^\[PERMISSION_DENIED\] The buckets of project 16 are unavailable/);
});

test("a vocabulary stored before #46 is refreshed once for --sprint", async () => {
  install();
  expect((await run(["meta", "versions"], env, {})).exitCode).toBe(0);
  const stored = JSON.parse(await readFile(storePath(), "utf8")) as {
    projectScoped: Record<string, Record<string, unknown>>;
  };
  const legacy = stored.projectScoped[String(PROJECT)] as Record<string, unknown>;
  delete legacy.sprints;
  delete legacy.buckets;
  await writeFile(storePath(), JSON.stringify(stored));
  requests = [];

  const result = await run(["wp", "list", "--sprint", "Sprint 14"], env, {});

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(listedFilters()).toEqual([
    PROJECT_CLAUSE,
    { sprint: { operator: "=", values: ["58"] } },
  ]);
  expect((await storedVocabulary()).sprints).toHaveLength(2);
  // Only this project's vocabulary is re-read, not the instance-wide lists.
  expect(requests.map((entry) => entry.key)).not.toContain("GET /api/v3/types");
});

test("meta sprints refreshes a vocabulary stored before #46 for that project only", async () => {
  install();
  expect((await run(["meta", "versions"], env, {})).exitCode).toBe(0);
  const stored = JSON.parse(await readFile(storePath(), "utf8")) as {
    projectScoped: Record<string, Record<string, unknown>>;
  };
  delete (stored.projectScoped[String(PROJECT)] as Record<string, unknown>).sprints;
  await writeFile(storePath(), JSON.stringify(stored));
  requests = [];

  const result = await run(["meta", "sprints"], env, {});

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Sprint 14");
  expect(requests.map((entry) => entry.key)).not.toContain("GET /api/v3/types");
});

test("a project that has no sprints does not re-read the instance-wide lists", async () => {
  install({
    [`GET /api/v3/projects/${String(PROJECT)}/sprints`]: { status: 200, body: collection([]) },
  });
  expect((await run(["meta", "versions"], env, {})).exitCode).toBe(0);
  requests = [];

  const result = await run(["wp", "list", "--sprint", "Sprint 14"], env, {});

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/project 16 has no sprints/);
  const keys = requests.map((entry) => entry.key);
  expect(keys).not.toContain("GET /api/v3/types");
  expect(keys).not.toContain("GET /api/v3/statuses");
  expect(keys.filter((key) => key.endsWith("/sprints"))).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Ambiguity: the same sprint name from two defining workspaces

const SHARED_SPRINTS = [
  sprint(58, "Sprint 14", "in_planning", "2026-10-26", "2026-10-30"),
  sprint(61, "Sprint 14", "active", "2026-10-26", "2026-10-30"),
];

test("wp update --sprint refuses a name two sprints share, listing both ids", async () => {
  install({
    [`GET /api/v3/projects/${String(PROJECT)}/sprints`]: {
      status: 200,
      body: collection(SHARED_SPRINTS),
    },
  });

  const result = await run(["wp", "update", "42", "--sprint", "Sprint 14"], env, {});

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/^\[USAGE_ERROR\] sprint "Sprint 14" is ambiguous\./);
  expect(result.stderr).toContain("58");
  expect(result.stderr).toContain("61");
  expect(requests.map((entry) => entry.key)).not.toContain("PATCH /api/v3/work_packages/42");
});

test("wp list --sprint refuses a name two sprints share, listing both ids", async () => {
  install({
    [`GET /api/v3/projects/${String(PROJECT)}/sprints`]: {
      status: 200,
      body: collection(SHARED_SPRINTS),
    },
  });

  const result = await run(["wp", "list", "--sprint", "Sprint 14"], env, {});

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/^\[USAGE_ERROR\] sprint "Sprint 14" is ambiguous\./);
  expect(result.stderr).toContain("58");
  expect(result.stderr).toContain("61");

  // The id form is the way out.
  requests = [];
  const byId = await run(["wp", "list", "--sprint", "61", "--json"], env, {});
  expect(byId.exitCode).toBe(0);
});

// ---------------------------------------------------------------------------
// wp create / update / bulk

function linksSent(key: string): Record<string, unknown> {
  return (sent(key) as { _links: Record<string, unknown> })._links;
}

test("wp create --sprint and --bucket write their single links", async () => {
  install();

  const sprinted = await run(
    ["wp", "create", "Ship the thing", "--sprint", "Sprint 14", "--json"],
    env,
    {},
  );
  expect(sprinted.stderr).toBe("");
  expect(sprinted.exitCode).toBe(0);
  expect(linksSent("POST /api/v3/work_packages")).toMatchObject({
    sprint: { href: "/api/v3/sprints/58" },
  });

  requests = [];
  const bucketed = await run(["wp", "create", "Ship the thing", "--bucket", "4"], env, {});
  expect(bucketed.exitCode).toBe(0);
  const links = linksSent("POST /api/v3/work_packages");
  expect(links.backlogBucket).toEqual({ href: "/api/v3/backlog_buckets/4" });
  expect(links.sprint).toBeUndefined();
});

test("wp update --sprint moves the work package and \"\" clears it", async () => {
  install();

  const moved = await run(["wp", "update", "42", "--sprint", "Sprint 13", "--json"], env, {});
  expect(moved.stderr).toBe("");
  expect(moved.exitCode).toBe(0);
  expect(linksSent("PATCH /api/v3/work_packages/42")).toEqual({
    sprint: { href: "/api/v3/sprints/57" },
  });

  requests = [];
  const cleared = await run(["wp", "update", "42", "--bucket", "", "--json"], env, {});
  expect(cleared.exitCode).toBe(0);
  expect(linksSent("PATCH /api/v3/work_packages/42")).toEqual({
    backlogBucket: { href: null },
  });
});

test("--sprint with --bucket is refused before any traffic", async () => {
  install();

  for (const argv of [
    ["wp", "create", "Ship the thing", "--sprint", "58", "--bucket", "4"],
    ["wp", "update", "42", "--sprint", "", "--bucket", "PoC"],
  ]) {
    const result = await run(argv, env, {});
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^\[USAGE_ERROR\] --sprint and --bucket cannot be combined/);
  }
  expect(requests).toEqual([]);
});

test("wp create refuses an empty --sprint: nothing to clear", async () => {
  install();

  const result = await run(["wp", "create", "Ship the thing", "--sprint", ""], env, {});

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/^\[USAGE_ERROR\] --sprint cannot be empty on create/);
  expect(requests).toEqual([]);
});

test("wp create --stdin takes sprint and bucket keys and refuses both on one item", async () => {
  install();

  const result = await run(
    ["wp", "create", "--stdin"],
    env,
    {
      readStdin: async () => JSON.stringify([
        { subject: "A", sprint: "Sprint 14" },
        { subject: "B", bucket: "PoC" },
        { subject: "C", sprint: "58", bucket: "4" },
      ]),
    },
  );

  const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(lines[0]).toMatchObject({ index: 0, ok: true });
  expect(lines[1]).toMatchObject({ index: 1, ok: true });
  expect(lines[2]).toMatchObject({ index: 2, ok: false, code: "USAGE_ERROR" });
  expect(String(lines[2]?.message)).toMatch(/^input 2: .*sprint.*bucket/);
  const posted = requests
    .filter((entry) => entry.key === "POST /api/v3/work_packages")
    .map((entry) => (entry.body as { _links: Record<string, unknown> })._links);
  expect(posted).toEqual([
    expect.objectContaining({ sprint: { href: "/api/v3/sprints/58" } }),
    expect.objectContaining({ backlogBucket: { href: "/api/v3/backlog_buckets/4" } }),
  ]);
  expect(result.exitCode).toBe(1);
});

test("a stale sprint id is retried once after a refresh moves it", async () => {
  install();
  expect((await run(["meta", "sprints"], env, {})).exitCode).toBe(0);
  table[`GET /api/v3/projects/${String(PROJECT)}/sprints`] = {
    status: 200,
    body: collection([sprint(60, "Sprint 14", "in_planning", "2026-10-26", "2026-10-30")]),
  };
  table["POST /api/v3/work_packages"] = {
    status: 201,
    body: workPackage(1),
    first: [{
      status: 422,
      body: {
        _type: "Error",
        errorIdentifier: "urn:openproject-org:api:v3:errors:PropertyConstraintViolation",
        message: "Sprint is invalid.",
        _embedded: { details: { attribute: "sprint" } },
      },
    }],
  };
  requests = [];

  const result = await run(["wp", "create", "Ship the thing", "--sprint", "Sprint 14"], env, {});

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  const posts = requests
    .filter((entry) => entry.key === "POST /api/v3/work_packages")
    .map((entry) => (entry.body as { _links: Record<string, unknown> })._links.sprint);
  expect(posts).toEqual([
    { href: "/api/v3/sprints/58" },
    { href: "/api/v3/sprints/60" },
  ]);
});

// ---------------------------------------------------------------------------
// Links over paths (#57): the project resource says where its collections
// live (OpenProject 17 moved them under /workspaces/).

const WORKSPACE = `/api/v3/workspaces/${String(PROJECT)}`;

/** The project resource as a workspace-aware instance serves it. */
function linkedProject(): Reply {
  return {
    status: 200,
    body: {
      _type: "Project",
      id: PROJECT,
      identifier: "mobile",
      name: "Mobile",
      _links: {
        self: { href: `/api/v3/projects/${String(PROJECT)}` },
        versions: { href: `${WORKSPACE}/versions` },
        categories: { href: `${WORKSPACE}/categories` },
        types: { href: `${WORKSPACE}/types` },
        workPackages: { href: `${WORKSPACE}/work_packages` },
        createWorkPackage: { href: `${WORKSPACE}/work_packages/form` },
        memberships: { href: `/api/v3/memberships?filters=${MEMBER_FILTERS}&via=link` },
      },
    },
  };
}

function workspaceCollections(): Record<string, Reply> {
  return {
    [`GET ${WORKSPACE}/versions`]: { status: 200, body: collection([]) },
    [`GET ${WORKSPACE}/categories`]: { status: 200, body: collection([]) },
    [`GET ${WORKSPACE}/types`]: {
      status: 200,
      body: collection([{ _type: "Type", id: 2, name: "Task" }]),
    },
    [`POST ${WORKSPACE}/work_packages/form`]: {
      status: 200,
      body: { _type: "Form", _embedded: { schema: { _type: "Schema" } } },
    },
    [`GET /api/v3/memberships?filters=${MEMBER_FILTERS}&via=link`]: {
      status: 200,
      body: collection([]),
    },
  };
}

function requested(key: string): number {
  return requests.filter((entry) => entry.key === key).length;
}

test("the vocabulary follows the project's links instead of building paths", async () => {
  install({
    [`GET /api/v3/projects/${String(PROJECT)}`]: linkedProject(),
    ...workspaceCollections(),
  });

  expect((await run(["meta", "versions"], env, {})).exitCode).toBe(0);
  for (const key of Object.keys(workspaceCollections())) {
    expect(requested(key), key).toBe(1);
  }
  const built = requests.map((entry) => entry.key).filter((key) =>
    /\/api\/v3\/projects\/\d+\/(versions|categories|types|work_packages)/.test(key));
  expect(built).toEqual([]);
});

test("the links are stored with the vocabulary and reused without another request", async () => {
  install({
    [`GET /api/v3/projects/${String(PROJECT)}`]: linkedProject(),
    ...workspaceCollections(),
  });
  expect((await run(["meta", "versions"], env, {})).exitCode).toBe(0);
  expect((await storedVocabulary()).links).toEqual({
    versions: `${WORKSPACE}/versions`,
    categories: `${WORKSPACE}/categories`,
    types: `${WORKSPACE}/types`,
    work_packages: `${WORKSPACE}/work_packages`,
    create_work_package: `${WORKSPACE}/work_packages/form`,
    memberships: `/api/v3/memberships?filters=${MEMBER_FILTERS}&via=link`,
  });
  const before = requests.length;
  expect((await run(["meta", "categories"], env, {})).exitCode).toBe(0);
  expect(requests.length).toBe(before);
});

test("a project resource without links falls back to the projects paths", async () => {
  install();

  expect((await run(["meta", "versions"], env, {})).exitCode).toBe(0);
  for (const collectionName of ["versions", "categories", "types"]) {
    expect(requested(`GET /api/v3/projects/${String(PROJECT)}/${collectionName}`)).toBe(1);
  }
  expect(requested(`POST /api/v3/projects/${String(PROJECT)}/work_packages/form`)).toBe(1);
  expect((await storedVocabulary()).links).toBeUndefined();
});

test("wp list --no-include-subprojects reads the stored workPackages link", async () => {
  install({
    [`GET /api/v3/projects/${String(PROJECT)}`]: linkedProject(),
    ...workspaceCollections(),
  });
  expect((await run(["meta", "versions"], env, {})).exitCode).toBe(0);

  const listed = await run(["wp", "list", "--no-include-subprojects"], env, {});
  expect(listed.exitCode).toBe(0);
  const listing = requests.map((entry) => entry.key).find((key) =>
    key.startsWith(`GET ${WORKSPACE}/work_packages?`));
  expect(listing).toBeDefined();
});

test("wp list --no-include-subprojects without stored links keeps the projects path", async () => {
  install();
  const listed = await run(["wp", "list", "--no-include-subprojects"], env, {});
  expect(listed.exitCode).toBe(0);
  expect(requests.map((entry) => entry.key).some((key) =>
    key.startsWith(`GET /api/v3/projects/${String(PROJECT)}/work_packages?`))).toBe(true);
});

// Sprints and buckets carry no link on the project resource, so their path
// stays; a 404 there may mean the instance moved the route (#57).

test("sprints and buckets retry once under /workspaces/ on a 404", async () => {
  install({
    [`GET /api/v3/projects/${String(PROJECT)}/sprints`]: { status: 404, body: NOT_FOUND },
    [`GET /api/v3/projects/${String(PROJECT)}/backlog_buckets`]: { status: 404, body: NOT_FOUND },
    [`GET ${WORKSPACE}/sprints`]: { status: 200, body: collection(SPRINTS) },
    [`GET ${WORKSPACE}/backlog_buckets`]: { status: 200, body: collection(BUCKETS) },
  });

  expect((await run(["meta", "versions"], env, {})).exitCode).toBe(0);
  const vocabulary = await storedVocabulary();
  expect((vocabulary.sprints as Array<unknown>).length).toBe(2);
  expect((vocabulary.buckets as Array<unknown>).length).toBe(2);
  expect(vocabulary.unavailable).toBeUndefined();
});

test("a 404 on both paths is unavailable after exactly one retry", async () => {
  install({
    [`GET /api/v3/projects/${String(PROJECT)}/sprints`]: { status: 404, body: NOT_FOUND },
    [`GET /api/v3/projects/${String(PROJECT)}/backlog_buckets`]: { status: 404, body: NOT_FOUND },
    [`GET ${WORKSPACE}/sprints`]: { status: 404, body: NOT_FOUND },
    [`GET ${WORKSPACE}/backlog_buckets`]: { status: 404, body: NOT_FOUND },
  });

  expect((await run(["meta", "versions"], env, {})).exitCode).toBe(0);
  expect((await storedVocabulary()).unavailable).toMatchObject({
    sprints: { status: 404 },
    buckets: { status: 404 },
  });
  expect(requested(`GET /api/v3/projects/${String(PROJECT)}/sprints`)).toBe(1);
  expect(requested(`GET ${WORKSPACE}/sprints`)).toBe(1);
});

test("a 403 does not retry under /workspaces/", async () => {
  install({
    [`GET /api/v3/projects/${String(PROJECT)}/sprints`]: { status: 403, body: { _type: "Error" } },
  });

  expect((await run(["meta", "versions"], env, {})).exitCode).toBe(0);
  expect(requested(`GET ${WORKSPACE}/sprints`)).toBe(0);
});
