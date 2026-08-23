import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, test } from "vitest";

import { run } from "../src/run.js";
import type { RunIo } from "../src/run.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function makeTempRoom(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function writeSingleProfile(
  root: string,
  instanceUrl: string,
  project?: number,
): Promise<{ configDir: string; cacheDir: string }> {
  const configDir = join(root, "config");
  const cacheDir = join(root, "cache");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      default_profile: "default",
      active_profile: "default",
      profiles: {
        default:
          project === undefined ? { url: instanceUrl } : { url: instanceUrl, project },
      },
    }),
  );
  await writeFile(
    join(configDir, "credentials.json"),
    JSON.stringify({ default: { api_key: "secret-key" } }),
    { mode: 0o600 },
  );
  return { configDir, cacheDir };
}

const INSTANCE = "https://op.example.dev";

function baseMetadata(
  statuses?: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    types: [
      { id: 2, name: "Task", is_milestone: false },
      { id: 6, name: "Bug", is_milestone: false },
    ],
    statuses:
      statuses
        ?? [
          { id: 1, name: "In progress", is_closed: false, is_default: true },
          { id: 5, name: "Closed", is_closed: true, is_default: false },
        ],
    priorities: [
      { id: 3, name: "High", is_default: false },
      { id: 4, name: "Low", is_default: false },
    ],
    instance: {
      url: INSTANCE,
      api_version: "v3",
      core_version: "13.4",
      fetched_at: "2026-08-23T00:00:00Z",
    },
  };
}

const PROJECT_VOCABULARY = {
  project_id: 13,
  fetched_at: "2026-08-23T00:00:00Z",
  members: [
    { membership_id: 1, user_id: 7, name: "Linh Nguyen", type: "User", roles: [] },
  ],
  versions: [{ id: 31, name: "0.9.0", status: "open" }],
  categories: [{ id: 44, name: "Billing" }],
  activities: [],
  custom_fields: {
    "2": [
      { key: "customField8", id: 8, name: "Estimate" },
    ],
    "6": [],
  },
};

async function writeMetadataFile(
  cacheDir: string,
  metadata: unknown,
): Promise<void> {
  const dir = join(cacheDir, "default");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "metadata.json"), JSON.stringify(metadata));
}

function scopedMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return { ...metadata, projectScoped: { "13": PROJECT_VOCABULARY } };
}

interface PostReply {
  readonly status: number;
  readonly body?: unknown;
}

/**
 * Installs exactly the endpoints listed; any other request fails the run
 * (net connect disabled), so a green assertion proves the traffic that did
 * happen is all the traffic there was. GETs persist and count their hits;
 * POSTs are consumed once each, in order.
 */
function installMockApi(options: {
  gets?: Record<string, unknown>;
  posts?: ReadonlyArray<PostReply>;
}): {
  getHits: (path: string) => number;
  postCount: () => number;
  postBodies: Array<Record<string, unknown>>;
} {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  cleanups.push(async () => {
    await mockAgent.close();
    setGlobalDispatcher(new Agent());
  });
  const pool = mockAgent.get(INSTANCE);
  const hits: Record<string, number> = {};
  const postBodies: Array<Record<string, unknown>> = [];
  for (const [path, body] of Object.entries(options.gets ?? {})) {
    pool.intercept({ path, method: "GET" }).reply(() => {
      hits[path] = (hits[path] ?? 0) + 1;
      return { statusCode: 200, data: body };
    }).persist();
  }
  for (const next of options.posts ?? []) {
    pool.intercept({ path: "/api/v3/work_packages", method: "POST" }).reply(
      (call) => {
        postBodies.push(JSON.parse(String(call.body)) as Record<string, unknown>);
        return { statusCode: next.status, data: next.body ?? {} };
      },
    );
  }
  return {
    getHits: (path) => hits[path] ?? 0,
    postCount: () => postBodies.length,
    postBodies,
  };
}

function createdElement(id: number, subject: string): Record<string, unknown> {
  return {
    _type: "WorkPackage",
    id,
    lockVersion: 1,
    subject,
    getHits: (path) => hits[path] ?? 0,
    updatedAt: "2026-08-23T09:00:00Z",
    _links: {
      self: { href: `/api/v3/work_packages/${String(id)}` },
      project: { href: "/api/v3/projects/13", title: "Operations" },
      type: { href: "/api/v3/types/2", title: "Task" },
      status: { href: "/api/v3/statuses/1", title: "In progress" },
    },
  };
}

