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

async function makeRoom(
  project?: number,
  url: string = INSTANCE,
): Promise<{ configDir: string; cacheDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "query-run-"));
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
      profiles: { default: project === undefined ? { url } : { url, project } },
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
function installApi(gets: Record<string, unknown>, origin: string = INSTANCE): Array<string> {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  cleanups.push(async () => {
    await mockAgent.close();
    setGlobalDispatcher(new Agent());
  });
  const seen: Array<string> = [];
  const pool = mockAgent.get(origin);
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
    ["query", "run", ...args],
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

function workPackage(id: number, subject: string): Record<string, unknown> {
  return {
    _type: "WorkPackage",
    id,
    subject,
    updatedAt: "2026-08-20T14:02:11Z",
    _links: {
      self: { href: `/api/v3/work_packages/${String(id)}` },
      type: { href: "/api/v3/types/1", title: "Task" },
      status: { href: "/api/v3/statuses/1", title: "New" },
      priority: { href: "/api/v3/priorities/8", title: "Normal" },
      assignee: { href: "/api/v3/users/8", title: "Hung" },
    },
  };
}

function queryResource(
  id: number,
  options: {
    results?: string | null;
    columns?: Array<{ href: string; title?: string }>;
    project?: [number, string];
  } = {},
): Record<string, unknown> {
  return {
    _type: "Query",
    id,
    name: "Roadmap",
    _links: {
      self: { href: `/api/v3/queries/${String(id)}` },
      ...(options.results === null
        ? {}
        : { results: { href: options.results ?? "/api/v3/work_packages?offset=1&pageSize=20" } }),
      columns: options.columns ?? [],
      ...(options.project === undefined
        ? { project: { href: null } }
        : {
          project: {
            href: `/api/v3/projects/${String(options.project[0])}`,
            title: options.project[1],
          },
        }),
    },
  };
}

describe("op-cli query run", () => {
  test("runs the stored query and shows the columns the query defines", async () => {
    const room = await makeRoom();
    const seen = installApi({
      "/api/v3/queries/7": queryResource(7, {
        results: "/api/v3/workspaces/5/work_packages?filters=%5B%5D&offset=1&pageSize=20",
        columns: [
          { href: "/api/v3/queries/columns/id", title: "ID" },
          { href: "/api/v3/queries/columns/subject", title: "Subject" },
          { href: "/api/v3/queries/columns/status" },
        ],
      }),
      "/api/v3/workspaces/5/work_packages?filters=%5B%5D&offset=1&pageSize=100": collection(1, [
        workPackage(41, "Fix login"),
      ]),
    });

    const result = await runQuery(room, ["7"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]?.trim().split(/\s+/)).toEqual(["ID", "SUBJECT", "STATUS"]);
    expect(lines[1]?.trim().split(/\s{2,}/)).toEqual(["41", "Fix login", "New"]);
    expect(seen).toEqual([
      "/api/v3/queries/7",
      "/api/v3/workspaces/5/work_packages?filters=%5B%5D&offset=1&pageSize=100",
    ]);
  });

  test("falls back to the fixed work package columns when the query defines none", async () => {
    const room = await makeRoom();
    installApi({
      "/api/v3/queries/7": queryResource(7),
      "/api/v3/work_packages?offset=1&pageSize=100": collection(1, [workPackage(41, "Fix login")]),
    });

    const result = await runQuery(room, ["7"]);

    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]?.trim().split(/\s+/)).toEqual([
      "ID", "SUBJECT", "TYPE", "STATUS", "PRIORITY", "ASSIGNEE", "UPDATED",
    ]);
    expect(lines[1]).toContain("Fix login");
  });

  test("without a results link it reads the project work packages, then the older route", async () => {
    const room = await makeRoom();
    const seen = installApi({
      "/api/v3/queries/7": queryResource(7, { results: null, project: [5, "Web"] }),
      "/api/v3/workspaces/5/work_packages?pageSize=100": 404,
      "/api/v3/projects/5/work_packages?pageSize=100": collection(1, [workPackage(41, "Fix login")]),
    });

    const result = await runQuery(room, ["7", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveLength(1);
    expect(seen).toEqual([
      "/api/v3/queries/7",
      "/api/v3/workspaces/5/work_packages?pageSize=100",
      "/api/v3/projects/5/work_packages?pageSize=100",
    ]);
  });

  test("without a results link and a project it reads every work package", async () => {
    const room = await makeRoom();
    installApi({
      "/api/v3/queries/7": queryResource(7, { results: null }),
      "/api/v3/work_packages?pageSize=100": collection(0, []),
    });

    const result = await runQuery(room, ["7", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("[]\n");
  });

  test("a results link under an instance subpath is cut to start at /api/v3", async () => {
    const base = "https://op.example.dev/openproject";
    const room = await makeRoom(undefined, base);
    const seen = installApi({
      "/openproject/api/v3/queries/7": queryResource(7, {
        results: "https://op.example.dev/openproject/api/v3/work_packages?offset=1&pageSize=20",
      }),
      "/openproject/api/v3/work_packages?offset=1&pageSize=100": collection(0, []),
    });

    const result = await runQuery(room, ["7", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(seen).toEqual([
      "/openproject/api/v3/queries/7",
      "/openproject/api/v3/work_packages?offset=1&pageSize=100",
    ]);
  });

  test("--limit sets the page size once and a partial page says so on stderr", async () => {
    const room = await makeRoom();
    const seen = installApi({
      "/api/v3/queries/7": queryResource(7),
      "/api/v3/work_packages?offset=1&pageSize=1": collection(3, [workPackage(41, "A")]),
    });

    const result = await runQuery(room, ["7", "--limit", "1", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveLength(1);
    expect(result.stderr).toBe(
      "Showing 1 of 3 work packages. Pass --all to fetch every result.\n",
    );
    expect(seen).toEqual(["/api/v3/queries/7", "/api/v3/work_packages?offset=1&pageSize=1"]);
  });

  test("--all --json streams one record per line across pages", async () => {
    const room = await makeRoom();
    installApi({
      "/api/v3/queries/7": queryResource(7),
      "/api/v3/": { maximumAPIV3PageSize: 2 },
      "/api/v3/work_packages?offset=1&pageSize=2": collection(
        3,
        [workPackage(41, "A"), workPackage(42, "B")],
        "/api/v3/work_packages?offset=2&pageSize=2",
      ),
      "/api/v3/work_packages?offset=2&pageSize=2": collection(3, [workPackage(43, "C")]),
    });

    const result = await runQuery(room, ["7", "--all", "--json", "--fields", "id,subject"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([
      { id: 41, subject: "A" },
      { id: 42, subject: "B" },
      { id: 43, subject: "C" },
    ]);
  });

  test("--fields makes the table columns, and an unknown field fails with the closest first", async () => {
    const room = await makeRoom();
    installApi({
      "/api/v3/queries/7": queryResource(7),
      "/api/v3/work_packages?offset=1&pageSize=100": collection(1, [workPackage(41, "Fix login")]),
    });

    const ok = await runQuery(room, ["7", "--fields", "id,subject"]);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.split("\n")[0]?.trim().split(/\s+/)).toEqual(["ID", "SUBJECT"]);

    const bad = await runQuery(room, ["7", "--json", "--fields", "subjct"]);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain("USAGE_ERROR");
    expect(bad.stderr).toMatch(/Valid fields, closest first: subject/);
  });

  test("--fields on an empty result is not an error", async () => {
    const room = await makeRoom();
    installApi({
      "/api/v3/queries/7": queryResource(7),
      "/api/v3/work_packages?offset=1&pageSize=100": collection(0, []),
    });

    const result = await runQuery(room, ["7", "--json", "--fields", "nonsense"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("[]\n");
  });

  test("bad --limit and conflicting scope flags are refused before any traffic", async () => {
    const room = await makeRoom();
    const seen = installApi({});

    const limit = await runQuery(room, ["7", "--limit", "0"]);
    const scope = await runQuery(room, ["7", "--global", "--all-projects"]);

    expect(limit.exitCode).not.toBe(0);
    expect(limit.stderr).toContain("USAGE_ERROR");
    expect(scope.exitCode).not.toBe(0);
    expect(scope.stderr).toContain("USAGE_ERROR");
    expect(seen).toEqual([]);
  });

  test("runs the default query of the default project", async () => {
    const room = await makeRoom(5);
    const seen = installApi({
      "/api/v3/workspaces/5/queries/default": queryResource(0, {
        results: "/api/v3/workspaces/5/work_packages?offset=1&pageSize=20",
      }),
      "/api/v3/workspaces/5/work_packages?offset=1&pageSize=100": collection(0, []),
    });

    const result = await runQuery(room, ["default", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(seen).toEqual([
      "/api/v3/workspaces/5/queries/default",
      "/api/v3/workspaces/5/work_packages?offset=1&pageSize=100",
    ]);
  });
});
