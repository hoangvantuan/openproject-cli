import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, test } from "vitest";

import { run } from "../src/run.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

const INSTANCE = "https://op.example.dev";

async function makeRoom(project?: number): Promise<{ configDir: string; cacheDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "query-write-"));
  cleanups.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      default_profile: "default",
      active_profile: "default",
      profiles: {
        default: project === undefined ? { url: INSTANCE } : { url: INSTANCE, project },
      },
    }),
  );
  await writeFile(
    join(configDir, "credentials.json"),
    JSON.stringify({ default: { api_key: "secret-key" } }),
    { mode: 0o600 },
  );
  return { configDir, cacheDir: join(root, "cache") };
}

interface Traffic {
  readonly gets: Array<string>;
  readonly writes: Array<{ method: string; path: string; body: unknown }>;
}

/**
 * Exactly the listed GET paths and the one write answer; any other
 * request fails the run (net connect disabled).
 */
function installApi(options: {
  gets?: Record<string, unknown>;
  write?: { method: "POST" | "PATCH"; path: string; status?: number; body: unknown };
}): Traffic {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  cleanups.push(async () => {
    await mockAgent.close();
    setGlobalDispatcher(new Agent());
  });
  const traffic: Traffic = { gets: [], writes: [] };
  const pool = mockAgent.get(INSTANCE);
  for (const [path, body] of Object.entries(options.gets ?? {})) {
    pool
      .intercept({ path, method: "GET" })
      .reply(() => {
        traffic.gets.push(path);
        return { statusCode: 200, data: body };
      })
      .persist();
  }
  if (options.write !== undefined) {
    const write = options.write;
    pool
      .intercept({ path: write.path, method: write.method })
      .reply((request) => {
        traffic.writes.push({
          method: write.method,
          path: write.path,
          body: JSON.parse(String(request.body)),
        });
        return { statusCode: write.status ?? 200, data: write.body };
      });
  }
  return traffic;
}

async function runQuery(
  room: { configDir: string; cacheDir: string },
  args: ReadonlyArray<string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return run(
    ["query", ...args],
    { OP_CLI_CONFIG_DIR: room.configDir, OP_CLI_CACHE_DIR: room.cacheDir },
    {},
  );
}

function stored(id: number, name: string): Record<string, unknown> {
  return {
    _type: "Query",
    id,
    name,
    starred: false,
    public: false,
    sums: false,
    includeSubprojects: true,
    showHierarchies: false,
    filters: [],
    _links: { project: { href: "/api/v3/projects/7", title: "Alpha" } },
  };
}

function collection(elements: unknown[]): unknown {
  return {
    _type: "Collection",
    total: elements.length,
    count: elements.length,
    _embedded: { elements },
    _links: { self: { href: "/self" } },
  };
}

