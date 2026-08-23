import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
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

interface InstallOptions {
  readonly instanceUrl: string;
  readonly types?: unknown[];
  readonly nextPage?: { readonly path: string; readonly elements: unknown[] };
  readonly statuses?: unknown[];
  readonly priorities?: unknown[];
  readonly root?: Record<string, unknown>;
  readonly project?: Record<string, unknown>;
  readonly members?: Record<number, unknown[]>;
  readonly versions?: Record<number, unknown[]>;
  readonly categories?: Record<number, unknown[]>;
  readonly activities?: { readonly allowedValues: unknown[] };
  readonly projectTypes?: Record<number, unknown[]>;
  readonly schemas?: Record<string, Record<string, unknown>>;
}
function membership(
  membershipId: number,
  principal: { readonly kind: string; readonly segment: string; readonly id: number; readonly name: string },
  roles: ReadonlyArray<{ readonly id: number; readonly title: string }>,
): Record<string, unknown> {
  return {
    _type: "Membership",
    id: membershipId,
    _embedded: {
      principal: { _type: principal.kind, id: principal.id, name: principal.name },
    },
    _links: {
      project: { href: "/api/v3/projects/13", title: "Operations" },
      principal: {
        href: `/api/v3/${principal.segment}/${String(principal.id)}`,
        title: principal.name,
      },
      roles: roles.map((role) => ({
        href: `/api/v3/roles/${String(role.id)}`,
        title: role.title,
      })),
    },
  };
}

function projectFilters(projectId: number): string {
  return encodeURIComponent(
    JSON.stringify([{ project: { operator: "=", values: [String(projectId)] } }]),
  );
}


function halCollection(elements: unknown[], nextHref?: string): Record<string, unknown> {
  return {
    _type: "Collection",
    total: elements.length,
    count: elements.length,
    _embedded: { elements },
    _links: {
      self: { href: "/self" },
      ...(nextHref === undefined
        ? {}
        : { nextByOffset: { href: nextHref } }),
    },
  };
}

function installMockApi(options: InstallOptions): MockAgent {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  cleanups.push(async () => {
    await mockAgent.close();
    setGlobalDispatcher(new Agent());
  });
  const pool = mockAgent.get(options.instanceUrl);
  if (options.types !== undefined) {
    pool
      .intercept({ path: "/api/v3/types", method: "GET" })
      .reply(200, halCollection(options.types, options.nextPage?.path))
      .persist();
  }
  if (options.nextPage !== undefined) {
    pool
      .intercept({ path: options.nextPage.path, method: "GET" })
      .reply(200, halCollection(options.nextPage.elements))
      .persist();
  }
  if (options.statuses !== undefined) {
    pool
      .intercept({ path: "/api/v3/statuses", method: "GET" })
      .reply(200, halCollection(options.statuses))
      .persist();
  }
  if (options.priorities !== undefined) {
    pool
      .intercept({ path: "/api/v3/priorities", method: "GET" })
      .reply(200, halCollection(options.priorities))
      .persist();
  }
  pool.intercept({ path: "/api/v3/", method: "GET" }).reply(
    200,
    options.root ?? { _type: "API", apiVersion: "v3", coreVersion: "13.4" },
  ).persist();
  if (options.project !== undefined) {
    pool
      .intercept({ path: `/api/v3/projects/${String(options.project.id)}`, method: "GET" })
      .reply(200, options.project)
      .persist();
  }
  for (const [projectId, elements] of Object.entries(options.members ?? {})) {
    pool
      .intercept({
        path: `/api/v3/memberships?filters=${projectFilters(Number(projectId))}`,
        method: "GET",
      })
      .reply(200, halCollection(elements))
      .persist();
  }
  for (const [projectId, elements] of Object.entries(options.versions ?? {})) {
    pool
      .intercept({
        path: `/api/v3/projects/${projectId}/versions`,
        method: "GET",
      })
      .reply(200, halCollection(elements))
      .persist();
  }
  for (const [projectId, elements] of Object.entries(options.categories ?? {})) {
    pool
      .intercept({
        path: `/api/v3/projects/${projectId}/categories`,
        method: "GET",
      })
      .reply(200, halCollection(elements))
      .persist();
  }
  if (options.activities !== undefined) {
    pool
      .intercept({ path: "/api/v3/time_entries/schema", method: "GET" })
      .reply(200, {
        _type: "Schema",
        activity: {
          type: "TimeEntriesActivity",
          name: "Time entry activity",
          required: false,
          hasDefault: true,
          writable: true,
          allowedValues: options.activities.allowedValues,
        },
      })
      .persist();
  }
  for (const [projectId, elements] of Object.entries(options.projectTypes ?? {})) {
    pool
      .intercept({
        path: `/api/v3/projects/${projectId}/types`,
        method: "GET",
      })
      .reply(200, halCollection(elements))
      .persist();
  }
  for (const [key, schema] of Object.entries(options.schemas ?? {})) {
    pool
      .intercept({
        path: `/api/v3/work_packages/schemas/${key}`,
        method: "GET",
      })
      .reply(200, schema)
      .persist();
  }
  return mockAgent;
}

