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
  const root = await mkdtemp(join(tmpdir(), "query-"));
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

/**
 * Exactly the listed GET paths answer; any other request fails the run
 * (net connect disabled), so a green test also proves the traffic.
 */
function installApi(gets: Record<string, unknown>): Array<string> {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  cleanups.push(async () => {
    await mockAgent.close();
    setGlobalDispatcher(new Agent());
  });
  const seen: Array<string> = [];
  const pool = mockAgent.get(INSTANCE);
  for (const [path, body] of Object.entries(gets)) {
    const status = body === 404 ? 404 : 200;
    pool
      .intercept({ path, method: "GET" })
      .reply(() => {
        seen.push(path);
        return { statusCode: status, data: status === 404 ? { message: "nf" } : body };
      })
      .persist();
  }
  return seen;
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

function collection(total: number, elements: unknown[], nextHref?: string): unknown {
  return {
    _type: "Collection",
    total,
    count: elements.length,
    _embedded: { elements },
    _links: {
      self: { href: "/self" },
      ...(nextHref === undefined ? {} : { nextByOffset: { href: nextHref } }),
    },
  };
}

function queryElement(
  id: number,
  name: string,
  options: { project?: [number, string]; starred?: boolean; public?: boolean } = {},
): Record<string, unknown> {
  return {
    _type: "Query",
    id,
    name,
    starred: options.starred ?? false,
    public: options.public ?? false,
    sums: false,
    includeSubprojects: true,
    showHierarchies: true,
    createdAt: "2026-08-01T09:15:00Z",
    updatedAt: "2026-08-20T14:02:11Z",
    filters: [
      {
        _type: "StatusQueryFilterInstance",
        name: "Status",
        values: [],
        _links: {
          filter: { href: "/api/v3/queries/filters/status" },
          operator: { href: "/api/v3/queries/operators/o", title: "open" },
          values: [],
        },
      },
      {
        _type: "SubjectQueryFilterInstance",
        name: "Subject",
        values: ["login"],
        _links: {
          filter: { href: "/api/v3/queries/filters/subject" },
          operator: { href: "/api/v3/queries/operators/~", title: "contains" },
          values: [],
        },
      },
      {
        _type: "AssigneeQueryFilterInstance",
        name: "Assignee",
        values: [],
        _links: {
          filter: { href: "/api/v3/queries/filters/assignee" },
          operator: { href: "/api/v3/queries/operators/%3D", title: "is" },
          values: [{ href: "/api/v3/users/8", title: "Hung" }],
        },
      },
    ],
    _embedded: { results: { _type: "WorkPackageCollection", total: 99, _embedded: { elements: [] } } },
    _links: {
      self: { href: `/api/v3/queries/${String(id)}`, title: name },
      project: options.project === undefined
        ? { href: null }
        : { href: `/api/v3/projects/${String(options.project[0])}`, title: options.project[1] },
      user: { href: "/api/v3/users/3", title: "Anh Tuan" },
      groupBy: { href: "/api/v3/queries/group_bys/status", title: "Status" },
      columns: [
        { href: "/api/v3/queries/columns/id", title: "ID" },
        { href: "/api/v3/queries/columns/subject", title: "Subject" },
      ],
      sortBy: [
        { href: "/api/v3/queries/sort_bys/updatedAt-desc", title: "Updated on (Descending)" },
        { href: "/api/v3/queries/sort_bys/id-asc", title: "ID (Ascending)" },
      ],
      results: { href: "/api/v3/work_packages?query=1" },
      star: { href: `/api/v3/queries/${String(id)}/star`, method: "patch" },
    },
  };
}

function clause(name: string, operator: string, values: string[]): string {
  return encodeURIComponent(JSON.stringify([{ [name]: { operator, values } }]));
}

const BUGS = queryElement(5, "Open bugs", { project: [7, "Demo"], starred: true, public: true });
const GLOBAL_MINE = queryElement(9, "My work");

describe("query list", () => {
  test("without a project it lists every visible query as a table", async () => {
    const room = await makeRoom();
    installApi({ "/api/v3/queries?pageSize=100": collection(2, [BUGS, GLOBAL_MINE]) });
    const result = await runQuery(room, ["list"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]?.split(/\s+/)).toEqual(["ID", "NAME", "PROJECT", "STARRED", "PUBLIC"]);
    expect(lines[1]?.split(/\s{2,}/)).toEqual(["5", "Open bugs", "Demo", "true", "true"]);
    expect(lines[2]).toMatch(/^9\s+My work\s+false\s+false$/);
  });
});

const ROOT_DOC = { maximumAPIV3PageSize: 500 };

describe("query list scopes and paging", () => {
  test("a default project scopes the list to that project", async () => {
    const room = await makeRoom(7);
    installApi({
      [`/api/v3/queries?filters=${clause("project", "=", ["7"])}&pageSize=100`]: collection(1, [BUGS]),
    });
    const result = await runQuery(room, ["list"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Open bugs");
  });

  test("--workspace is the same as --project", async () => {
    const room = await makeRoom();
    installApi({
      [`/api/v3/queries?filters=${clause("project", "=", ["12"])}&pageSize=100`]: collection(1, [BUGS]),
    });
    const result = await runQuery(room, ["list", "--workspace", "12"]);
    expect(result.exitCode).toBe(0);
  });

  test("--global asks for queries without a project", async () => {
    const room = await makeRoom(7);
    installApi({
      [`/api/v3/queries?filters=${clause("project", "!*", [])}&pageSize=100`]: collection(1, [GLOBAL_MINE]),
    });
    const result = await runQuery(room, ["list", "--global"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("My work");
  });

  test("--all-projects ignores the default project", async () => {
    const room = await makeRoom(7);
    installApi({ "/api/v3/queries?pageSize=100": collection(2, [BUGS, GLOBAL_MINE]) });
    const result = await runQuery(room, ["list", "--all-projects"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("My work");
  });

  test.each([
    [["list", "--global", "--project", "7"]],
    [["list", "--global", "--workspace", "7"]],
    [["list", "--global", "--all-projects"]],
    [["list", "--all-projects", "--project", "7"]],
    [["get", "default", "--global", "--project", "7"]],
  ])("%j is refused before any traffic", async (args) => {
    const room = await makeRoom();
    const seen = installApi({});
    const result = await runQuery(room, args);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cannot be combined");
    expect(seen).toEqual([]);
  });

  test("--json is a flat array with --fields picking columns", async () => {
    const room = await makeRoom();
    installApi({ "/api/v3/queries?pageSize=100": collection(1, [BUGS]) });
    const result = await runQuery(room, ["list", "--json", "--fields", "id,name"]);
    expect(JSON.parse(result.stdout)).toEqual([{ id: 5, name: "Open bugs" }]);
  });

  test("a truncated page warns on stderr", async () => {
    const room = await makeRoom();
    installApi({ "/api/v3/queries?pageSize=1": collection(3, [BUGS]) });
    const result = await runQuery(room, ["list", "--limit", "1"]);
    expect(result.stderr).toBe("Showing 1 of 3 queries. Pass --all to fetch every result.\n");
  });

  test("--all --json streams one record per line across pages", async () => {
    const room = await makeRoom();
    installApi({
      "/api/v3/": ROOT_DOC,
      "/api/v3/queries?pageSize=500": collection(2, [BUGS], "/api/v3/queries?offset=2&pageSize=500"),
      "/api/v3/queries?offset=2&pageSize=500": collection(2, [GLOBAL_MINE]),
    });
    const result = await runQuery(room, ["list", "--all", "--json", "--fields", "id"]);
    expect(result.stdout).toBe('{"id":5}\n{"id":9}\n');
    expect(result.stderr).toBe("");
  });

  test("--starred keeps only starred queries, even past the first page", async () => {
    const room = await makeRoom();
    installApi({
      "/api/v3/": ROOT_DOC,
      "/api/v3/queries?pageSize=500": collection(2, [GLOBAL_MINE], "/api/v3/queries?offset=2&pageSize=500"),
      "/api/v3/queries?offset=2&pageSize=500": collection(2, [BUGS]),
    });
    const result = await runQuery(room, ["list", "--starred", "--json", "--fields", "id"]);
    expect(JSON.parse(result.stdout)).toEqual([{ id: 5 }]);
  });

  test("an unknown --fields name is refused with the valid ones", async () => {
    const room = await makeRoom();
    const seen = installApi({});
    const result = await runQuery(room, ["list", "--fields", "nme"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("name");
    expect(seen).toEqual([]);
  });
});

describe("query get", () => {
  test("an extra query attribute survives and --fields can project it", async () => {
    const room = await makeRoom();
    installApi({
      "/api/v3/queries/5": {
        ...(BUGS as Record<string, unknown>),
        timelineVisible: false,
        displayRepresentation: "list",
      },
    });
    const full = await runQuery(room, ["get", "5", "--json"]);
    expect(full.exitCode).toBe(0);
    expect(JSON.parse(full.stdout)).toMatchObject({
      timelineVisible: false,
      displayRepresentation: "list",
      name: "Open bugs",
    });
    expect(JSON.parse(full.stdout)).not.toHaveProperty("results");

    const picked = await runQuery(room, ["get", "5", "--json", "--fields", "timelineVisible"]);
    expect(picked.exitCode).toBe(0);
    expect(JSON.parse(picked.stdout)).toEqual({ timelineVisible: false });
  });

  test("a numeric id reads the query and flattens it", async () => {
    const room = await makeRoom();
    installApi({ "/api/v3/queries/5": BUGS });
    const result = await runQuery(room, ["get", "5", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      id: 5,
      name: "Open bugs",
      project: { id: 7, name: "Demo" },
      user: { id: 3, name: "Anh Tuan" },
      starred: true,
      public: true,
      sums: false,
      includeSubprojects: true,
      showHierarchies: true,
      groupBy: { id: null, name: "Status" },
      columns: ["id", "subject"],
      sortBy: ["updatedAt:desc", "id:asc"],
      filters: [
        { field: "status", operator: "o", values: [] },
        { field: "subject", operator: "~", values: ["login"] },
        { field: "assignee", operator: "=", values: ["8"] },
      ],
      createdAt: "2026-08-01T09:15:00Z",
      updatedAt: "2026-08-20T14:02:11Z",
    });
  });

  test("the table shows FIELD and VALUE and honours --fields", async () => {
    const room = await makeRoom();
    installApi({ "/api/v3/queries/5": BUGS });
    const result = await runQuery(room, ["get", "5", "--fields", "name,project,columns"]);
    const lines = result.stdout.trimEnd().split("\n").map((line) => line.split(/\s{2,}/));
    expect(lines).toEqual([
      ["FIELD", "VALUE"],
      ["name", "Open bugs"],
      ["project", "Demo"],
      ["columns", '["id","subject"]'],
    ]);
  });

  test("default with a project reads the workspace default query", async () => {
    const room = await makeRoom(7);
    installApi({ "/api/v3/workspaces/7/queries/default": queryElement(0, "Default") });
    const result = await runQuery(room, ["get", "default", "--json", "--fields", "name"]);
    expect(JSON.parse(result.stdout)).toEqual({ name: "Default" });
  });

  test("default falls back to the projects route when workspaces is missing", async () => {
    const room = await makeRoom(7);
    installApi({
      "/api/v3/workspaces/7/queries/default": 404,
      "/api/v3/projects/7/queries/default": queryElement(0, "Default"),
    });
    const result = await runQuery(room, ["get", "default", "--json", "--fields", "name"]);
    expect(result.exitCode).toBe(0);
  });

  test.each([[["--global"]], [["--all-projects"]], [[]]])(
    "default without a project scope (%j) reads the global default",
    async (flags) => {
      const room = await makeRoom(flags.length === 0 ? undefined : 7);
      installApi({ "/api/v3/queries/default": queryElement(0, "Global default") });
      const result = await runQuery(room, ["get", "default", ...flags, "--json", "--fields", "name"]);
      expect(JSON.parse(result.stdout)).toEqual({ name: "Global default" });
    },
  );

  test("a name resolves live to one query, then that query is read", async () => {
    const room = await makeRoom();
    const seen = installApi({
      "/api/v3/queries?pageSize=100": collection(2, [GLOBAL_MINE, BUGS]),
      "/api/v3/queries/5": BUGS,
    });
    const result = await runQuery(room, ["get", "Open bugs", "--json", "--fields", "id"]);
    expect(JSON.parse(result.stdout)).toEqual({ id: 5 });
    expect(seen).toEqual(["/api/v3/queries?pageSize=100", "/api/v3/queries/5"]);
  });

  test("a name used by two queries is ambiguous and lists owners", async () => {
    const room = await makeRoom();
    installApi({
      "/api/v3/queries?pageSize=100": collection(2, [
        queryElement(5, "Open", { project: [7, "Demo"] }),
        queryElement(9, "Open"),
      ]),
    });
    const result = await runQuery(room, ["get", "Open"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ambiguous");
    expect(result.stderr).toContain("5 (project Demo)");
    expect(result.stderr).toContain("9 (global)");
  });

  test("--global narrows name matching so a clash disappears", async () => {
    const room = await makeRoom();
    installApi({
      [`/api/v3/queries?filters=${clause("project", "!*", [])}&pageSize=100`]: collection(1, [
        queryElement(9, "Open"),
      ]),
      "/api/v3/queries/9": queryElement(9, "Open"),
    });
    const result = await runQuery(room, ["get", "Open", "--global", "--json", "--fields", "id"]);
    expect(JSON.parse(result.stdout)).toEqual({ id: 9 });
  });

  test("a missing name ranks the closest query names", async () => {
    const room = await makeRoom();
    installApi({
      "/api/v3/queries?pageSize=100": collection(2, [GLOBAL_MINE, BUGS]),
    });
    const result = await runQuery(room, ["get", "Open bug"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Open bugs, My work");
  });

  test("an unknown id is NOT_FOUND", async () => {
    const room = await makeRoom();
    installApi({ "/api/v3/queries/404": 404 });
    const result = await runQuery(room, ["get", "404"]);
    expect(result.exitCode).toBe(4);
  });
});
