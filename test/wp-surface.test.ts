import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, test } from "vitest";

import { run } from "../src/run.js";
import { renderTable } from "../src/output/table.js";

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
): Promise<{ configDir: string; cacheDir: string }> {
  const configDir = join(root, "config");
  const cacheDir = join(root, "cache");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      default_profile: "default",
      active_profile: "default",
      profiles: { default: { url: instanceUrl } },
    }),
  );
  await writeFile(
    join(configDir, "credentials.json"),
    JSON.stringify({ default: { api_key: "secret-key" } }),
    { mode: 0o600 },
  );
  return { configDir, cacheDir };
}

const INSTANCE = "https://op.example";

interface WriteReply {
  readonly path: string;
  readonly method: "POST" | "DELETE";
  readonly status: number;
  readonly body?: unknown;
}

interface RecordedWrite {
  readonly path: string;
  readonly method: string;
  readonly body: string;
}

/**
 * Installs exactly the endpoints listed. Any other request fails the whole
 * run (net connect disabled), so a green run proves no extra HTTP traffic,
 * including no metadata prefetch behind the scenes.
 */
function installMockApi(options: {
  readonly instanceUrl?: string;
  readonly gets?: Record<string, unknown>;
  readonly writes?: ReadonlyArray<WriteReply>;
}): { agent: MockAgent; writes: Array<RecordedWrite> } {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  cleanups.push(async () => {
    await mockAgent.close();
    setGlobalDispatcher(new Agent());
  });
  const recorded: Array<RecordedWrite> = [];
  const pool = mockAgent.get(options.instanceUrl ?? INSTANCE);
  for (const [path, body] of Object.entries(options.gets ?? {})) {
    pool.intercept({ path, method: "GET" }).reply(200, body).persist();
  }
  for (const write of options.writes ?? []) {
    pool.intercept({ path: write.path, method: write.method }).reply((call) => {
      recorded.push({
        path: write.path,
        method: write.method,
        body: String(call.body ?? ""),
      });
      return { statusCode: write.status, data: write.body ?? {} };
    });
  }
  return { agent: mockAgent, writes: recorded };
}

// A scrubbed work package shaped like a real v3 response: its project and
// type links are what `wp schema` resolves on its own.
function workPackageElement(): Record<string, unknown> {
  return {
    _type: "WorkPackage",
    id: 1520,
    lockVersion: 7,
    subject: "Fix login redirect",
    createdAt: "2026-08-01T09:15:00Z",
    updatedAt: "2026-08-20T14:02:11Z",
    _links: {
      self: { href: "/api/v3/work_packages/1520" },
      project: { href: "/api/v3/projects/13", title: "Operations" },
      type: { href: "/api/v3/types/2", title: "Task" },
      status: { href: "/api/v3/statuses/12", title: "In progress" },
    },
  };
}

function commentActivity(
  id: number,
  raw: string,
  userId: number,
  userName: string,
): Record<string, unknown> {
  return {
    _type: "Activity::Comment",
    id,
    comment: { format: "markdown", raw },
    details: [],
    internal: false,
    createdAt: "2026-08-21T09:30:12Z",
    updatedAt: "2026-08-21T09:30:12Z",
    _links: {
      self: { href: `/api/v3/activities/${String(id)}` },
      workPackage: { href: "/api/v3/work_packages/1520", title: "Fix login redirect" },
      user: { href: `/api/v3/users/${String(userId)}`, title: userName },
    },
  };
}

function systemActivity(id: number, userName: string): Record<string, unknown> {
  return {
    _type: "Activity",
    id,
    comment: { format: "markdown", raw: "" },
    details: [],
    createdAt: "2026-08-20T14:02:11Z",
    updatedAt: "2026-08-20T14:02:11Z",
    _links: {
      self: { href: `/api/v3/activities/${String(id)}` },
      workPackage: { href: "/api/v3/work_packages/1520", title: "Fix login redirect" },
      user: { href: "/api/v3/users/5", title: userName },
    },
  };
}

function relationElement(
  id: number,
  fromId: number,
  fromTitle: string,
  toId: number,
  toTitle: string,
): Record<string, unknown> {
  return {
    _type: "Relation",
    id,
    name: "follows",
    type: "follows",
    reverseType: "precedes",
    lag: 2,
    description: null,
    _links: {
      self: { href: `/api/v3/relations/${String(id)}` },
      from: { href: `/api/v3/work_packages/${String(fromId)}`, title: fromTitle },
      to: { href: `/api/v3/work_packages/${String(toId)}`, title: toTitle },
    },
  };
}

