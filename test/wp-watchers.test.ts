import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, test } from "vitest";

import { run } from "../src/run.js";

const INSTANCE = "https://op.example";
const WATCHERS = "/api/v3/work_packages/12/watchers";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function makeRoom(withMembers = false): Promise<{ configDir: string; cacheDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "op-cli-wp-watchers-"));
  cleanups.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const configDir = join(root, "config");
  const cacheDir = join(root, "cache");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      default_profile: "default",
      active_profile: "default",
      profiles: {
        default: withMembers ? { url: INSTANCE, project: 13 } : { url: INSTANCE },
      },
    }),
  );
  await writeFile(
    join(configDir, "credentials.json"),
    JSON.stringify({ default: { api_key: "secret-key" } }),
    { mode: 0o600 },
  );
  if (withMembers) {
    const dir = join(cacheDir, "default");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "metadata.json"),
      JSON.stringify({
        types: [],
        statuses: [],
        priorities: [],
        instance: {
          url: INSTANCE,
          api_version: "v3",
          core_version: "13.4",
          fetched_at: "2026-08-23T00:00:00Z",
        },
        projectScoped: {
          "13": {
            project_id: 13,
            fetched_at: "2026-08-23T00:00:00Z",
            members: [
              { membership_id: 1, user_id: 9, name: "Linh Nguyen", type: "User", roles: [] },
            ],
            versions: [],
            categories: [],
            activities: [],
            custom_fields: {},
          },
        },
      }),
    );
  }
  return { configDir, cacheDir };
}

const ME = { id: 5, name: "Tuan Ha", login: "tuan" };

function user(id: number, name: string): Record<string, unknown> {
  return { _type: "User", id, name, login: name.toLowerCase().replace(" ", "."), _links: {} };
}

function collection(elements: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    _type: "Collection",
    total: elements.length,
    count: elements.length,
    _embedded: { elements },
    _links: { self: { href: "/self" } },
  };
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

interface Reply {
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  readonly status?: number;
  readonly body?: unknown;
}

/** Exactly the listed requests; anything else fails (net connect disabled). */
function installApi(replies: ReadonlyArray<Reply>): { calls: Array<Call> } {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  cleanups.push(async () => {
    await mockAgent.close();
    setGlobalDispatcher(new Agent());
  });
  const calls: Array<Call> = [];
  const pool = mockAgent.get(INSTANCE);
  for (const reply of replies) {
    pool
      .intercept({
        method: reply.method,
        path: (path) => path.split("?")[0] === reply.path,
      })
      .reply((call) => {
        calls.push({ method: reply.method, path: reply.path, body: String(call.body ?? "") });
        return { statusCode: reply.status ?? 200, data: reply.body ?? {} };
      });
  }
  return { calls };
}

