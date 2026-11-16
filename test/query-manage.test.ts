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

async function makeRoom(): Promise<{ configDir: string; cacheDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "query-manage-"));
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
      profiles: { default: { url: INSTANCE } },
    }),
  );
  await writeFile(
    join(configDir, "credentials.json"),
    JSON.stringify({ default: { api_key: "secret-key" } }),
    { mode: 0o600 },
  );
  return { configDir, cacheDir: join(root, "cache") };
}

interface Route {
  readonly method: "GET" | "PATCH" | "DELETE";
  readonly path: string;
  readonly status?: number;
  readonly body?: unknown;
  /** Make the request fail at the network level instead of answering. */
  readonly fail?: boolean;
}

/** Exactly the listed routes answer; any other request fails the run. */
function installApi(routes: ReadonlyArray<Route>): Array<string> {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  cleanups.push(async () => {
    await mockAgent.close();
    setGlobalDispatcher(new Agent());
  });
  const seen: Array<string> = [];
  const pool = mockAgent.get(INSTANCE);
  for (const route of routes) {
    const interceptor = pool.intercept({ path: route.path, method: route.method });
    if (route.fail === true) {
      interceptor.replyWithError(new Error("socket hang up"));
      continue;
    }
    interceptor.reply(() => {
      seen.push(`${route.method} ${route.path}`);
      return { statusCode: route.status ?? 200, data: route.body ?? {} };
    });
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

function queryBody(id: number, name: string, starred: boolean): Record<string, unknown> {
  return {
    _type: "Query",
    id,
    name,
    starred,
    public: false,
    sums: false,
    includeSubprojects: true,
    showHierarchies: true,
    filters: [],
    _links: { columns: [{ href: "/api/v3/queries/columns/id" }] },
  };
}

describe("query star / unstar", () => {
  test("star by id sends PATCH /star with {} and renders the starred record", async () => {
    const room = await makeRoom();
    const seen = installApi([
      { method: "PATCH", path: "/api/v3/queries/7/star", body: queryBody(7, "Roadmap", true) },
    ]);
    const result = await runQuery(room, ["star", "7", "--json", "--fields", "id,starred"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ id: 7, starred: true });
    expect(seen).toEqual(["PATCH /api/v3/queries/7/star"]);
  });

  test("unstar by exact name walks the scoped collection, then PATCHes /unstar", async () => {
    const room = await makeRoom();
    const seen = installApi([
      {
        method: "GET",
        path: "/api/v3/queries?pageSize=100",
        body: {
          _type: "Collection",
          total: 1,
          count: 1,
          _embedded: { elements: [queryBody(7, "Roadmap", true)] },
          _links: { self: { href: "/self" } },
        },
      },
      { method: "PATCH", path: "/api/v3/queries/7/unstar", body: queryBody(7, "Roadmap", false) },
    ]);
    const result = await runQuery(room, ["unstar", "Roadmap"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("starred");
    expect(seen).toContain("PATCH /api/v3/queries/7/unstar");
  });

  test("a bad --fields column after the star names the completed mutation", async () => {
    const room = await makeRoom();
    installApi([
      { method: "PATCH", path: "/api/v3/queries/7/star", body: queryBody(7, "Roadmap", true) },
    ]);
    const result = await runQuery(room, ["star", "7", "--fields", "nope"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('query 7 was starred; field "nope" is not a column');
  });

  test("the literal default is refused locally, with no traffic", async () => {
    const room = await makeRoom();
    const seen = installApi([]);
    for (const verb of ["star", "unstar", "delete"]) {
      const args = verb === "delete" ? [verb, "default", "--yes"] : [verb, "default"];
      const result = await runQuery(room, args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "the default query is not a saved query and cannot be modified.",
      );
    }
    expect(seen).toEqual([]);
  });

  test("a 404 maps to NOT_FOUND and a 5xx to the unknown-state exit 6", async () => {
    const room = await makeRoom();
    installApi([{ method: "PATCH", path: "/api/v3/queries/9/star", status: 404 }]);
    const missing = await runQuery(room, ["star", "9"]);
    expect(missing.exitCode).toBe(4);

    const room2 = await makeRoom();
    installApi([{ method: "PATCH", path: "/api/v3/queries/9/star", status: 502 }]);
    const broken = await runQuery(room2, ["star", "9"]);
    expect(broken.exitCode).toBe(6);
    expect(broken.stderr).toContain("whether the query was starred is unknown");
    expect(broken.stderr).toContain("op-cli query get 9");
  });

  test("a network failure is never retried and says the outcome is unknown", async () => {
    const room = await makeRoom();
    installApi([{ method: "PATCH", path: "/api/v3/queries/9/unstar", fail: true }]);
    const result = await runQuery(room, ["unstar", "9"]);
    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain("whether the query was unstarred is unknown");
  });
});

describe("query delete", () => {
  test("without --yes nothing is sent", async () => {
    const room = await makeRoom();
    const seen = installApi([]);
    const result = await runQuery(room, ["delete", "7"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'query delete refuses to remove "7" without confirmation; deleting a query is irreversible.',
    );
    expect(result.stderr).toContain("repeat the command with --yes to confirm the deletion.");
    expect(seen).toEqual([]);
  });

  test("a numeric id sends only DELETE and confirms", async () => {
    const room = await makeRoom();
    const seen = installApi([{ method: "DELETE", path: "/api/v3/queries/7", status: 204 }]);
    const result = await runQuery(room, ["delete", "7", "--yes"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Deleted query 7.\n");
    expect(seen).toEqual(["DELETE /api/v3/queries/7"]);
  });

  test("a name resolves live and the confirmation names the query", async () => {
    const room = await makeRoom();
    const seen = installApi([
      {
        method: "GET",
        path: "/api/v3/queries?pageSize=100",
        body: {
          _type: "Collection",
          total: 1,
          count: 1,
          _embedded: { elements: [queryBody(7, "Roadmap", false)] },
          _links: { self: { href: "/self" } },
        },
      },
      { method: "DELETE", path: "/api/v3/queries/7", status: 204 },
    ]);
    const result = await runQuery(room, ["delete", "Roadmap", "--yes"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("Deleted query Roadmap (7).\n");
    expect(seen).toContain("DELETE /api/v3/queries/7");
  });

  test("a 403 is a refusal and a 5xx is the unknown-state exit 6", async () => {
    const room = await makeRoom();
    installApi([{ method: "DELETE", path: "/api/v3/queries/7", status: 403 }]);
    const refused = await runQuery(room, ["delete", "7", "--yes"]);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.exitCode).not.toBe(6);

    const room2 = await makeRoom();
    installApi([{ method: "DELETE", path: "/api/v3/queries/7", status: 500 }]);
    const broken = await runQuery(room2, ["delete", "7", "--yes"]);
    expect(broken.exitCode).toBe(6);
    expect(broken.stderr).toContain("whether the query was deleted is unknown");
    expect(broken.stderr).toContain("op-cli query list");
  });
});