function halCollection(
  total: number,
  elements: unknown[],
  nextHref?: string,
): Record<string, unknown> {
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

function activitiesPath(extra = ""): string {
  return `/api/v3/work_packages/1520/activities${extra}`;
}

function involvedFilters(id: number): unknown {
  return [{ involved: { operator: "=", values: [id] } }];
}

function relationsPath(id: number, extra = ""): string {
  return (
    `/api/v3/relations?filters=${encodeURIComponent(JSON.stringify(involvedFilters(id)))}${extra}`
  );
}

async function runWp(
  configDir: string,
  cacheDir: string,
  args: ReadonlyArray<string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return run(
    ["wp", ...args],
    { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
    {},
  );
}

describe("wp comments", () => {
  test("renders comment activities as a table and drops other activity kinds", async () => {
    const root = await makeTempRoom("op-cli-wp-comments-table-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      gets: {
        [activitiesPath("?pageSize=100")]: halCollection(2, [
          systemActivity(1479, "Tuan Ha"),
          commentActivity(1480, "Looks fixed on staging.", 9, "Linh Nguyen"),
        ]),
      },
    });

    const result = await runWp(configDir, cacheDir, ["comments", "1520"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      renderTable(
        ["ID", "AUTHOR", "COMMENT", "CREATED"],
        [
          ["1480", "Linh Nguyen", "Looks fixed on staging.", "2026-08-21T09:30:12Z"],
        ],
      ),
    );
  });

  test("--json emits a flat array of the derived rows", async () => {
    const root = await makeTempRoom("op-cli-wp-comments-json-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      gets: {
        [activitiesPath("?pageSize=100")]: halCollection(1, [
          commentActivity(1480, "Looks fixed on staging.", 9, "Linh Nguyen"),
        ]),
      },
    });

    const result = await runWp(configDir, cacheDir, ["comments", "1520", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      {
        id: 1480,
        kind: "Comment",
        user: { id: 9, name: "Linh Nguyen" },
        note: "Looks fixed on staging.",
        createdAt: "2026-08-21T09:30:12Z",
      },
    ]);
  });

  test("a truncated page says so on stderr and keeps exit 0", async () => {
    const root = await makeTempRoom("op-cli-wp-comments-truncated-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      gets: {
        [activitiesPath("?pageSize=100")]: halCollection(340, [
          commentActivity(1480, "First.", 9, "Linh Nguyen"),
          commentActivity(1481, "Second.", 9, "Linh Nguyen"),
        ]),
      },
    });

    const result = await runWp(configDir, cacheDir, ["comments", "1520"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(
      "Showing 2 of 340 records. Pass --all to fetch every result.\n",
    );
  });

  test("--limit sizes the requested page", async () => {
    const root = await makeTempRoom("op-cli-wp-comments-limit-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      gets: {
        [activitiesPath("?pageSize=5")]: halCollection(340, [
          commentActivity(1480, "First.", 9, "Linh Nguyen"),
        ]),
      },
    });

    const result = await runWp(configDir, cacheDir, ["comments", "1520", "--limit", "5"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Showing 1 of 340 records.");
  });

  test("--all consumes every page and streams NDJSON under --json", async () => {
    const root = await makeTempRoom("op-cli-wp-comments-all-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      gets: {
        "/api/v3/": {},
        [activitiesPath("?pageSize=100")]: halCollection(
          2,
          [commentActivity(1480, "First.", 9, "Linh Nguyen")],
          activitiesPath("?offset=2&pageSize=100"),
        ),
        [activitiesPath("?offset=2&pageSize=100")]: halCollection(2, [
          commentActivity(1481, "Second.", 9, "Linh Nguyen"),
        ]),
      },
    });

    const result = await runWp(configDir, cacheDir, [
      "comments",
      "1520",
      "--all",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ id: 1480 });
    expect(JSON.parse(lines[1] as string)).toMatchObject({ id: 1481 });
  });

  test("--fields picks the same named columns in both shapes", async () => {
    const root = await makeTempRoom("op-cli-wp-comments-fields-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      gets: {
        [activitiesPath("?pageSize=100")]: halCollection(1, [
          commentActivity(1480, "Looks fixed on staging.", 9, "Linh Nguyen"),
        ]),
      },
    });

    const table = await runWp(configDir, cacheDir, [
      "comments",
      "1520",
      "--fields",
      "id,note",
    ]);
    const json = await runWp(configDir, cacheDir, [
      "comments",
      "1520",
      "--fields",
      "id,note",
      "--json",
    ]);

    expect(table.exitCode).toBe(0);
    expect(table.stdout).toBe(
      renderTable(["ID", "COMMENT"], [["1480", "Looks fixed on staging."]]),
    );
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual([
      { id: 1480, note: "Looks fixed on staging." },
    ]);
  });

  test("an unknown --fields column exits 1 with a hint", async () => {
    const root = await makeTempRoom("op-cli-wp-comments-badfield-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({ gets: {} });

    const result = await runWp(configDir, cacheDir, [
      "comments",
      "1520",
      "--fields",
      "autho",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('field "autho" is not a column.');
  });

  test("a reference that is not all digits is refused before any traffic", async () => {
    const root = await makeTempRoom("op-cli-wp-comments-nonnumeric-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({ gets: {} });

    const result = await runWp(configDir, cacheDir, ["comments", "Fix login"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^\[USAGE_ERROR\]/);
  });
});

describe("wp history", () => {
  test("lists every activity kind with a KIND column", async () => {
    const root = await makeTempRoom("op-cli-wp-history-table-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      gets: {
        [activitiesPath("?pageSize=100")]: halCollection(2, [
          systemActivity(1479, "Tuan Ha"),
          commentActivity(1480, "Looks fixed on staging.", 9, "Linh Nguyen"),
        ]),
      },
    });

    const result = await runWp(configDir, cacheDir, ["history", "1520"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      renderTable(
        ["ID", "KIND", "AUTHOR", "NOTE", "CREATED"],
        [
          ["1479", "Activity", "Tuan Ha", "", "2026-08-20T14:02:11Z"],
          ["1480", "Comment", "Linh Nguyen", "Looks fixed on staging.", "2026-08-21T09:30:12Z"],
        ],
      ),
    );
  });
});

describe("wp relations", () => {
  test("lists the relations of one work package via the involved filter", async () => {
    const root = await makeTempRoom("op-cli-wp-relations-table-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      gets: {
        [relationsPath(1520, "&pageSize=100")]: halCollection(1, [
          relationElement(650, 1520, "Fix login redirect", 1401, "Ship 0.1"),
        ]),
      },
    });

    const result = await runWp(configDir, cacheDir, ["relations", "1520"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      renderTable(
        ["ID", "TYPE", "FROM", "TO", "LAG", "DESCRIPTION"],
        [["650", "follows", "Fix login redirect", "Ship 0.1", "2", ""]],
      ),
    );
  });

  test("--json carries the typed relation fields and both ends", async () => {
    const root = await makeTempRoom("op-cli-wp-relations-json-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      gets: {
        [relationsPath(1520, "&pageSize=100")]: halCollection(1, [
          relationElement(650, 1520, "Fix login redirect", 1401, "Ship 0.1"),
        ]),
      },
    });

    const result = await runWp(configDir, cacheDir, ["relations", "1520", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      {
        id: 650,
        type: "follows",
        reverseType: "precedes",
        lag: 2,
        description: null,
        from: { id: 1520, name: "Fix login redirect" },
        to: { id: 1401, name: "Ship 0.1" },
      },
    ]);
  });
});