describe("query create", () => {
  test("posts a project-scoped query and renders the stored record", async () => {
    const room = await makeRoom();
    const traffic = installApi({
      write: { method: "POST", path: "/api/v3/queries", status: 201, body: stored(5, "Roadmap") },
    });
    const result = await runQuery(room, ["create", "  Roadmap ", "--project", "7", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(traffic.writes).toEqual([
      {
        method: "POST",
        path: "/api/v3/queries",
        body: { name: "Roadmap", _links: { project: { href: "/api/v3/projects/7" } } },
      },
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({ id: 5, name: "Roadmap" });
  });

  test("a query with no project in context is global: project href null", async () => {
    const room = await makeRoom();
    const traffic = installApi({
      write: { method: "POST", path: "/api/v3/queries", body: stored(6, "Everything") },
    });
    const result = await runQuery(room, ["create", "Everything"]);
    expect(result.exitCode).toBe(0);
    expect(traffic.writes[0]?.body).toEqual({ name: "Everything", _links: { project: { href: null } } });
  });

  test("--global overrides the default project", async () => {
    const room = await makeRoom(7);
    const traffic = installApi({
      write: { method: "POST", path: "/api/v3/queries", body: stored(6, "Everything") },
    });
    const result = await runQuery(room, ["create", "Everything", "--global"]);
    expect(result.exitCode).toBe(0);
    expect(traffic.writes[0]?.body).toMatchObject({ _links: { project: { href: null } } });
  });

  test("filters go out in wire shape, with no project clause", async () => {
    const room = await makeRoom();
    const traffic = installApi({
      write: { method: "POST", path: "/api/v3/queries", body: stored(7, "Open bugs") },
    });
    const result = await runQuery(room, [
      "create", "Open bugs", "--project", "7",
      "--status", "1", "--type", "2", "--assignee", "8", "--search", "login",
      "--backlog-inbox", "--id", "12", "--no-include-subprojects",
    ]);
    expect(result.exitCode).toBe(0);
    expect(traffic.writes[0]?.body).toEqual({
      name: "Open bugs",
      includeSubprojects: false,
      _links: { project: { href: "/api/v3/projects/7" } },
      filters: [
        { _links: { filter: { href: "/api/v3/queries/filters/id" }, operator: { href: "/api/v3/queries/operators/%3D" }, }, values: ["12"] },
        { _links: { filter: { href: "/api/v3/queries/filters/status" }, operator: { href: "/api/v3/queries/operators/%3D" }, values: [{ href: "/api/v3/statuses/1" }] } },
        { _links: { filter: { href: "/api/v3/queries/filters/type" }, operator: { href: "/api/v3/queries/operators/%3D" }, values: [{ href: "/api/v3/types/2" }] } },
        { _links: { filter: { href: "/api/v3/queries/filters/assignee" }, operator: { href: "/api/v3/queries/operators/%3D" }, values: [{ href: "/api/v3/users/8" }] } },
        { _links: { filter: { href: "/api/v3/queries/filters/backlogInbox" }, operator: { href: "/api/v3/queries/operators/%3D" } }, values: [true] },
        { _links: { filter: { href: "/api/v3/queries/filters/subject" }, operator: { href: "/api/v3/queries/operators/~" } }, values: ["login"] },
      ],
    });
  });

  test("--open sends the value-less status operator with empty link values", async () => {
    const room = await makeRoom();
    const traffic = installApi({
      write: { method: "POST", path: "/api/v3/queries", body: stored(8, "Open") },
    });
    const result = await runQuery(room, ["create", "Open", "--open"]);
    expect(result.exitCode).toBe(0);
    expect(traffic.writes[0]?.body).toMatchObject({
      filters: [
        { _links: { filter: { href: "/api/v3/queries/filters/status" }, operator: { href: "/api/v3/queries/operators/o" }, values: [] } },
      ],
    });
  });

  test("view and visibility flags map to Query attributes and links", async () => {
    const room = await makeRoom();
    const traffic = installApi({
      write: { method: "POST", path: "/api/v3/queries", body: stored(9, "View") },
    });
    const result = await runQuery(room, [
      "create", "View", "--public", "--starred", "false", "--sums", "true", "--hierarchies",
      "--sort", "dueDate:desc", "--sort", "id", "--columns", "id,subject,status", "--group-by", "status",
    ]);
    expect(result.exitCode).toBe(0);
    expect(traffic.writes[0]?.body).toEqual({
      name: "View",
      public: true,
      starred: false,
      sums: true,
      showHierarchies: true,
      _links: {
        project: { href: null },
        sortBy: [
          { href: "/api/v3/queries/sort_bys/dueDate-desc" },
          { href: "/api/v3/queries/sort_bys/id-asc" },
        ],
        columns: [
          { href: "/api/v3/queries/columns/id" },
          { href: "/api/v3/queries/columns/subject" },
          { href: "/api/v3/queries/columns/status" },
        ],
        groupBy: { href: "/api/v3/queries/group_bys/status" },
      },
    });
  });

  test.each([
    [["create", "   "], "name"],
    [["create", "X", "--global", "--project", "7"], "--global"],
    [["create", "X", "--public", "maybe"], "--public"],
    [["create", "X", "--columns", ""], "--columns"],
    [["create", "X", "--group-by", ""], "--group-by"],
    [["create", "X", "--sort", "nonsense"], "nonsense"],
    [["create", "X", "--open", "--closed"], "--open"],
    [["create", "X", "--version", "1"], "project"],
  ])("%j is refused before any traffic", async (args, mention) => {
    const room = await makeRoom();
    const traffic = installApi({});
    const result = await runQuery(room, args);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("USAGE_ERROR");
    expect(result.stderr.toLowerCase()).toContain(mention.toLowerCase());
    expect(traffic.gets).toEqual([]);
    expect(traffic.writes).toEqual([]);
  });

  test("--fields is checked after the write and the failure names the created query", async () => {
    const room = await makeRoom();
    const traffic = installApi({
      write: { method: "POST", path: "/api/v3/queries", status: 201, body: stored(5, "X") },
    });
    const result = await runQuery(room, ["create", "X", "--fields", "nope"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("USAGE_ERROR");
    expect(result.stderr).toContain("query 5 was created;");
    expect(result.stderr).toContain("nope");
    expect(traffic.writes).toHaveLength(1);
    expect(traffic.writes[0]?.method).toBe("POST");
  });

  test("a 5xx is the unknown-outcome exit 6", async () => {
    const room = await makeRoom();
    installApi({ write: { method: "POST", path: "/api/v3/queries", status: 503, body: {} } });
    const result = await runQuery(room, ["create", "X"]);
    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain("NETWORK_ERROR");
  });

  test("a 422 quotes the instance's refusal", async () => {
    const room = await makeRoom();
    installApi({
      write: {
        method: "POST",
        path: "/api/v3/queries",
        status: 422,
        body: { _type: "Error", message: "Name has already been taken." },
      },
    });
    const result = await runQuery(room, ["create", "X"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Name has already been taken.");
  });
});

describe("query update", () => {
  test("a numeric id patches only the named attribute", async () => {
    const room = await makeRoom();
    const traffic = installApi({
      write: { method: "PATCH", path: "/api/v3/queries/5", body: stored(5, "Renamed") },
    });
    const result = await runQuery(room, ["update", "5", "--name", " Renamed ", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(traffic.writes).toEqual([{ method: "PATCH", path: "/api/v3/queries/5", body: { name: "Renamed" } }]);
    expect(JSON.parse(result.stdout)).toMatchObject({ id: 5, name: "Renamed" });
  });

  test("a name resolves live, then that query is patched", async () => {
    const room = await makeRoom();
    const traffic = installApi({
      gets: {
        "/api/v3/queries?pageSize=100": collection([
          { ...stored(5, "Roadmap") },
          { ...stored(6, "Other") },
        ]),
      },
      write: { method: "PATCH", path: "/api/v3/queries/5", body: stored(5, "Roadmap") },
    });
    const result = await runQuery(room, ["update", "Roadmap", "--public", "true"]);
    expect(result.exitCode).toBe(0);
    expect(traffic.writes[0]?.body).toEqual({ public: true });
  });

  test("--clear-filters sends an empty filter list", async () => {
    const room = await makeRoom();
    const traffic = installApi({
      write: { method: "PATCH", path: "/api/v3/queries/5", body: stored(5, "Roadmap") },
    });
    const result = await runQuery(room, ["update", "5", "--clear-filters"]);
    expect(result.exitCode).toBe(0);
    expect(traffic.writes[0]?.body).toEqual({ filters: [] });
  });

  test("filter flags replace the filters; clearing view parts uses empty values", async () => {
    const room = await makeRoom();
    const traffic = installApi({
      write: { method: "PATCH", path: "/api/v3/queries/5", body: stored(5, "Roadmap") },
    });
    const result = await runQuery(room, [
      "update", "5", "--priority", "3", "--sort", "", "--columns", "", "--group-by", "",
    ]);
    expect(result.exitCode).toBe(0);
    expect(traffic.writes[0]?.body).toEqual({
      filters: [
        { _links: { filter: { href: "/api/v3/queries/filters/priority" }, operator: { href: "/api/v3/queries/operators/%3D" }, values: [{ href: "/api/v3/priorities/3" }] } },
      ],
      _links: { sortBy: [], columns: [], groupBy: { href: null } },
    });
  });

  test.each([
    [["update", "default", "--name", "X"], "default"],
    [["update", "5"], "at least one"],
    [["update", "5", "--name", "  "], "--name"],
    [["update", "5", "--clear-filters", "--open"], "--clear-filters"],
    [["update", "5", "--name", "X", "--fields", "nope"], "nope"],
    [["update", "5", "--hierarchies", "perhaps"], "--hierarchies"],
  ])("%j is refused before any traffic", async (args, mention) => {
    const room = await makeRoom();
    const traffic = installApi({});
    const result = await runQuery(room, args);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("USAGE_ERROR");
    expect(result.stderr.toLowerCase()).toContain(mention.toLowerCase());
    expect(traffic.gets).toEqual([]);
    expect(traffic.writes).toEqual([]);
  });

  async function seedVersions(room: { cacheDir: string }): Promise<void> {
    await mkdir(join(room.cacheDir, "default"), { recursive: true });
    await writeFile(
      join(room.cacheDir, "default", "metadata.json"),
      JSON.stringify({
        projectScoped: {
          "99": {
            project_id: 99,
            fetched_at: "2026-01-01T00:00:00Z",
            members: [],
            versions: [{ id: 21, name: "v2", status: "open" }],
            categories: [],
            activities: [],
            sprints: [],
            buckets: [],
          },
        },
      }),
    );
  }

  test("project-scoped names resolve against the project of the query being changed", async () => {
    const room = await makeRoom(13);
    await seedVersions(room);
    const traffic = installApi({
      gets: {
        "/api/v3/queries/5": {
          ...stored(5, "Roadmap"),
          _links: { project: { href: "/api/v3/projects/99", title: "Other" } },
        },
      },
      write: { method: "PATCH", path: "/api/v3/queries/5", body: stored(5, "Roadmap") },
    });
    const result = await runQuery(room, ["update", "5", "--version", "v2"]);
    expect(result.exitCode).toBe(0);
    expect(traffic.gets).toEqual(["/api/v3/queries/5"]);
    expect(JSON.stringify(traffic.writes[0]?.body)).toContain("/api/v3/versions/21");
  });

  test("a project-scoped name on a global query is refused before any write", async () => {
    const room = await makeRoom(13);
    await seedVersions(room);
    const traffic = installApi({
      gets: {
        "/api/v3/queries/5": { ...stored(5, "Roadmap"), _links: { project: { href: null } } },
      },
    });
    const result = await runQuery(room, ["update", "5", "--version", "v2"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("USAGE_ERROR");
    expect(result.stderr).toContain("--version");
    expect(traffic.writes).toEqual([]);
  });

  test("an unknown id is NOT_FOUND", async () => {
    const room = await makeRoom();
    installApi({ write: { method: "PATCH", path: "/api/v3/queries/99", status: 404, body: {} } });
    const result = await runQuery(room, ["update", "99", "--name", "X"]);
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("NOT_FOUND");
  });

  test("a 5xx is the unknown-outcome exit 6", async () => {
    const room = await makeRoom();
    installApi({ write: { method: "PATCH", path: "/api/v3/queries/5", status: 500, body: {} } });
    const result = await runQuery(room, ["update", "5", "--name", "X"]);
    expect(result.exitCode).toBe(6);
  });
});