function taskType(): Record<string, unknown> {
  return {
    _type: "Type",
    id: 2,
    name: "Task",
    color: "#0b8043",
    position: 1,
    isMilestone: false,
    isDefault: true,
  };
}

function milestoneType(): Record<string, unknown> {
  return {
    _type: "Type",
    id: 5,
    name: "Milestone",
    color: null,
    position: 2,
    isMilestone: true,
    isDefault: false,
  };
}

const standardStatuses: Array<Record<string, unknown>> = [
  {
    _type: "Status",
    id: 12,
    name: "In progress",
    color: "#1d78c9",
    position: 1,
    isClosed: false,
    isDefault: true,
  },
  {
    _type: "Status",
    id: 77,
    name: "Rejected",
    color: "#c23b22",
    position: 4,
    isClosed: true,
    isDefault: false,
  },
];

const standardPriorities: Array<Record<string, unknown>> = [
  {
    _type: "Priority",
    id: 8,
    name: "Low",
    color: "#aaaaaa",
    position: 3,
    isDefault: false,
  },
  {
    _type: "Priority",
    id: 3,
    name: "High",
    color: "#cc0000",
    position: 1,
    isDefault: true,
  },
];

function baseInstall(instanceUrl: string): InstallOptions {
  return {
    instanceUrl,
    types: [taskType(), milestoneType()],
    statuses: standardStatuses,
    priorities: standardPriorities,
  };
}

async function readStore(cacheDir: string, leaf: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(join(cacheDir, leaf, "metadata.json"), "utf8"),
  ) as Record<string, unknown>;
}