describe("wp comment", () => {
  test("posts the comment raw text and renders the created activity", async () => {
    const root = await makeTempRoom("op-cli-wp-comment-post-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const { writes } = installMockApi({
      writes: [
        {
          path: activitiesPath(),
          method: "POST",
          status: 200,
          body: commentActivity(1480, "Deployed to staging.", 9, "Linh Nguyen"),
        },
      ],
    });

    const result = await runWp(configDir, cacheDir, [
      "comment",
      "1520",
      "Deployed to staging.",
    ]);

    expect(result.exitCode).toBe(0);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]?.body ?? "{}")).toEqual({
      comment: { raw: "Deployed to staging." },
    });
    expect(result.stdout).toBe(
      renderTable(
        ["FIELD", "VALUE"],
        [
          ["id", "1480"],
          ["createdAt", "2026-08-21T09:30:12Z"],
          ["updatedAt", "2026-08-21T09:30:12Z"],
          ["comment", '{"format":"markdown","raw":"Deployed to staging."}'],
          ["details", "[]"],
          ["internal", "false"],
          ["workPackage", "Fix login redirect"],
          ["user", "Linh Nguyen"],
        ],
      ),
    );
  });

  test("--json emits the flat created activity", async () => {
    const root = await makeTempRoom("op-cli-wp-comment-json-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      writes: [
        {
          path: activitiesPath(),
          method: "POST",
          status: 200,
          body: commentActivity(1480, "Deployed to staging.", 9, "Linh Nguyen"),
        },
      ],
    });

    const result = await runWp(configDir, cacheDir, [
      "comment",
      "1520",
      "Deployed to staging.",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      id: 1480,
      comment: { format: "markdown", raw: "Deployed to staging." },
      details: [],
      internal: false,
      createdAt: "2026-08-21T09:30:12Z",
      updatedAt: "2026-08-21T09:30:12Z",
      workPackage: { id: 1520, name: "Fix login redirect" },
      user: { id: 9, name: "Linh Nguyen" },
    });
  });

  test("a missing work package exits 4", async () => {
    const root = await makeTempRoom("op-cli-wp-comment-missing-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    cleanups.push(async () => {
      await mockAgent.close();
      setGlobalDispatcher(new Agent());
    });
    mockAgent
      .get(INSTANCE)
      .intercept({ path: "/api/v3/work_packages/999999/activities", method: "POST" })
      .reply(404, { _type: "Error", message: "WorkPackage 999999 does not exist." });

    const result = await runWp(configDir, cacheDir, ["comment", "999999", "hello"]);

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toMatch(/^\[NOT_FOUND\]/);
  });
});

