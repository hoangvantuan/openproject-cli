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


// Two distinct custom fields share the human name "Estimate" across
// types, which is exactly what makes field-name resolution ambiguous.
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
      { key: "customField9", id: 9, name: "Blocked", is_boolean: true },
      { key: "customField10", id: 10, name: "Reviewer", is_user: true },
      { key: "customField11", id: 11, name: "Formula" },
      { key: "customField13", id: 13, name: "Tags" },
    ],
    "6": [
      { key: "customField12", id: 12, name: "Impediment" },
    ],
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

interface InstallOptions {
  readonly packages?: Record<string, unknown>;
  /** Persistent POST endpoints, e.g. the time entry form. */
  readonly postPackages?: Record<string, unknown>;
  /** Intercepted once each, in order; any extra POST fails the whole run. */
  readonly posts?: ReadonlyArray<PostReply>;
}

/**
 * Installs exactly the endpoints listed. Any other request fails the whole
 * agent (net connect disabled), so a green run proves no extra HTTP traffic,
 * including no second create attempt and no uninvited metadata refresh.
 */
function installMockApi(
  options: InstallOptions,
): { agent: MockAgent; postBodies: Array<Record<string, unknown>> } {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  cleanups.push(async () => {
    await mockAgent.close();
    setGlobalDispatcher(new Agent());
  });
  const pool = mockAgent.get(INSTANCE);
  const postBodies: Array<Record<string, unknown>> = [];
  for (const next of options.posts ?? []) {
    pool.intercept({ path: "/api/v3/work_packages", method: "POST" }).reply(
      (call) => {
        postBodies.push(JSON.parse(String(call.body)) as Record<string, unknown>);
        return { statusCode: next.status, data: next.body ?? {} };
      },
    );
  }
  for (const [path, body] of Object.entries(options.packages ?? {})) {
    pool.intercept({ path, method: "GET" }).reply(200, body).persist();
  }
  for (const [path, body] of Object.entries(options.postPackages ?? {})) {
    pool.intercept({ path, method: "POST" }).reply(200, body).persist();
  }
  return { agent: mockAgent, postBodies };
}