/** Instance-level endpoints one metadata refresh touches. */
function refreshEndpoints(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    "/api/v3/types": {
      _type: "Collection",
      total: (metadata.types as unknown[]).length,
      count: (metadata.types as unknown[]).length,
      _embedded: { elements: metadata.types },
    },
    "/api/v3/statuses": {
      _type: "Collection",
      total: (metadata.statuses as unknown[]).length,
      count: (metadata.statuses as unknown[]).length,
      _embedded: { elements: metadata.statuses },
    },
    "/api/v3/priorities": {
      _type: "Collection",
      total: (metadata.priorities as unknown[]).length,
      count: (metadata.priorities as unknown[]).length,
      _embedded: { elements: metadata.priorities },
    },
    "/api/v3/projects/13": {
      _type: "Project",
      id: 13,
      identifier: "operations",
      name: "Operations",
    },
    "/api/v3/": {},
  };
}

function ndjsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout.split("\n").filter((line) => line !== "").map((line) =>
    JSON.parse(line) as Record<string, unknown>
  );
}

async function runWpStdin(
  configDir: string,
  cacheDir: string,
  args: ReadonlyArray<string>,
  stdin: string,
  io: RunIo = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return run(
    ["wp", "create", ...args],
    { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
    { ...io, readStdin: async () => stdin },
  );
}

async function room(): Promise<{
  configDir: string;
  cacheDir: string;
}> {
  const root = await makeTempRoom("wp-create-stdin-");
  return writeSingleProfile(root, INSTANCE, 13);
}

describe("wp create --stdin bulk path", () => {
  test("emits one created NDJSON line per item in input order and exits 0", async () => {
    const { configDir, cacheDir } = await room();
    const api = installMockApi({
      gets: refreshEndpoints(baseMetadata()),
      posts: [
        { status: 201, body: createdElement(101, "Fix login") },
        { status: 201, body: createdElement(102, "Write docs") },
      ],
    });
    const result = await runWpStdin(
      configDir,
      cacheDir,
      ["--stdin"],
      JSON.stringify([
        { subject: "Fix login", type: "Task", priority: "High" },
        { subject: "Write docs", type: "Task" },
      ]),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const lines = ndjsonLines(result.stdout);
    expect(lines).toEqual([
      { index: 0, ok: true, status: "created", id: 101, subject: "Fix login" },
      { index: 1, ok: true, status: "created", id: 102, subject: "Write docs" },
    ]);
    expect(api.postCount()).toBe(2);
  });

  test("keeps going past a failing item by default and still exits non-zero", async () => {
    const { configDir, cacheDir } = await room();
    await writeMetadataFile(cacheDir, baseMetadata());
    const api = installMockApi({
      gets: refreshEndpoints(baseMetadata()),
      posts: [
        { status: 201, body: createdElement(101, "First") },
        { status: 201, body: createdElement(103, "Third") },
      ],
    });
    const result = await runWpStdin(
      configDir,
      cacheDir,
      ["--stdin"],
      JSON.stringify([
        { subject: "First", type: "Task" },
        { subject: "Bad", type: "Nope" },
        { subject: "Third", type: "Task" },
      ]),
    );
    expect(result.exitCode).toBe(1);
    const lines = ndjsonLines(result.stdout);
    expect(lines[0]).toMatchObject({ index: 0, ok: true, status: "created", id: 101 });
    expect(lines[1]).toMatchObject({ index: 1, ok: false, code: "USAGE_ERROR" });
    expect(lines[2]).toMatchObject({ index: 2, ok: true, status: "created", id: 103 });
    expect(api.postCount()).toBe(2);
  });

  test("--fail-fast stops at the first failure", async () => {
    const { configDir, cacheDir } = await room();
    await writeMetadataFile(cacheDir, baseMetadata());
    installMockApi({ gets: refreshEndpoints(baseMetadata()) });
    const result = await runWpStdin(
      configDir,
      cacheDir,
      ["--stdin", "--fail-fast"],
      JSON.stringify([
        { subject: "Bad", type: "Nope" },
        { subject: "Never reached", type: "Task" },
      ]),
    );
    expect(result.exitCode).toBe(1);
    const lines = ndjsonLines(result.stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ index: 0, ok: false, code: "USAGE_ERROR" });
  });

  test("--dry-run resolves and validates everything but writes nothing", async () => {
    const { configDir, cacheDir } = await room();
    await writeMetadataFile(cacheDir, scopedMetadata(baseMetadata()));
    const api = installMockApi({});
    const result = await runWpStdin(
      configDir,
      cacheDir,
      ["--stdin", "--dry-run"],
      JSON.stringify([
        {
          subject: "Planned work",
          type: "Task",
          status: "In progress",
          priority: "High",
          field: ["Estimate=5"],
        },
      ]),
    );
    expect(result.exitCode).toBe(0);
    const lines = ndjsonLines(result.stdout);
    expect(lines).toEqual([
      { index: 0, ok: true, status: "would-create", subject: "Planned work" },
    ]);
    expect(api.postCount()).toBe(0);
  });

  test("--dry-run reports failing items too and exits non-zero", async () => {
    const { configDir, cacheDir } = await room();
    await writeMetadataFile(cacheDir, baseMetadata());
    installMockApi({ gets: refreshEndpoints(baseMetadata()) });
    const result = await runWpStdin(
      configDir,
      cacheDir,
      ["--stdin", "--dry-run"],
      JSON.stringify([
        { subject: "Bad", type: "Nope" },
        { subject: "Fine", type: "Task" },
      ]),
    );
    expect(result.exitCode).toBe(1);
    const lines = ndjsonLines(result.stdout);
    expect(lines[0]).toMatchObject({ index: 0, ok: false, code: "USAGE_ERROR" });
    expect(lines[1]).toMatchObject({
      index: 1,
      ok: true,
      status: "would-create",
      subject: "Fine",
    });
  });

  test("reuses resolution results across items instead of refetching per item", async () => {
    const { configDir, cacheDir } = await room();
    const api = installMockApi({
      gets: refreshEndpoints(baseMetadata()),
      posts: [
        { status: 201, body: createdElement(101, "One") },
        { status: 201, body: createdElement(102, "Two") },
        { status: 201, body: createdElement(103, "Three") },
      ],
    });
    const item = { subject: "?", type: "Task", status: "In progress", priority: "High" };
    const result = await runWpStdin(
      configDir,
      cacheDir,
      ["--stdin"],
      JSON.stringify([
        { ...item, subject: "One" },
        { ...item, subject: "Two" },
        { ...item, subject: "Three" },
      ]),
    );
    expect(result.exitCode).toBe(0);
    expect(api.getHits("/api/v3/types")).toBe(1);
    expect(api.getHits("/api/v3/statuses")).toBe(1);
    expect(api.getHits("/api/v3/priorities")).toBe(1);
    expect(api.getHits("/api/v3/projects/13")).toBe(1);
    expect(api.postCount()).toBe(3);
  });

  test("resolves me once across items", async () => {
    const { configDir, cacheDir } = await room();
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    cleanups.push(async () => {
      await mockAgent.close();
      setGlobalDispatcher(new Agent());
    });
    const pool = mockAgent.get(INSTANCE);
    let meHits = 0;
    pool.intercept({ path: "/api/v3/users/me", method: "GET" }).reply(() => {
      meHits += 1;
      return { statusCode: 200, data: { id: 7, name: "Linh Nguyen", login: "linh" } };
    }).persist();
    const postBodies: Array<Record<string, unknown>> = [];
    for (const id of [101, 102]) {
      pool.intercept({ path: "/api/v3/work_packages", method: "POST" }).reply(
        (call) => {
          postBodies.push(JSON.parse(String(call.body)) as Record<string, unknown>);
          return { statusCode: 201, data: createdElement(id, String(id)) };
        },
      );
    }
    const result = await runWpStdin(
      configDir,
      cacheDir,
      ["--stdin"],
      JSON.stringify([
        { subject: "Mine one", assignee: "me" },
        { subject: "Mine two", assignee: "me" },
      ]),
    );
    expect(result.exitCode).toBe(0);
    expect(meHits).toBe(1);
    expect(postBodies).toHaveLength(2);
    for (const body of postBodies) {
      const links = body._links as Record<string, { href: string }>;
      expect(links.assignee.href).toBe("/api/v3/users/7");
    }
  });

  test("the ADR-0002 retry rule repairs stale ids on the bulk path", async () => {
    const { configDir, cacheDir } = await room();
    await writeMetadataFile(cacheDir, baseMetadata());
    // The refreshed snapshot moves "In progress" from id 1 to id 9.
    const refreshed = baseMetadata([
      { id: 9, name: "In progress", is_closed: false, is_default: true },
      { id: 5, name: "Closed", is_closed: true, is_default: false },
    ]);
    const api = installMockApi({
      gets: refreshEndpoints(refreshed),
      posts: [
        { status: 422, body: { _embedded: { details: { attribute: "status" } } } },
        { status: 201, body: createdElement(101, "Retried") },
      ],
    });
    const result = await runWpStdin(
      configDir,
      cacheDir,
      ["--stdin"],
      JSON.stringify([{ subject: "Retried", status: "In progress" }]),
    );
    expect(result.exitCode).toBe(0);
    const lines = ndjsonLines(result.stdout);
    expect(lines).toEqual([
      { index: 0, ok: true, status: "created", id: 101, subject: "Retried" },
    ]);
    expect(api.postCount()).toBe(2);
    const links = api.postBodies[1]._links as Record<string, { href: string }>;
    expect(links.status.href).toBe("/api/v3/statuses/9");
  });

  test("rejects stdin input that is not a JSON array", async () => {
    const { configDir, cacheDir } = await room();
    installMockApi({});
    const notJson = await runWpStdin(configDir, cacheDir, ["--stdin"], "{not json");
    expect(notJson.exitCode).toBe(1);
    expect(notJson.stdout).toBe("");
    expect(notJson.stderr).toContain("USAGE_ERROR");
    const notArray = await runWpStdin(
      configDir,
      cacheDir,
      ["--stdin"],
      JSON.stringify({ subject: "One" }),
    );
    expect(notArray.exitCode).toBe(1);
    expect(notArray.stderr).toContain("array");
  });

  test("reports shape-invalid items on their own line and keeps going", async () => {
    const { configDir, cacheDir } = await room();
    await writeMetadataFile(cacheDir, baseMetadata());
    const api = installMockApi({
      gets: refreshEndpoints(baseMetadata()),
      posts: [{ status: 201, body: createdElement(102, "Good") }],
    });
    const result = await runWpStdin(
      configDir,
      cacheDir,
      ["--stdin"],
      JSON.stringify([
        "not an object",
        { subject: "", type: "Task" },
        { subject: "Mystery", surprise: true },
        { subject: "Good", type: "Task" },
      ]),
    );
    expect(result.exitCode).toBe(1);
    const lines = ndjsonLines(result.stdout);
    expect(lines[0]).toMatchObject({ index: 0, ok: false, code: "USAGE_ERROR" });
    expect(lines[1]).toMatchObject({ index: 1, ok: false, code: "USAGE_ERROR" });
    expect(lines[2]).toMatchObject({ index: 2, ok: false, code: "USAGE_ERROR" });
    expect(String(lines[2].hint)).toContain("subject");
    expect(lines[3]).toMatchObject({ index: 3, ok: true, status: "created", id: 102 });
    expect(api.postCount()).toBe(1);
  });

  test("an empty array succeeds with no output", async () => {
    const { configDir, cacheDir } = await room();
    installMockApi({});
    const result = await runWpStdin(configDir, cacheDir, ["--stdin"], "[]");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("refuses --stdin combined with a subject or --json", async () => {
    const { configDir, cacheDir } = await room();
    const withSubject = await runWpStdin(
      configDir,
      cacheDir,
      ["--stdin", "Subject"],
      "[]",
    );
    expect(withSubject.exitCode).toBe(1);
    const withJson = await runWpStdin(
      configDir,
      cacheDir,
      ["--stdin", "--json"],
      "[]",
    );
    expect(withJson.exitCode).toBe(1);
  });

  test("reports when stdin is not readable in this environment", async () => {
    const root = await makeTempRoom("wp-create-stdio-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE, 13);
    const result = await run(
      ["wp", "create", "--stdin"],
      { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
      {},
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("stdin");
  });
});