describe("wp relate", () => {
  test("creates a relation by type name and renders it", async () => {
    const root = await makeTempRoom("op-cli-wp-relate-post-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const { writes } = installMockApi({
      writes: [
        {
          path: "/api/v3/work_packages/1520/relations",
          method: "POST",
          status: 200,
          body: relationElement(650, 1520, "Fix login redirect", 1401, "Ship 0.1"),
        },
      ],
    });

    const result = await runWp(configDir, cacheDir, [
      "relate",
      "1520",
      "1401",
      "--type",
      "Follows",
    ]);

    expect(result.exitCode).toBe(0);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]?.body ?? "{}")).toEqual({
      type: "follows",
      _links: { to: { href: "/api/v3/work_packages/1401" } },
    });
    expect(result.stdout).toBe(
      renderTable(
        ["FIELD", "VALUE"],
        [
          ["id", "650"],
          ["type", "follows"],
          ["name", "follows"],
          ["reverseType", "precedes"],
          ["lag", "2"],
          ["description", ""],
          ["from", "Fix login redirect"],
          ["to", "Ship 0.1"],
        ],
      ),
    );
  });

  test("an unknown relation type is refused with every valid value", async () => {
    const root = await makeTempRoom("op-cli-wp-relate-badtype-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({ gets: {} });

    const result = await runWp(configDir, cacheDir, [
      "relate",
      "1520",
      "1401",
      "--type",
      "siblings",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^\[USAGE_ERROR\]/);
    for (const valid of ["relates", "follows", "blocks", "requires"]) {
      expect(result.stderr).toContain(valid);
    }
  });
});

describe("wp unrelate", () => {
  test("a wrong --fields column refuses before any traffic and deletes nothing", async () => {
    const root = await makeTempRoom("op-cli-wp-unrelate-badfield-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const { writes } = installMockApi({ gets: {}, writes: [] });

    const result = await runWp(configDir, cacheDir, [
      "unrelate",
      "1520",
      "1401",
      "--fields",
      "typo",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('field "typo" is not a column.');
    expect(writes).toHaveLength(0);
  });

  test("finds the relation between two work packages and deletes it", async () => {
    const root = await makeTempRoom("op-cli-wp-unrelate-delete-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const { writes } = installMockApi({
      gets: {
        [relationsPath(1520, "&pageSize=100")]: halCollection(2, [
          relationElement(650, 1520, "Fix login redirect", 1401, "Ship 0.1"),
          relationElement(651, 1520, "Fix login redirect", 1500, "Other task"),
        ]),
      },
      writes: [{ path: "/api/v3/relations/650", method: "DELETE", status: 204 }],
    });

    const result = await runWp(configDir, cacheDir, ["unrelate", "1520", "1401"]);

    expect(result.exitCode).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ path: "/api/v3/relations/650", method: "DELETE" });
    expect(result.stdout).toBe(
      renderTable(
        ["FIELD", "VALUE"],
        [
          ["id", "650"],
          ["type", "follows"],
          ["reverseType", "precedes"],
          ["lag", "2"],
          ["description", ""],
          ["from", "Fix login redirect"],
          ["to", "Ship 0.1"],
        ],
      ),
    );
  });

  test("matches regardless of which end each work package sits on", async () => {
    const root = await makeTempRoom("op-cli-wp-unrelate-reverse-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const { writes } = installMockApi({
      gets: {
        [relationsPath(1520, "&pageSize=100")]: halCollection(1, [
          relationElement(650, 1401, "Ship 0.1", 1520, "Fix login redirect"),
        ]),
      },
      writes: [{ path: "/api/v3/relations/650", method: "DELETE", status: 204 }],
    });

    const result = await runWp(configDir, cacheDir, ["unrelate", "1520", "1401"]);

    expect(result.exitCode).toBe(0);
    expect(writes).toHaveLength(1);
  });

  test("no relation between the two work packages exits 4", async () => {
    const root = await makeTempRoom("op-cli-wp-unrelate-missing-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      gets: { [relationsPath(1520, "&pageSize=100")]: halCollection(0, []) },
    });

    const result = await runWp(configDir, cacheDir, ["unrelate", "1520", "1401"]);

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toMatch(/^\[NOT_FOUND\]/);
    expect(result.stderr).toContain("1401");
  });
});