function createdElement(id: number, subject: string): Record<string, unknown> {
  return {
    _type: "WorkPackage",
    id,
    lockVersion: 1,
    subject,
    createdAt: "2026-08-23T09:00:00Z",
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

async function standardRoom(): Promise<{
  configDir: string;
  cacheDir: string;
}> {
  const root = await makeTempRoom("wp-create-");
  return writeSingleProfile(root, INSTANCE, 13);
}

describe("wp create values by name", () => {
  test("resolves every attribute by name into one create payload", async () => {
    const { configDir, cacheDir } = await standardRoom();
    await writeMetadataFile(cacheDir, scopedMetadata(baseMetadata()));
    const { postBodies } = installMockApi({
      posts: [{ status: 201, body: createdElement(1500, "Ship the thing") }],
    });
    const result = await runWp(configDir, cacheDir, [
      "create",
      "Ship the thing",
      "--type",
      "Task",
      "--status",
      "In progress",
      "--priority",
      "High",
      "--assignee",
      "Linh Nguyen",
      "--version",
      "0.9.0",
      "--category",
      "Billing",
      "--field",
      "Formula=5",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Ship the thing");
    expect(postBodies).toHaveLength(1);
    const links = postBodies[0]?._links as Record<
      string,
      { href: string }
    >;
    expect(links.project.href).toBe("/api/v3/projects/13");
    expect(links.type.href).toBe("/api/v3/types/2");
    expect(links.status.href).toBe("/api/v3/statuses/1");
    expect(links.priority.href).toBe("/api/v3/priorities/3");
    expect(links.assignee.href).toBe("/api/v3/users/7");
    expect(links.version.href).toBe("/api/v3/versions/31");
    expect(links.category.href).toBe("/api/v3/categories/44");
    expect(postBodies[0]?.customField11).toBe("5");
  });

  test("splits a field value at the first equals sign", async () => {
    const { configDir, cacheDir } = await standardRoom();
    await writeMetadataFile(cacheDir, scopedMetadata(baseMetadata()));
    const { postBodies } = installMockApi({
      posts: [{ status: 201, body: createdElement(1501, "F") }],
    });
    const result = await runWp(configDir, cacheDir, [
      "create",
      "F",
      "--type",
      "Task",
      "--field",
      "Formula=a=b=c",
    ]);
    expect(result.exitCode).toBe(0);
    expect(postBodies[0]?.customField11).toBe("a=b=c");
  });

  test("repeating --field collects several values for one field", async () => {
    const { configDir, cacheDir } = await standardRoom();
    await writeMetadataFile(cacheDir, scopedMetadata(baseMetadata()));
    const { postBodies } = installMockApi({
      posts: [{ status: 201, body: createdElement(1502, "F") }],
    });
    const result = await runWp(configDir, cacheDir, [
      "create",
      "F",
      "--type",
      "Task",
      "--field",
      "Tags=alpha",
      "--field",
      "Tags=beta",
    ]);
    expect(result.exitCode).toBe(0);
    expect(postBodies[0]?.customField13).toEqual(["alpha", "beta"]);
  });

  test("sends null for --field \"Name=\" to clear the field", async () => {
    const { configDir, cacheDir } = await standardRoom();
    await writeMetadataFile(cacheDir, scopedMetadata(baseMetadata()));
    const { postBodies } = installMockApi({
      posts: [{ status: 201, body: createdElement(1503, "F") }],
    });
    const result = await runWp(configDir, cacheDir, [
      "create",
      "F",
      "--type",
      "Task",
      "--field",
      "Formula=",
    ]);
    expect(result.exitCode).toBe(0);
    expect(postBodies[0]).toHaveProperty("customField11", null);
  });

  test("refuses mixing a cleared and a set value for one field", async () => {
    const { configDir, cacheDir } = await standardRoom();
    await writeMetadataFile(cacheDir, scopedMetadata(baseMetadata()));
    installMockApi({});
    const result = await runWp(configDir, cacheDir, [
      "create",
      "F",
      "--type",
      "Task",
      "--field",
      "Formula=",
      "--field",
      "Formula=1",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Formula");
  });

  test("documents the clearing convention in --help", async () => {
    const { configDir, cacheDir } = await standardRoom();
    installMockApi({});
    const result = await runWp(configDir, cacheDir, ["create", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("clear");
  });

  test("rejects a pair without an equals sign", async () => {
    const { configDir, cacheDir } = await standardRoom();
    await writeMetadataFile(cacheDir, scopedMetadata(baseMetadata()));
    installMockApi({});
    const result = await runWp(configDir, cacheDir, [
      "create",
      "F",
      "--type",
      "Task",
      "--field",
      "Formula",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Name=Value");
  });

  test("captures boolean and user kinds from a freshly fetched schema", async () => {
    const { configDir, cacheDir } = await standardRoom();
    // No projectScoped in the cache: the vocabulary, including the schemas
    // that mark Blocked as Boolean, must be fetched over HTTP.
    await writeMetadataFile(cacheDir, baseMetadata());
    const memberFilters = encodeURIComponent(
      JSON.stringify([{ project: { operator: "=", values: ["13"] } }]),
    );
    installMockApi({
      packages: {
        [`/api/v3/memberships?filters=${memberFilters}`]: {
          _type: "Collection",
          total: 1,
          count: 1,
          _embedded: {
            elements: [
              {
                id: 1,
                _embedded: {
                  principal: {
                    _type: "User",
                    id: 7,
                    name: "Linh Nguyen",
                  },
                },
                _links: { roles: [] },
              },
            ],
          },
        },
        "/api/v3/projects/13/versions": {
          _type: "Collection",
          total: 0,
          count: 0,
          _embedded: { elements: [] },
        },
        "/api/v3/projects/13/categories": {
          _type: "Collection",
          total: 0,
          count: 0,
          _embedded: { elements: [] },
        },
        "/api/v3/projects/13/types": {
          _type: "Collection",
          total: 2,
          count: 2,
          _embedded: { elements: [{ _type: "Type", id: 2 }, { _type: "Type", id: 6 }] },
        },
        "/api/v3/work_packages/schemas/13-2": {
          _type: "Schema",
          id: "13-2",
          customField9: { type: "Boolean", name: "Blocked", writable: true },
          customField10: { type: "User", name: "Reviewer", writable: true },
        },
        "/api/v3/work_packages/schemas/13-6": {
          _type: "Schema",
          id: "13-6",
          customField12: { type: "String", name: "Estimate", writable: true },
        },
      },
      postPackages: {
        "/api/v3/time_entries/form": {
          _embedded: {
            schema: {
              activity: { _embedded: { allowedValues: [] } },
            },
          },
        },
      },
      posts: [{ status: 201, body: createdElement(1504, "F") }],
    });
    const bad = await runWp(configDir, cacheDir, [
      "create",
      "F",
      "--type",
      "Task",
      "--field",
      "Blocked=maybe",
    ]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("true");
    expect(bad.stderr).toContain("false");
    const good = await runWp(configDir, cacheDir, [
      "create",
      "F",
      "--type",
      "Task",
      "--field",
      "Blocked=true",
      "--field",
      "Reviewer=Linh Nguyen",
    ]);
    expect(good.exitCode).toBe(0);
  });

  test("a boolean field rejects anything but true/false with exit 1", async () => {
    const { configDir, cacheDir } = await standardRoom();
    await writeMetadataFile(cacheDir, scopedMetadata(baseMetadata()));
    installMockApi({});
    const result = await runWp(configDir, cacheDir, [
      "create",
      "F",
      "--type",
      "Task",
      "--field",
      "Blocked=yes",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("true");
    expect(result.stderr).toContain("false");
  });

  test("a boolean field sends a real boolean", async () => {
    const { configDir, cacheDir } = await standardRoom();
    await writeMetadataFile(cacheDir, scopedMetadata(baseMetadata()));
    const { postBodies } = installMockApi({
      posts: [{ status: 201, body: createdElement(1505, "F") }],
    });
    const result = await runWp(configDir, cacheDir, [
      "create",
      "F",
      "--type",
      "Task",
      "--field",
      "Blocked=True",
    ]);
    expect(result.exitCode).toBe(0);
    expect(postBodies[0]?.customField9).toBe(true);
  });

  test("a user-typed field resolves through the assignee machinery", async () => {
    const { configDir, cacheDir } = await standardRoom();
    await writeMetadataFile(cacheDir, scopedMetadata(baseMetadata()));
    const { postBodies } = installMockApi({
      posts: [{ status: 201, body: createdElement(1506, "F") }],
    });
    const result = await runWp(configDir, cacheDir, [
      "create",
      "F",
      "--type",
      "Task",
      "--field",
      "Reviewer=Linh Nguyen",
    ]);
    expect(result.exitCode).toBe(0);
    expect(postBodies[0]?.customField10).toEqual({
      href: "/api/v3/users/7",
    });
  });

  test("an ambiguous field name exits 1 naming both candidates and their types", async () => {
    const { configDir, cacheDir } = await standardRoom();
    // A dedicated fixture: the shared human name "Estimate" must resolve
    // as ambiguous across types, never silently to one of them.
    const ambiguousVocabulary = {
      ...PROJECT_VOCABULARY,
      custom_fields: {
        "2": [{ key: "customField8", id: 8, name: "Estimate" }],
        "6": [{ key: "customField12", id: 12, name: "Estimate" }],
      },
    };
    await writeMetadataFile(cacheDir, {
      ...baseMetadata(),
      projectScoped: { "13": ambiguousVocabulary },
    });
    installMockApi({});
    const result = await runWp(configDir, cacheDir, [
      "create",
      "F",
      "--type",
      "Task",
      "--field",
      "Estimate=3",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('field "Estimate" is ambiguous');
    expect(result.stderr).toContain("customField8 (Type Task)");
    expect(result.stderr).toContain("customField12 (Type Bug)");
  });

  test("an explicit customFieldN disambiguates an ambiguous name", async () => {
    const { configDir, cacheDir } = await standardRoom();
    await writeMetadataFile(cacheDir, scopedMetadata(baseMetadata()));
    const { postBodies } = installMockApi({
      posts: [{ status: 201, body: createdElement(1507, "F") }],
    });
    const result = await runWp(configDir, cacheDir, [
      "create",
      "F",
      "--type",
      "Task",
      "--field",
      "customfield12=3",
    ]);
    expect(result.exitCode).toBe(0);
    expect(postBodies[0]?.customField12).toBe("3");
  });

  test("an unknown explicit key exits 1 listing known names", async () => {
    const { configDir, cacheDir } = await standardRoom();
    await writeMetadataFile(cacheDir, scopedMetadata(baseMetadata()));
    installMockApi({});
    const result = await runWp(configDir, cacheDir, [
      "create",
      "F",
      "--type",
      "Task",
      "--field",
      "customField99=3",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("customField99");
  });
});

describe("wp create retry rule", () => {
  interface RetryRoom {
    readonly result: Awaited<ReturnType<typeof runWp>>;
    readonly postBodies: Array<Record<string, unknown>>;
  }

  // The cache still says Archived is status 99; the fresh answer says it is
  // status 7. A proof-carrying retry must land on 7.
  async function staleStatusRoom(
    firstStatus: number,
    freshStatusId: number,
  ): Promise<RetryRoom> {
    const { configDir, cacheDir } = await standardRoom();
    await writeMetadataFile(
      cacheDir,
      baseMetadata([
        { id: 99, name: "Archived", is_closed: false, is_default: false },
      ]),
    );
    const fresh = baseMetadata([
      { id: 1, name: "In progress", is_closed: false, is_default: true },
      { id: freshStatusId, name: "Archived", is_closed: false, is_default: false },
    ]);
    const { postBodies } = installMockApi({
      packages: refreshEndpoints(fresh),
      posts: [
        {
          status: firstStatus,
          body: {
            _type: "Error",
            errorIdentifier:
              "urn:openproject-org:api:v3:errors:PropertyConstraintViolation",
            message: 'Status is not set to "Archived".',
            _embedded: { details: { attribute: "status" } },
          },
        },
        { status: 201, body: createdElement(1508, "Retro board") },
      ],
    });
    const result = await runWp(configDir, cacheDir, [
      "create",
      "Retro board",
      "--type",
      "Task",
      "--status",
      "Archived",
      "--priority",
      "High",
    ]);
    return { result, postBodies };
  }

  test("retries once on 422 when the refresh really changed the id", async () => {
    const { result, postBodies } = await staleStatusRoom(422, 7);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Retro board");
    expect(postBodies).toHaveLength(2);
    const links = (body: Record<string, unknown>) =>
      (body._links as Record<string, { href: string }>).status.href;
    expect(links(postBodies[0] as Record<string, unknown>)).toBe(
      "/api/v3/statuses/99",
    );
    expect(links(postBodies[1] as Record<string, unknown>)).toBe(
      "/api/v3/statuses/7",
    );
  });

  test("retries once on 404 when the refresh really changed the id", async () => {
    const { result, postBodies } = await staleStatusRoom(404, 7);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Retro board");
    expect(postBodies).toHaveLength(2);
  });

  test("keeps the original 422 and makes no second request when refresh changes nothing", async () => {
    const { configDir, cacheDir } = await standardRoom();
    const statuses = [
      { id: 99, name: "Archived", is_closed: false, is_default: false },
    ];
    await writeMetadataFile(cacheDir, baseMetadata(statuses));
    // Fresh metadata carries the very same id: the honest error stays.
    const { postBodies } = installMockApi({
      packages: refreshEndpoints(baseMetadata(statuses)),
      posts: [
        {
          status: 422,
          body: {
            _type: "Error",
            message: 'Status is not set to "Archived".',
            _embedded: { details: { attribute: "status" } },
          },
        },
      ],
    });
    const result = await runWp(configDir, cacheDir, [
      "create",
      "Retro board",
      "--type",
      "Task",
      "--status",
      "Archived",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Status is not set to "Archived"');
    expect(postBodies).toHaveLength(1);
  });

  test("does not retry when the response status is outside 404 and 422", async () => {
    const { configDir, cacheDir } = await standardRoom();
    await writeMetadataFile(cacheDir, baseMetadata());
    // No refresh endpoints installed: any refresh attempt fails the run.
    const { postBodies } = installMockApi({
      posts: [
        {
          status: 400,
          body: {
            _type: "Error",
            message: "Subject is too long.",
            _embedded: { details: { attribute: "subject" } },
          },
        },
      ],
    });
    const result = await runWp(configDir, cacheDir, [
      "create",
      "Retro board",
      "--type",
      "Task",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Subject is too long.");
    expect(postBodies).toHaveLength(1);
  });

  test("does not retry when the body points at an unresolved attribute", async () => {
    const { configDir, cacheDir } = await standardRoom();
    await writeMetadataFile(cacheDir, baseMetadata());
    const { postBodies } = installMockApi({
      posts: [
        {
          status: 422,
          body: {
            _type: "Error",
            message: "Due date is not a valid date.",
            _embedded: { details: { attribute: "dueDate" } },
          },
        },
      ],
    });
    const result = await runWp(configDir, cacheDir, [
      "create",
      "Retro board",
      "--type",
      "Task",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Due date is not a valid date.");
    expect(postBodies).toHaveLength(1);
  });

  test("does not retry an attribute the caller passed as an id", async () => {
    const { configDir, cacheDir } = await standardRoom();
    await writeMetadataFile(cacheDir, baseMetadata());
    const { postBodies } = installMockApi({
      posts: [
        {
          status: 422,
          body: {
            _type: "Error",
            message: 'Status is not set to "Archived".',
            _embedded: { details: { attribute: "status" } },
          },
        },
      ],
    });
    const result = await runWp(configDir, cacheDir, [
      "create",
      "Retro board",
      "--type",
      "Task",
      "--status",
      "99",
    ]);
    expect(result.exitCode).toBe(2);
    expect(postBodies).toHaveLength(1);
  });

  test("never retries a 5xx and exits 6 saying the state is unknown", async () => {
    const { configDir, cacheDir } = await standardRoom();
    await writeMetadataFile(cacheDir, baseMetadata());
    const { postBodies } = installMockApi({
      posts: [{ status: 503, body: { message: "maintenance" } }],
    });
    const result = await runWp(configDir, cacheDir, [
      "create",
      "Retro board",
      "--type",
      "Task",
    ]);
    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain("[NETWORK_ERROR]");
    expect(result.stderr).toContain("unknown");
    expect(postBodies).toHaveLength(1);
  });

  test("treats a network failure on create as an unknown-state exit 6", async () => {
    const { configDir, cacheDir } = await standardRoom();
    await writeMetadataFile(cacheDir, baseMetadata());
    // No POST intercept: the request cannot reach any server at all.
    installMockApi({});
    const result = await runWp(configDir, cacheDir, [
      "create",
      "Retro board",
      "--type",
      "Task",
    ]);
    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain("[NETWORK_ERROR]");
    expect(result.stderr).toContain("unknown");
  });
});