describe("meta vocabulary lookups", () => {
  test("a lookup on an empty store fetches, renders and persists", async () => {
    const root = await makeTempRoom("op-cli-meta-lazy-");
    const { configDir, cacheDir } = await writeSingleProfile(root, "https://op.example");
    installMockApi(baseInstall("https://op.example"));

    const result = await run(
      ["meta", "types"],
      { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
      {},
    );

    expect(result).toEqual({
      stdout:
        "ID  NAME       MILESTONE\n" +
        "5   Milestone  *\n" +
        "2   Task\n",
      stderr: "",
      exitCode: 0,
    });
    const stored = await readStore(cacheDir, "default");
    expect(stored.types).toEqual([
      { id: 5, name: "Milestone", is_milestone: true },
      { id: 2, name: "Task", is_milestone: false },
    ]);
    const raw = await readFile(join(cacheDir, "default", "metadata.json"), "utf8");
    expect(raw).not.toMatch(/position|color|isDefault/);
  });

  test("a second lookup reuses the persisted copy without touching the network", async () => {
    const root = await makeTempRoom("op-cli-meta-reuse-");
    const { configDir, cacheDir } = await writeSingleProfile(root, "https://op.example");
    const mockAgent = installMockApi(baseInstall("https://op.example"));

    const first = await run(
      ["meta", "types"],
      { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
      {},
    );
    const second = await run(
      ["meta", "priorities"],
      { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
      {},
    );

    expect(first.exitCode).toBe(0);
    expect(second).toEqual({
      stdout: "ID  NAME  DEFAULT\n3   High  *\n8   Low\n",
      stderr: "",
      exitCode: 0,
    });
    mockAgent.assertNoPendingInterceptors();
  });

  test("paginated collections are consumed fully via nextByOffset", async () => {
    const root = await makeTempRoom("op-cli-meta-pages-");
    const { configDir, cacheDir } = await writeSingleProfile(root, "https://op.example");
    installMockApi({
      instanceUrl: "https://op.example",
      types: [taskType()],
      nextPage: {
        path: "/api/v3/types?offset=2",
        elements: [milestoneType(), { ...taskType(), id: 1, name: "Bug", isMilestone: false }],
      },
      statuses: [],
      priorities: [],
    });

    const result = await run(
      ["meta", "types", "--json"],
      { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
      {},
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { id: 1, name: "Bug", is_milestone: false },
      { id: 5, name: "Milestone", is_milestone: true },
      { id: 2, name: "Task", is_milestone: false },
    ]);
    const stored = await readStore(cacheDir, "default");
    expect(stored.instance).toEqual({
      url: "https://op.example",
      api_version: "v3",
      core_version: "13.4",
      fetched_at: expect.any(String),
    });
  });

  test("env-only context stores under env-<sha1(url)>", async () => {
    const root = await makeTempRoom("op-cli-meta-env-");
    const cacheDir = join(root, "cache");
    installMockApi({ ...baseInstall("https://ci.example"), instanceUrl: "https://ci.example" });

    const result = await run(
      ["meta", "statuses", "--json"],
      {
        OPENPROJECT_URL: "https://ci.example",
        OPENPROJECT_API_KEY: "ci-key",
        OP_CLI_CACHE_DIR: cacheDir,
      },
      {},
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { id: 12, name: "In progress", is_closed: false, is_default: true },
      { id: 77, name: "Rejected", is_closed: true, is_default: false },
    ]);
    const key = `env-${createHash("sha1").update("https://ci.example").digest("hex")}`;
    const stored = await readStore(cacheDir, key);
    expect(stored.statuses).toEqual([
      { id: 12, name: "In progress", is_closed: false, is_default: true },
      { id: 77, name: "Rejected", is_closed: true, is_default: false },
    ]);
  });

  test("--open and --closed filter by the stored closed marker", async () => {
    const root = await makeTempRoom("op-cli-meta-filter-");
    const { configDir, cacheDir } = await writeSingleProfile(root, "https://op.example");
    installMockApi(baseInstall("https://op.example"));
    const env = { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir };

    const warmup = await run(["meta", "statuses"], env, {});
    const open = await run(["meta", "statuses", "--open", "--json"], env, {});
    const closed = await run(["meta", "statuses", "--closed", "--json"], env, {});

    expect(warmup.exitCode).toBe(0);
    expect(JSON.parse(open.stdout)).toEqual([
      { id: 12, name: "In progress", is_closed: false, is_default: true },
    ]);
    expect(JSON.parse(closed.stdout)).toEqual([
      { id: 77, name: "Rejected", is_closed: true, is_default: false },
    ]);
  });

  test("combining --open and --closed is a usage error", async () => {
    const root = await makeTempRoom("op-cli-meta-filter-bad-");
    const { configDir, cacheDir } = await writeSingleProfile(root, "https://op.example");

    const result = await run(
      ["meta", "statuses", "--open", "--closed"],
      { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
      {},
    );

    expect(result.stderr).toContain("[USAGE_ERROR]");
    expect(result.exitCode).toBe(1);
  });

  test("the profile project is fetched into the store without extra fields", async () => {
    const root = await makeTempRoom("op-cli-meta-project-");
    const { configDir, cacheDir } = await writeSingleProfile(root, "https://op.example", 13);
    installMockApi({
      ...baseInstall("https://op.example"),
      project: {
        _type: "Project",
        id: 13,
        identifier: "ops",
        name: "Operations",
        description: "internal tooling",
        active: true,
        public: false,
      },
    });

    await run(
      ["meta", "types"],
      { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
      {},
    );
    const result = await run(
      ["meta", "show", "--json"],
      { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
      {},
    );

    expect(result.exitCode).toBe(0);
    const shown = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(shown.project).toEqual({ id: 13, identifier: "ops", name: "Operations" });
    const raw = await readFile(join(cacheDir, "default", "metadata.json"), "utf8");
    expect(raw).not.toMatch(/description|"public"|active/);
  });
});

describe("meta store management", () => {
  test("meta show on an empty store explains how to fill it", async () => {
    const root = await makeTempRoom("op-cli-meta-show-empty-");
    const { configDir, cacheDir } = await writeSingleProfile(root, "https://op.example");

    const result = await run(
      ["meta", "show"],
      { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
      {},
    );

    expect(result).toEqual({
      stdout: "No metadata stored yet.\nRun op-cli meta types to load it.\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test("meta show summarises the stored copy and --json dumps it", async () => {
    const root = await makeTempRoom("op-cli-meta-show-");
    const { configDir, cacheDir } = await writeSingleProfile(root, "https://op.example");
    installMockApi(baseInstall("https://op.example"));
    const env = { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir };

    await run(["meta", "types"], env, {});
    const table = await run(["meta", "show"], env, {});
    const json = await run(["meta", "show", "--json"], env, {});

    expect(table.exitCode).toBe(0);
    expect(table.stdout).toContain("instance      https://op.example");
    expect(table.stdout).toMatch(/types\s+2/);
    const shown = JSON.parse(json.stdout) as Record<string, unknown>;
    expect(shown.types).toEqual([
      { id: 5, name: "Milestone", is_milestone: true },
      { id: 2, name: "Task", is_milestone: false },
    ]);
    expect(shown.instance).toEqual({
      url: "https://op.example",
      api_version: "v3",
      core_version: "13.4",
      fetched_at: expect.any(String),
    });
  });

  test("deleting the store while idle leaves the CLI fully functional", async () => {
    const root = await makeTempRoom("op-cli-meta-clear-");
    const { configDir, cacheDir } = await writeSingleProfile(root, "https://op.example");
    const mockAgent = installMockApi(baseInstall("https://op.example"));
    const env = { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir };

    await run(["meta", "types"], env, {});
    const cleared = await run(["meta", "clear"], env, {});
    installMockApi(baseInstall("https://op.example"));
    await expect(
      stat(join(cacheDir, "default", "metadata.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const emptied = await run(["meta", "show"], env, {});
    const refetched = await run(["meta", "types", "--json"], env, {});

    expect(cleared.stdout).toBe("Cleared stored metadata for profile default.\n");
    expect(emptied.stdout).toContain("No metadata stored yet.");
    expect(refetched.exitCode).toBe(0);
    expect(JSON.parse(refetched.stdout)).toHaveLength(2);
    mockAgent.assertNoPendingInterceptors();
  });

  test("meta refresh prints exactly what changed and saves", async () => {
    const root = await makeTempRoom("op-cli-meta-refresh-");
    const { configDir, cacheDir } = await writeSingleProfile(root, "https://op.example");
    installMockApi(baseInstall("https://op.example"));
    const env = { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir };

    await run(["meta", "types"], env, {});
    installMockApi({
      instanceUrl: "https://op.example",
      types: [{ ...taskType(), name: "Ticket" }],
      statuses: [],
      priorities: [...standardPriorities, {
        _type: "Priority",
        id: 9,
        name: "Urgent",
        color: "#000000",
        position: 0,
        isDefault: false,
      }],
      root: { _type: "API", apiVersion: "v3", coreVersion: "13.5" },
    });
    const refresh = await run(["meta", "refresh"], env, {});
    installMockApi({
      instanceUrl: "https://op.example",
      types: [{ ...taskType(), name: "Ticket" }],
      statuses: [],
      priorities: [...standardPriorities, {
        _type: "Priority",
        id: 9,
        name: "Urgent",
        color: "#000000",
        position: 0,
        isDefault: false,
      }],
      root: { _type: "API", apiVersion: "v3", coreVersion: "13.5" },
    });
    const repeat = await run(["meta", "refresh"], env, {});

    expect(refresh.exitCode).toBe(0);
    expect(refresh.stdout).toContain(
      "Refreshing metadata for profile default at https://op.example.",
    );
    expect(refresh.stdout).toContain("types: name: Task -> Ticket (2)");
    expect(refresh.stdout).toContain("statuses: removed In progress (12); removed Rejected (77)");
    expect(refresh.stdout).toContain("priorities: added Urgent (9)");
    expect(refresh.stdout).toContain("instance: core_version: 13.4 -> 13.5");
    expect(refresh.stdout).toContain("Metadata updated.");
    const stored = await readStore(cacheDir, "default");
    expect(stored.priorities).toEqual([
      { id: 3, name: "High", is_default: true },
      { id: 8, name: "Low", is_default: false },
      { id: 9, name: "Urgent", is_default: false },
    ]);
    expect(repeat.stdout).toContain("No changes.");
  });
});

describe("meta failure modes and surface", () => {
  test("an unreachable instance maps to the network exit code", async () => {
    const root = await makeTempRoom("op-cli-meta-network-");
    const { configDir, cacheDir } = await writeSingleProfile(root, "https://unreachable.example");
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    cleanups.push(async () => {
      await mockAgent.close();
      setGlobalDispatcher(new Agent());
    });
    mockAgent
      .get("https://unreachable.example")
      .intercept({ path: "/api/v3/types", method: "GET" })
      .replyWithError(new Error("connect ECONNREFUSED"));

    const result = await run(
      ["meta", "types"],
      { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
      {},
    );

    expect(result.stderr).toBe(
      "[NETWORK_ERROR] Could not reach the instance. Hint: check the instance URL and try again.\n",
    );
    expect(result.exitCode).toBe(6);
  });

  test("a failing API answer maps to the catalogued API error", async () => {
    const root = await makeTempRoom("op-cli-meta-api-error-");
    const { configDir, cacheDir } = await writeSingleProfile(root, "https://op.example");
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    cleanups.push(async () => {
      await mockAgent.close();
      setGlobalDispatcher(new Agent());
    });
    mockAgent
      .get("https://op.example")
      .intercept({ path: "/api/v3/types", method: "GET" })
      .reply(500, { _type: "Error" });

    const result = await run(
      ["meta", "types"],
      { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
      {},
    );

    expect(result.stderr).toBe("[API_ERROR] OpenProject request failed. Hint: try again later.\n");
    expect(result.exitCode).toBe(2);
  });

  test("all eight lookups are declared on the meta group", async () => {
    const root = await makeTempRoom("op-cli-meta-help-");
    const { configDir, cacheDir } = await writeSingleProfile(root, "https://op.example");

    const result = await run(
      ["meta", "--help"],
      { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
      {},
    );

    expect(result.exitCode).toBe(0);
    for (const name of [
      "types",
      "statuses",
      "priorities",
      "members",
      "versions",
      "categories",
      "fields",
      "activities",
    ]) {
      expect(result.stdout).toContain(name);
    }
  });

});

describe("meta project vocabulary", () => {
  const ada = { kind: "User", segment: "users", id: 5, name: "Ada" };
  const backend = { kind: "Group", segment: "groups", id: 9, name: "Backend" };
  const ghost = {
    kind: "PlaceholderUser",
    segment: "placeholder_users",
    id: 12,
    name: "Ghost Dev",
  };

  function projectRef(): Record<string, unknown> {
    return { _type: "Project", id: 13, identifier: "ops", name: "Operations" };
  }

  test("members carry a discriminator and their roles as id and title", async () => {
    const root = await makeTempRoom("op-cli-meta-members-");
    const { configDir, cacheDir } = await writeSingleProfile(root, "https://op.example", 13);
    installMockApi({
      ...baseInstall("https://op.example"),
      project: projectRef(),
      members: {
        13: [
          membership(1, backend, [{ id: 11, title: "Developer" }]),
          membership(2, ada, [
            { id: 4, title: "Manager" },
            { id: 7, title: "Member" },
          ]),
          membership(3, ghost, [{ id: 7, title: "Member" }]),
        ],
      },
      versions: { 13: [] },
      categories: { 13: [] },
      activities: { allowedValues: [] },
      projectTypes: { 13: [] },
    });
    const env = { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir };

    const result = await run(["meta", "members"], env, {});
    const json = await run(["meta", "members", "--json"], env, {});
    expect(result).toEqual({
      stdout:
        "ID  NAME       TYPE         ROLES\n" +
        "5   Ada        User         Manager, Member\n" +
        "9   Backend    Group        Developer\n" +
        "12  Ghost Dev  Placeholder  Member\n",
      stderr: "",
      exitCode: 0,
    });
    expect(JSON.parse(json.stdout)).toEqual([
      {
        membership_id: 2,
        user_id: 5,
        name: "Ada",
        type: "User",
        roles: [
          { id: 4, title: "Manager" },
          { id: 7, title: "Member" },
        ],
      },
      {
        membership_id: 1,
        user_id: 9,
        name: "Backend",
        type: "Group",
        roles: [{ id: 11, title: "Developer" }],
      },
      {
        membership_id: 3,
        user_id: 12,
        name: "Ghost Dev",
        type: "Placeholder",
        roles: [{ id: 7, title: "Member" }],
      },
    ]);
    const raw = await readFile(join(cacheDir, "default", "metadata.json"), "utf8");
    expect(raw).not.toMatch(/href|principal|_links/);
  });

  test("a project-scoped lookup without any project is a usage error", async () => {
    const root = await makeTempRoom("op-cli-meta-noproject-");
    const { configDir, cacheDir } = await writeSingleProfile(root, "https://op.example");

    const result = await run(
      ["meta", "members"],
      { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
      {},
    );

    expect(result.stderr).toBe(
      "[USAGE_ERROR] Invalid command usage. Hint: run op-cli --help.\n",
    );
    expect(result.exitCode).toBe(1);
  });

  test("--project overrides the lookup context and stores per project", async () => {
    const root = await makeTempRoom("op-cli-meta-perproject-");
    const { configDir, cacheDir } = await writeSingleProfile(root, "https://op.example");
    installMockApi({
      ...baseInstall("https://op.example"),
      project: projectRef(),
      members: {
        13: [membership(1, ada, [{ id: 4, title: "Manager" }])],
        14: [membership(8, backend, [{ id: 11, title: "Developer" }])],
      },
      versions: { 13: [], 14: [] },
      categories: { 13: [], 14: [] },
      activities: { allowedValues: [] },
      projectTypes: { 13: [], 14: [] },
    });
    const env = { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir };

    const first = await run(["meta", "members", "--json", "--project", "13"], env, {});
    const second = await run(["meta", "members", "--json", "--project", "14"], env, {});
    const stored = await readStore(cacheDir, "default");
    const scoped = stored.projectScoped as Record<string, unknown>;

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(first.stdout)[0].name).toBe("Ada");
    expect(JSON.parse(second.stdout)[0].name).toBe("Backend");
    expect(Object.keys(scoped).sort()).toEqual(["13", "14"]);
  });

  test("--project accepts positive integers only", async () => {
    const root = await makeTempRoom("op-cli-meta-projectid-");
    const { configDir, cacheDir } = await writeSingleProfile(root, "https://op.example");
    const env = { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir };

    for (const bad of ["abc", "0", "-5", "13.5"]) {
      const result = await run(["meta", "members", "--project", bad], env, {});
      expect(result.stderr).toContain("[USAGE_ERROR]");
      expect(result.exitCode).toBe(1);
    }
  });
});
