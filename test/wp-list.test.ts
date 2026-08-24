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

interface VocabEntry {
  readonly id: number;
  readonly name: string;
}

function baseMetadata(statuses?: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> {
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
          { id: 9, name: "Rejected", is_closed: true, is_default: false },
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

async function writeMetadataFile(
  cacheDir: string,
  metadata: unknown,
): Promise<void> {
  const dir = join(cacheDir, "default");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "metadata.json"), JSON.stringify(metadata));
}

interface InstallOptions {
  readonly packages?: Record<string, unknown>;
  /** Intercepted exactly once each; a second hit fails the run. */
  readonly oneShots?: Record<string, unknown>;
}

/**
 * Installs exactly the endpoints listed. Any other request fails the whole
 * agent (net connect disabled), so a green run proves no extra HTTP traffic,
 * including no metadata prefetch or a second metadata refresh.
 */
function installMockApi(options: InstallOptions): MockAgent {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  cleanups.push(async () => {
    await mockAgent.close();
    setGlobalDispatcher(new Agent());
  });
  const pool = mockAgent.get(INSTANCE);
  for (const [path, body] of Object.entries(options.packages ?? {})) {
    pool.intercept({ path, method: "GET" }).reply(200, body).persist();
  }
  for (const [path, body] of Object.entries(options.oneShots ?? {})) {
    pool.intercept({ path, method: "GET" }).reply(200, body);
  }
  return mockAgent;
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

function wpElement(id: number, subject: string): Record<string, unknown> {
  return {
    _type: "WorkPackage",
    id,
    lockVersion: 1,
    subject,
    createdAt: "2026-08-01T09:15:00Z",
    updatedAt: "2026-08-20T14:02:11Z",
    _links: {
      self: { href: `/api/v3/work_packages/${String(id)}` },
      project: { href: "/api/v3/projects/13", title: "Operations" },
      type: { href: "/api/v3/types/2", title: "Task" },
      status: { href: "/api/v3/statuses/1", title: "In progress" },
      priority: { href: "/api/v3/priorities/3", title: "High" },
      assignee: { href: "/api/v3/users/9", title: "Linh Nguyen" },
    },
  };
}

function filtersParam(filters: unknown): string {
  return encodeURIComponent(JSON.stringify(filters));
}

function listPath(filters: unknown, pageSize: number, extra = ""): string {
  return (
    `/api/v3/work_packages?filters=${filtersParam(filters)}` +
    `&pageSize=${String(pageSize)}${extra}`
  );
}

/**
 * The clause a project in context has to add to every listing: the tests
 * below spell the whole path out, so a dropped project scope fails the
 * mock agent instead of quietly widening the query (#19).
 */
const PROJECT_13 = { project: { operator: "=", values: ["13"] } };

function scopedPath(filters: unknown[], pageSize: number, extra = ""): string {
  return listPath([PROJECT_13, ...filters], pageSize, extra);
}

function vocabEndpoints(metadata: Record<string, unknown>): Record<string, unknown> {
  return {
    "/api/v3/types": halCollection(
      (metadata.types as VocabEntry[]).length,
      metadata.types,
    ),
    "/api/v3/statuses": halCollection(
      (metadata.statuses as VocabEntry[]).length,
      metadata.statuses,
    ),
    "/api/v3/priorities": halCollection(
      (metadata.priorities as VocabEntry[]).length,
      metadata.priorities,
    ),
    "/api/v3/projects/13": {
      _type: "Project",
      id: 13,
      identifier: "operations",
      name: "Operations",
    },
    "/api/v3/": {
    },
  };
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

function localIsoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${String(date.getFullYear())}-${month}-${day}`;
}

describe("wp list filters", () => {
  test("a status name resolves through the cached metadata into its id", async () => {
    const root = await makeTempRoom("wp-list-status-name-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE, 13);
    await writeMetadataFile(cacheDir, baseMetadata());
    installMockApi({
      packages: {
        [scopedPath([{ status: { operator: "=", values: ["1"] } }], 100)]: halCollection(
          1,
          [wpElement(1520, "Fix login redirect")],
        ),
      },
    });
    const result = await runWp(configDir, cacheDir, ["list", "--status", "In progress"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Fix login redirect");
  });

  test("an all-digits value is used as an id and never resolved", async () => {
    const root = await makeTempRoom("wp-list-digits-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE, 13);
    installMockApi({
      packages: {
        [scopedPath([{ status: { operator: "=", values: ["5"] } }], 100)]: halCollection(
          0,
          [],
        ),
      },
    });
    const result = await runWp(configDir, cacheDir, ["list", "--status", "5"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("a stale name succeeds after exactly one automatic refresh", async () => {
    const root = await makeTempRoom("wp-list-stale-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE, 13);
    await writeMetadataFile(
      cacheDir,
      baseMetadata([{ id: 99, name: "Archived", is_closed: true, is_default: false }]),
    );
    const fresh = baseMetadata();
    const endpoints = vocabEndpoints(fresh);
    delete endpoints["/api/v3/statuses"];
    installMockApi({
      packages: {
        ...endpoints,
        [scopedPath([{ status: { operator: "=", values: ["1"] } }], 100)]: halCollection(
          1,
          [wpElement(1521, "Refreshed result")],
        ),
      },
      // Consumed once; a second refresh attempt would fail the whole run.
      oneShots: {
        "/api/v3/statuses": halCollection(3, fresh.statuses),
      },
    });
    const result = await runWp(configDir, cacheDir, ["list", "--status", "In progress"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Refreshed result");
  });

  test("an unknown name exits 1 listing the closest valid values", async () => {
    const root = await makeTempRoom("wp-list-unknown-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE, 13);
    await writeMetadataFile(cacheDir, baseMetadata());
    const metadata = baseMetadata();
    installMockApi({
      packages: vocabEndpoints(metadata),
    });
    const result = await runWp(configDir, cacheDir, ["list", "--status", "Opn"]);
    expect(result.stderr).toContain("In progress");
  });

  test("an ambiguous member name exits 1 listing candidates with their kind", async () => {
    const root = await makeTempRoom("wp-list-ambiguous-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE, 13);
    await writeMetadataFile(cacheDir, {
      ...baseMetadata(),
      projectScoped: {
        "13": {
          project_id: 13,
          fetched_at: "2026-08-23T00:00:00Z",
          members: [
            { membership_id: 1, user_id: 7, name: "Alex", type: "User", roles: [] },
            { membership_id: 2, user_id: 12, name: "Alex", type: "Group", roles: [] },
          ],
          versions: [],
          categories: [],
          activities: [],
          custom_fields: {},
        },
      },
    });
    installMockApi({});
    const result = await runWp(configDir, cacheDir, ["list", "--assignee", "Alex"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('[USAGE_ERROR] assignee "Alex" is ambiguous');
    expect(result.stderr).toContain("7 (User), 12 (Group)");
  });

  test("--assignee me resolves to the authenticated user", async () => {
    const root = await makeTempRoom("wp-list-me-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      packages: {
        "/api/v3/users/me": { id: 5, name: "Tuan Ha", login: "tuan" },
        [listPath([{ assigned_to: { operator: "=", values: ["5"] } }], 100)]: halCollection(
          1,
          [wpElement(1522, "My own task")],
        ),
      },
    });
    const result = await runWp(configDir, cacheDir, ["list", "--assignee", "me"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("My own task");
  });

  test("--open maps to the o operator without touching metadata", async () => {
    const root = await makeTempRoom("wp-list-open-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE, 13);
    installMockApi({
      packages: {
        [scopedPath([{ status: { operator: "o", values: [] } }], 100)]: halCollection(
          0,
          [],
        ),
      },
    });
    const result = await runWp(configDir, cacheDir, ["list", "--open"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("--closed maps to the c operator without touching metadata", async () => {
    const root = await makeTempRoom("wp-list-closed-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE, 13);
    installMockApi({
      packages: {
        [scopedPath([{ status: { operator: "c", values: [] } }], 100)]: halCollection(
          0,
          [],
        ),
      },
    });
    const result = await runWp(configDir, cacheDir, ["list", "--closed"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("repeating a flag ORs the resolved values", async () => {
    const root = await makeTempRoom("wp-list-or-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE, 13);
    await writeMetadataFile(cacheDir, baseMetadata());
    installMockApi({
      packages: {
        [scopedPath([{ priority: { operator: "=", values: ["3", "4"] } }], 100)]: halCollection(
          0,
          [],
        ),
      },
    });
    const result = await runWp(configDir, cacheDir, [
      "list",
      "--priority",
      "High",
      "--priority",
      "Low",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("--updated-after 7d sends an open-ended window from seven days back", async () => {
    const root = await makeTempRoom("wp-list-7d-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE, 13);
    const now = new Date();
    const start = localIsoDate(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7),
    );
    installMockApi({
      packages: {
        // The empty upper bound is the fix for #24: a closed one drops
        // everything changed during its own day.
        [scopedPath([
          { updated_at: { operator: "<>d", values: [start, ""] } },
        ], 100)]: halCollection(0, []),
      },
    });
    const result = await runWp(configDir, cacheDir, ["list", "--updated-after", "7d"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("a project-scoped name without a project context exits 1", async () => {
    const root = await makeTempRoom("wp-list-noproject-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({});
    const result = await runWp(configDir, cacheDir, ["list", "--version", "0.1.0"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--version");
    expect(result.stderr).toContain("project");
  });

  test("a parent name resolves through an exact subject search", async () => {
    const root = await makeTempRoom("wp-list-parent-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE, 13);
    installMockApi({
      packages: {
        // Resolving a parent by subject is resolution, not a listing:
        // it stays instance-wide, while the listing itself is scoped.
        [listPath([{ subject: { operator: "=", values: ["Fix login"] } }], 100)]: halCollection(
          1,
          [wpElement(900, "Fix login")],
        ),
        [scopedPath([{ parent: { operator: "=", values: ["900"] } }], 100)]: halCollection(
          0,
          [],
        ),
      },
    });
    const result = await runWp(configDir, cacheDir, ["list", "--parent", "Fix login"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("--open together with --closed exits 1 before any request", async () => {
    const root = await makeTempRoom("wp-list-conflict-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE, 13);
    installMockApi({});
    const result = await runWp(configDir, cacheDir, ["list", "--open", "--closed"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--open and --closed");
  });
});

describe("wp list pagination and shapes", () => {
  test("default limit is 100 and truncation warns on stderr while exiting 0", async () => {
    const root = await makeTempRoom("wp-list-truncated-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE, 13);
    const elements = Array.from({ length: 100 }, (_, index) =>
      wpElement(index + 1, `Work package ${String(index + 1)}`),
    );
    installMockApi({
      packages: {
        [scopedPath([], 100)]: halCollection(340, elements),
      },
    });
    const result = await runWp(configDir, cacheDir, ["list"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Showing 100 of 340 work packages");
    expect(result.stdout).toContain("Work package 1");
    expect(result.stdout).toContain("Work package 100");
    expect(result.stdout).not.toContain("Work package 101");
  });

  test("--limit overrides the requested page size", async () => {
    const root = await makeTempRoom("wp-list-limit-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE, 13);
    installMockApi({
      packages: {
        [scopedPath([], 2)]: halCollection(2, [
          wpElement(1, "First"),
          wpElement(2, "Second"),
        ]),
      },
    });
    const result = await runWp(configDir, cacheDir, ["list", "--limit", "2"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("First");
    expect(result.stdout).toContain("Second");
  });

  test("--all fetches every page and never warns", async () => {
    const root = await makeTempRoom("wp-list-all-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE, 13);
    const filters = filtersParam([PROJECT_13]);
    installMockApi({
      packages: {
        [scopedPath([], 100)]: halCollection(3, [wpElement(1, "One"), wpElement(2, "Two")],
          `/api/v3/work_packages?filters=${filters}&pageSize=100&offset=2`),
        [scopedPath([], 100, "&offset=2")]: halCollection(3, [wpElement(3, "Three")]),
      },
    });
    const result = await runWp(configDir, cacheDir, ["list", "--all"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("One");
    expect(result.stdout).toContain("Two");
    expect(result.stdout).toContain("Three");
  });

  test("--json emits a flat array of flattened records", async () => {
    const root = await makeTempRoom("wp-list-json-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE, 13);
    installMockApi({
      packages: {
        [scopedPath([], 100)]: halCollection(2, [
          wpElement(1, "One"),
          wpElement(2, "Two"),
        ]),
      },
    });
    const result = await runWp(configDir, cacheDir, ["list", "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    for (const record of parsed) {
      expect(record).not.toHaveProperty("_links");
      expect(record).not.toHaveProperty("_embedded");
      expect(record).not.toHaveProperty("_type");
      expect(record.subject).toBe("One");
      break;
    }
    expect(parsed[0]?.status).toEqual({ id: 1, name: "In progress" });
  });

  test("a truncated --json result still warns on stderr", async () => {
    const root = await makeTempRoom("wp-list-json-trunc-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE, 13);
    installMockApi({
      packages: {
        [scopedPath([], 100)]: halCollection(5, [wpElement(1, "One"), wpElement(2, "Two")]),
      },
    });
    const result = await runWp(configDir, cacheDir, ["list", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Showing 2 of 5 work packages");
  });

  test("--all --json streams NDJSON, one record per line", async () => {
    const root = await makeTempRoom("wp-list-ndjson-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE, 13);
    const filters = filtersParam([PROJECT_13]);
    installMockApi({
      packages: {
        [scopedPath([], 100)]: halCollection(3, [wpElement(1, "One"), wpElement(2, "Two")],
          `/api/v3/work_packages?filters=${filters}&pageSize=100&offset=2`),
        [scopedPath([], 100, "&offset=2")]: halCollection(3, [wpElement(3, "Three")]),
      },
    });
    const result = await runWp(configDir, cacheDir, ["list", "--all", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.map((record) => record.id)).toEqual([1, 2, 3]);
  });
});

describe("wp count", () => {
  test("shares the filter flags and uses a one-element page", async () => {
    const root = await makeTempRoom("wp-count-flags-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE, 13);
    await writeMetadataFile(cacheDir, baseMetadata());
    installMockApi({
      packages: {
        [scopedPath([
          { status: { operator: "=", values: ["5"] } },
          { priority: { operator: "=", values: ["3"] } },
        ], 1)]: halCollection(42, []),
      },
    });
    const result = await runWp(configDir, cacheDir, [
      "count",
      "--status",
      "Closed",
      "--priority",
      "High",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("42\n");
  });

  test("with no flags it sends an empty filter array and prints the total", async () => {
    const root = await makeTempRoom("wp-count-plain-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE, 13);
    installMockApi({
      packages: {
        [scopedPath([], 1)]: halCollection(7, []),
      },
    });
    const result = await runWp(configDir, cacheDir, ["count"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("7\n");
  });
});

describe("wp list and wp count project scope", () => {
  test("a profile default project narrows the listing", async () => {
    const root = await makeTempRoom("wp-list-default-project-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE, 13);
    installMockApi({
      packages: {
        [scopedPath([], 100)]: halCollection(1, [wpElement(1520, "Fix login redirect")]),
      },
    });
    const result = await runWp(configDir, cacheDir, ["list"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Fix login redirect");
  });

  test("--project overrides the profile default project", async () => {
    const root = await makeTempRoom("wp-list-project-override-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE, 13);
    installMockApi({
      packages: {
        [listPath([{ project: { operator: "=", values: ["33"] } }], 100)]:
          halCollection(1, [wpElement(3204, "Scratch item")]),
      },
    });
    const result = await runWp(configDir, cacheDir, ["list", "--project", "33"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Scratch item");
  });

  test("wp count asks for the project total, not the instance total", async () => {
    const root = await makeTempRoom("wp-count-project-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      packages: {
        [listPath([{ project: { operator: "=", values: ["33"] } }], 1)]:
          halCollection(3, []),
      },
    });
    const result = await runWp(configDir, cacheDir, ["count", "--project", "33"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("3\n");
  });

  test("with no project in context the listing stays instance-wide", async () => {
    const root = await makeTempRoom("wp-list-no-project-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      packages: {
        [listPath([], 100)]: halCollection(1, [wpElement(1520, "Fix login redirect")]),
      },
    });
    const result = await runWp(configDir, cacheDir, ["list"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Fix login redirect");
  });
});