async function runWp(args: ReadonlyArray<string>, withMembers = false) {
  const { configDir, cacheDir } = await makeRoom(withMembers);
  return run(
    ["wp", ...args],
    { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
    {},
  );
}

const writes = (calls: ReadonlyArray<Call>): ReadonlyArray<Call> =>
  calls.filter((call) => call.method !== "GET");

describe("wp watchers", () => {
  test("lists id and name as a table", async () => {
    installApi([
      {
        method: "GET",
        path: WATCHERS,
        body: collection([user(9, "Linh Nguyen"), user(5, "Tuan Ha")]),
      },
    ]);

    const result = await runWp(["watchers", "12"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/ID\s+NAME/);
    expect(result.stdout).toMatch(/9\s+Linh Nguyen/);
    expect(result.stdout).toMatch(/5\s+Tuan Ha/);
  });

  test("--json is a flat array of {id, name}", async () => {
    installApi([
      { method: "GET", path: WATCHERS, body: collection([user(9, "Linh Nguyen")]) },
    ]);

    const result = await runWp(["watchers", "12", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([{ id: 9, name: "Linh Nguyen" }]);
  });
});

describe("wp watch", () => {
  test("defaults to me: posts the user link and reports the change", async () => {
    const { calls } = installApi([
      { method: "GET", path: "/api/v3/users/me", body: ME },
      { method: "GET", path: WATCHERS, body: collection([user(9, "Linh Nguyen")]) },
      { method: "POST", path: WATCHERS, status: 201, body: user(5, "Tuan Ha") },
    ]);

    const result = await runWp(["watch", "12", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(writes(calls).map((call) => JSON.parse(call.body) as unknown)).toEqual([
      { user: { href: "/api/v3/users/5" } },
    ]);
    expect(JSON.parse(result.stdout)).toEqual({
      id: 12,
      user: 5,
      name: "Tuan Ha",
      watching: true,
      changed: true,
    });
  });

  test("already watching reports the state, exit 0, no write", async () => {
    const { calls } = installApi([
      { method: "GET", path: "/api/v3/users/me", body: ME },
      { method: "GET", path: WATCHERS, body: collection([user(5, "Tuan Ha")]) },
    ]);

    const result = await runWp(["watch", "12"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("already watching");
    expect(writes(calls)).toHaveLength(0);
  });

  test("--user resolves a member name like --assignee", async () => {
    const { calls } = installApi([
      { method: "GET", path: WATCHERS, body: collection([]) },
      { method: "POST", path: WATCHERS, status: 201, body: user(9, "Linh Nguyen") },
    ]);

    const result = await runWp(["watch", "12", "--user", "Linh Nguyen"], true);

    expect(result.exitCode).toBe(0);
    expect(writes(calls).map((call) => JSON.parse(call.body) as unknown)).toEqual([
      { user: { href: "/api/v3/users/9" } },
    ]);
    expect(result.stdout).toContain("Linh Nguyen");
  });

  test("403 is PERMISSION_DENIED", async () => {
    installApi([
      { method: "GET", path: "/api/v3/users/me", body: ME },
      { method: "GET", path: WATCHERS, body: collection([]) },
      { method: "POST", path: WATCHERS, status: 403, body: { message: "no" } },
    ]);

    const result = await runWp(["watch", "12"]);

    expect(result.exitCode).toBe(8);
    expect(result.stderr).toMatch(/^\[PERMISSION_DENIED\]/);
  });

  // A 5xx on a write leaves the state unknown: exit 6, never API_ERROR
  // (ADR-0002; roundup review S4).
  test("a 5xx on the add is the unknown-state NETWORK_ERROR", async () => {
    installApi([
      { method: "GET", path: "/api/v3/users/me", body: ME },
      { method: "GET", path: WATCHERS, body: collection([]) },
      { method: "POST", path: WATCHERS, status: 500, body: {} },
    ]);

    const result = await runWp(["watch", "12"]);

    expect(result.exitCode).toBe(6);
    expect(result.stderr).toMatch(/^\[NETWORK_ERROR\]/);
    expect(result.stderr).toContain("unknown");
  });

  test("a non-numeric id is a usage error before any request", async () => {
    const { calls } = installApi([]);

    const result = await runWp(["watch", "abc"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^\[USAGE_ERROR\]/);
    expect(calls).toHaveLength(0);
  });
});

describe("wp unwatch", () => {
  test("deletes the watcher and reports the change", async () => {
    const { calls } = installApi([
      { method: "GET", path: "/api/v3/users/me", body: ME },
      { method: "GET", path: WATCHERS, body: collection([user(5, "Tuan Ha")]) },
      { method: "DELETE", path: `${WATCHERS}/5`, status: 204 },
    ]);

    const result = await runWp(["unwatch", "12", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(writes(calls).map((call) => call.method)).toEqual(["DELETE"]);
    expect(JSON.parse(result.stdout)).toEqual({
      id: 12,
      user: 5,
      name: "Tuan Ha",
      watching: false,
      changed: true,
    });
  });

  test("not watching reports the state, exit 0, no write", async () => {
    const { calls } = installApi([
      { method: "GET", path: "/api/v3/users/me", body: ME },
      { method: "GET", path: WATCHERS, body: collection([user(9, "Linh Nguyen")]) },
    ]);

    const result = await runWp(["unwatch", "12"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("not watching");
    expect(writes(calls)).toHaveLength(0);
  });

  test("a 5xx on the remove is the unknown-state NETWORK_ERROR", async () => {
    installApi([
      { method: "GET", path: "/api/v3/users/me", body: ME },
      { method: "GET", path: WATCHERS, body: collection([user(5, "Tuan Ha")]) },
      { method: "DELETE", path: `${WATCHERS}/5`, status: 502, body: {} },
    ]);

    const result = await runWp(["unwatch", "12"]);

    expect(result.exitCode).toBe(6);
    expect(result.stderr).toMatch(/^\[NETWORK_ERROR\]/);
    expect(result.stderr).toContain("unknown");
  });

  test("--user accepts a numeric id", async () => {
    const { calls } = installApi([
      { method: "GET", path: WATCHERS, body: collection([user(9, "Linh Nguyen")]) },
      { method: "DELETE", path: `${WATCHERS}/9`, status: 204 },
    ]);

    const result = await runWp(["unwatch", "12", "--user", "9"]);

    expect(result.exitCode).toBe(0);
    expect(writes(calls).map((call) => call.path)).toEqual([`${WATCHERS}/9`]);
    expect(result.stdout).toContain("Linh Nguyen");
  });
});