describe("wp schema", () => {
  function schemaFixture(): Record<string, unknown> {
    return {
      _type: "Schema",
      id: { name: "ID", type: "Integer", required: true, writable: false },
      subject: { name: "Subject", type: "String", required: true, writable: true },
      status: { name: "Status", type: "Status", required: true, writable: true },
      estimatedHours: {
        name: "Estimated hours",
        type: "Float",
        required: false,
        writable: true,
      },
      createdAt: { name: "Created on", type: "DateTime", required: true, writable: false },
      _links: { self: { href: "/api/v3/work_packages/schemas/13-2" } },
    };
  }

  function installSchemaRoom(prefix: string): Promise<{
    configDir: string;
    cacheDir: string;
  }> {
    return (async () => {
      const room = await writeSingleProfile(await makeTempRoom(prefix), INSTANCE);
      installMockApi({
        gets: {
          "/api/v3/work_packages/1520": workPackageElement(),
          "/api/v3/work_packages/schemas/13-2": schemaFixture(),
        },
      });
      return room;
    })();
  }

  test("resolves project and type of the work package on its own", async () => {
    const { configDir, cacheDir } = await installSchemaRoom("op-cli-wp-schema-table-");

    const result = await runWp(configDir, cacheDir, ["schema", "1520"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      renderTable(
        ["FIELD", "NAME", "TYPE", "REQUIRED", "WRITABLE"],
        [
          ["id", "ID", "Integer", "true", "false"],
          ["subject", "Subject", "String", "true", "true"],
          ["status", "Status", "Status", "true", "true"],
          ["estimatedHours", "Estimated hours", "Float", "false", "true"],
          ["createdAt", "Created on", "DateTime", "true", "false"],
        ],
      ),
    );
  });

  test("--json emits one flat record per available field", async () => {
    const { configDir, cacheDir } = await installSchemaRoom("op-cli-wp-schema-json-");

    const result = await runWp(configDir, cacheDir, ["schema", "1520", "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(5);
    expect(parsed[0]).toEqual({
      field: "id",
      name: "ID",
      type: "Integer",
      required: true,
      writable: false,
    });
  });


  test("--fields picks the same named columns in the table", async () => {
    const { configDir, cacheDir } = await installSchemaRoom("op-cli-wp-schema-fields-");

    const result = await runWp(configDir, cacheDir, [
      "schema",
      "1520",
      "--fields",
      "field,writable",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      renderTable(
        ["FIELD", "WRITABLE"],
        [
          ["id", "false"],
          ["subject", "true"],
          ["status", "true"],
          ["estimatedHours", "true"],
          ["createdAt", "false"],
        ],
      ),
    );
  });

  test("a schema that does not exist for the resolved pair exits 4", async () => {
    const root = await makeTempRoom("op-cli-wp-schema-missing-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    cleanups.push(async () => {
      await mockAgent.close();
      setGlobalDispatcher(new Agent());
    });
    const pool = mockAgent.get(INSTANCE);
    pool.intercept({ path: "/api/v3/work_packages/1520", method: "GET" })
      .reply(200, workPackageElement());
    pool.intercept({ path: "/api/v3/work_packages/schemas/13-2", method: "GET" })
      .reply(404, { _type: "Error", message: "The specified schema does not exist." });

    const result = await runWp(configDir, cacheDir, ["schema", "1520"]);

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toMatch(/^\[NOT_FOUND\]/);
  });
});

describe("wp surface registration", () => {
  test("all seven commands are registered on the wp group", async () => {
    const root = await makeTempRoom("op-cli-wp-surface-help-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);

    const result = await run(
      ["wp", "--help"],
      { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
      {},
    );

    expect(result.exitCode).toBe(0);
    for (const name of [
      "comment",
      "comments",
      "history",
      "relations",
      "relate",
      "unrelate",
      "schema",
    ]) {
      expect(result.stdout).toContain(name);
    }
  });
});
