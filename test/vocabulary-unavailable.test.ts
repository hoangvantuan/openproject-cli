import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, expect, test } from "vitest";

import { run } from "../src/run.js";

// A user without the log-time permission in project 16 (#44): the
// time-entry form answers 403, every other vocabulary source answers.
const INSTANCE_URL = "https://openproject.example";
const PROJECT = 16;
const MEMBER_FILTERS = encodeURIComponent(
  JSON.stringify([{ project: { operator: "=", values: [String(PROJECT)] } }]),
);
const MISSING_PERMISSION = {
  _type: "Error",
  errorIdentifier: "urn:openproject-org:api:v3:errors:MissingPermission",
  message: "You are not authorized to access this resource.",
};

interface Reply {
  readonly status: number;
  readonly body?: unknown;
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

function workPackage(lockVersion: number): Record<string, unknown> {
  return {
    _type: "WorkPackage",
    id: 42,
    lockVersion,
    subject: "Ship the thing",
    createdAt: "2026-08-23T09:00:00Z",
    updatedAt: "2026-08-23T09:00:00Z",
    customField11: "2",
    _links: {
      self: { href: "/api/v3/work_packages/42" },
      project: { href: `/api/v3/projects/${String(PROJECT)}`, title: "Mobile" },
      type: { href: "/api/v3/types/2", title: "Task" },
      status: { href: "/api/v3/statuses/1", title: "New" },
      priority: { href: "/api/v3/priorities/3", title: "High" },
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
    [`GET /api/v3/projects/${String(PROJECT)}/versions`]: {
      status: 200,
      body: collection([{ _type: "Version", id: 9, name: "0.9.0", status: "open" }]),
    },
    [`GET /api/v3/projects/${String(PROJECT)}/categories`]: {
      status: 200,
      body: collection([{ _type: "Category", id: 4, name: "Billing" }]),
    },
    [`GET /api/v3/projects/${String(PROJECT)}/types`]: {
      status: 200,
      body: collection([{ _type: "Type", id: 2, name: "Task" }]),
    },
    [`POST /api/v3/projects/${String(PROJECT)}/work_packages/form`]: {
      status: 200,
      body: {
        _type: "Form",
        _embedded: {
          schema: {
            _type: "Schema",
            customField11: { type: "String", name: "Formula", required: false },
          },
        },
      },
    },
    "POST /api/v3/time_entries/form": { status: 403, body: MISSING_PERMISSION },
    "GET /api/v3/work_packages/42": { status: 200, body: workPackage(1) },
    "PATCH /api/v3/work_packages/42": { status: 200, body: workPackage(2) },
    "POST /api/v3/work_packages": { status: 201, body: workPackage(1) },
  };
}

let root: string;
let env: Record<string, string>;
let mockAgent: MockAgent;
let requests: Array<{ key: string; body: unknown }>;

/** Serves the routes table; anything unlisted answers 599 and is recorded. */
function install(overrides: Record<string, Reply> = {}): void {
  const table = { ...routes(), ...overrides };
  mockAgent.get(INSTANCE_URL)
    .intercept({ path: () => true, method: () => true })
    .reply((call) => {
      const key = `${call.method} ${call.path}`;
      requests.push({
        key,
        body: typeof call.body === "string" ? JSON.parse(call.body) as unknown : undefined,
      });
      const reply = table[key] ?? { status: 599, body: { unexpected: key } };
      return { statusCode: reply.status, data: reply.body ?? {} };
    })
    .persist();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "op-cli-unavailable-"));
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

async function storedVocabulary(): Promise<Record<string, unknown>> {
  const stored = JSON.parse(
    await readFile(join(root, "cache", "default", "metadata.json"), "utf8"),
  ) as { projectScoped: Record<string, Record<string, unknown>> };
  return stored.projectScoped[String(PROJECT)] as Record<string, unknown>;
}

test("a forbidden activity source leaves the other vocabularies usable", async () => {
  install();

  const result = await run(["meta", "versions", "--json"], env, {});

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([{ id: 9, name: "0.9.0", status: "open" }]);
  const vocabulary = await storedVocabulary();
  expect(vocabulary.activities).toEqual([]);
  expect(vocabulary.unavailable).toEqual({
    activities: { status: 403, message: expect.stringContaining("not authorized") as unknown },
  });
});

test("wp create --version resolves while activities are forbidden", async () => {
  install();

  const result = await run(
    ["wp", "create", "Ship the thing", "--type", "Task", "--version", "0.9.0", "--json"],
    env,
    {},
  );

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  const created = requests.find((entry) => entry.key === "POST /api/v3/work_packages");
  expect(created?.body).toMatchObject({
    _links: { version: { href: "/api/v3/versions/9" } },
  });
});

test("wp update --field resolves while activities are forbidden", async () => {
  install();

  const result = await run(
    ["wp", "update", "42", "--field", "Formula=5", "--json"],
    env,
    {},
  );

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  const patched = requests.find((entry) => entry.key === "PATCH /api/v3/work_packages/42");
  expect(patched?.body).toMatchObject({ customField11: "5" });
});

test("time log --activity names the unavailable vocabulary instead of blaming the login", async () => {
  install();

  const result = await run(
    ["time", "log", "42", "--hours", "1h", "--activity", "Development", "--json"],
    env,
    {},
  );

  expect(result.exitCode).toBe(8);
  const error = JSON.parse(result.stderr).error;
  expect(error.code).toBe("PERMISSION_DENIED");
  expect(error.message).toContain("activities");
  expect(error.message).toContain(String(PROJECT));
  expect(error.hint).not.toMatch(/auth login/);
  expect(requests.some((entry) => entry.key === "POST /api/v3/time_entries")).toBe(false);
});

test("meta activities reports the forbidden source rather than an empty list", async () => {
  install();

  const result = await run(["meta", "activities"], env, {});

  expect(result.exitCode).toBe(8);
  expect(result.stderr).toMatch(/^\[PERMISSION_DENIED\] .*activities/);
});

test("a missing category source is unavailable too, and only --category trips on it", async () => {
  install({
    [`GET /api/v3/projects/${String(PROJECT)}/categories`]: {
      status: 404,
      body: { _type: "Error", message: "The requested resource could not be found." },
    },
  });

  const listed = await run(["meta", "versions", "--json"], env, {});
  expect(listed.exitCode).toBe(0);
  const vocabulary = await storedVocabulary();
  expect(vocabulary.unavailable).toMatchObject({
    categories: { status: 404 },
    activities: { status: 403 },
  });

  const result = await run(
    ["wp", "create", "Ship the thing", "--type", "Task", "--category", "Billing"],
    env,
    {},
  );
  expect(result.exitCode).toBe(8);
  expect(result.stderr).toMatch(/^\[PERMISSION_DENIED\] .*categories/);
});

test("a server error on an optional source still fails the command", async () => {
  install({
    "POST /api/v3/time_entries/form": { status: 500, body: { _type: "Error" } },
  });

  const result = await run(["meta", "versions"], env, {});

  expect(result.exitCode).toBe(2);
  expect(result.stderr).toMatch(/^\[API_ERROR\]/);
});

test("meta show and meta refresh report the unavailable sources", async () => {
  install();
  expect((await run(["meta", "versions"], env, {})).exitCode).toBe(0);

  const shown = await run(["meta", "show"], env, {});
  expect(shown.exitCode).toBe(0);
  expect(shown.stdout).toMatch(/unavailable\s+project 16: activities \(403\)/);

  const refreshed = await run(["meta", "refresh"], env, {});
  expect(refreshed.stderr).toBe("");
  expect(refreshed.exitCode).toBe(0);
  expect(refreshed.stdout).toContain("unavailable: project 16 activities (403");

  const refreshedJson = await run(["meta", "refresh", "--json"], env, {});
  expect(refreshedJson.exitCode).toBe(0);
  expect(JSON.parse(refreshedJson.stdout).unavailable).toEqual([
    { project_id: PROJECT, source: "activities", status: 403, message: expect.any(String) as unknown },
  ]);
});

test("losing a source between refreshes reports the flip, not every entry removed", async () => {
  install({
    "POST /api/v3/time_entries/form": {
      status: 200,
      body: {
        _embedded: {
          schema: {
            activity: {
              _embedded: { allowedValues: [{ id: 5, name: "Development", default: true }] },
            },
          },
        },
      },
    },
  });
  expect((await run(["meta", "activities"], env, {})).exitCode).toBe(0);
  await mockAgent.close();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  install();

  const refreshed = await run(["meta", "refresh"], env, {});

  expect(refreshed.exitCode).toBe(0);
  expect(refreshed.stdout).toContain("activities: became unavailable in project 16 (403)");
  expect(refreshed.stdout).not.toContain("removed Development");
});
