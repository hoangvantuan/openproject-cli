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
      const listing = key.startsWith("GET /api/v3/work_packages?")
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

test("wp count --bucket and --inbox build their clauses", async () => {
  install();

  const bucketed = await run(["wp", "count", "--bucket", "PoC"], env, {});
  expect(bucketed.stderr).toBe("");
  expect(bucketed.exitCode).toBe(0);
  expect(listedFilters()).toEqual([
    PROJECT_CLAUSE,
    { backlogBucket: { operator: "=", values: ["4"] } },
  ]);

  const inbox = await run(["wp", "count", "--inbox"], env, {});
  expect(inbox.exitCode).toBe(0);
  expect(listedFilters()).toEqual([
    PROJECT_CLAUSE,
    { backlogInbox: { operator: "=", values: ["t"] } },
  ]);
});

test("wp list refuses --sprint with --inbox before any traffic", async () => {
  install();

  const result = await run(["wp", "list", "--sprint", "58", "--inbox"], env, {});

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/^\[USAGE_ERROR\] --sprint and --inbox cannot be combined/);
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
