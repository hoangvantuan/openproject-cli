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

async function writeMetadataFile(
  cacheDir: string,
  metadata: unknown,
): Promise<void> {
  const dir = join(cacheDir, "default");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "metadata.json"), JSON.stringify(metadata));
}

function baseMetadata(): Record<string, unknown> {
  return {
    types: [{ id: 2, name: "Task", is_milestone: false }],
    statuses: [{ id: 1, name: "In progress", is_closed: false, is_default: true }],
    priorities: [{ id: 3, name: "High", is_default: false }],
    instance: {
      url: INSTANCE,
      api_version: "v3",
      core_version: "13.4",
      fetched_at: "2026-08-23T00:00:00Z",
    },
  };
}

/** Project-scoped vocabulary pre-seeded into the cache (#5 store shape). */
function withVocabulary(
  metadata: Record<string, unknown>,
  activities: ReadonlyArray<{ id: number; name: string; is_default: boolean }>,
): Record<string, unknown> {
  return {
    ...metadata,
    projectScoped: {
      "13": {
        project_id: 13,
        fetched_at: "2026-08-23T00:00:00Z",
        members: [],
        versions: [],
        categories: [],
        activities,
        custom_fields: {},
      },
    },
  };
}

interface PostReply {
  readonly status: number;
  readonly body?: unknown;
}

interface PatchReply {
  readonly status: number;
  readonly body?: unknown;
}

interface InstallOptions {
  readonly packages?: Record<string, unknown>;
  /** Consumed in order; once the list runs dry the interception stops matching. */
  readonly posts?: Array<PostReply>;
  /** Persistent POST endpoint (the time-entry create form). */
  readonly form?: unknown;
  /** PATCH replies for one entry path, consumed in order. */
  readonly patchPath?: string;
  readonly patches?: ReadonlyArray<PatchReply>;
  /** One DELETE endpoint; every reply carries the same status. */
  readonly deletePath?: string;
  readonly deleteStatus?: number;
}

/**
 * Installs exactly the endpoints listed; any other request fails the whole
 * agent (net connect disabled), so a green run proves no extra traffic.
 */
function installMockApi(
  options: InstallOptions,
): {
  postBodies: Array<Record<string, unknown>>;
  patchBodies: Array<Record<string, unknown>>;
  deleteCalls: () => number;
} {
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
  const postBodies: Array<Record<string, unknown>> = [];
  const patchBodies: Array<Record<string, unknown>> = [];
  for (const next of options.posts ?? []) {
    pool.intercept({ path: "/api/v3/time_entries", method: "POST" }).reply(
      (call) => {
        postBodies.push(JSON.parse(String(call.body)) as Record<string, unknown>);
        return { statusCode: next.status, data: next.body ?? {} };
      },
    );
  }
  if (options.patchPath !== undefined) {
    const replies = options.patches ?? [];
    pool.intercept({ path: options.patchPath, method: "PATCH" }).reply((call) => {
      patchBodies.push(JSON.parse(String(call.body)) as Record<string, unknown>);
      const next = replies[Math.min(patchBodies.length - 1, replies.length - 1)];
      return { statusCode: next.status, data: next.body ?? {} };
    });
  }
  let deleteCalls = 0;
  if (options.deletePath !== undefined) {
    pool.intercept({ path: options.deletePath, method: "DELETE" }).reply(() => {
      deleteCalls += 1;
      return { statusCode: options.deleteStatus ?? 204, data: "" };
    }).persist();
  }
   if (options.form !== undefined) {
     pool.intercept({ path: "/api/v3/time_entries/form", method: "POST" })
       .reply(200, options.form)
       .persist();
   }
  return { postBodies, patchBodies, deleteCalls: () => deleteCalls };
 }

function halCollection(
  total: number,
  elements: unknown[],
): Record<string, unknown> {
  return {
    _type: "Collection",
    total,
    count: elements.length,
    _embedded: { elements },
    _links: { self: { href: "/self" } },
  };
}

function pagedCollection(
  total: number,
  elements: unknown[],
  nextPath?: string,
): Record<string, unknown> {
  return {
    _type: "Collection",
    total,
    count: elements.length,
    _embedded: { elements },
    _links: {
      self: { href: "/self" },
      ...(nextPath === undefined ? {} : { nextByOffset: { href: nextPath } }),
    },
  };
}

/** The work-package resource behind every logged entry in these tests. */
function wpResource(id: number): Record<string, unknown> {
  return {
    _type: "WorkPackage",
    id,
    lockVersion: 1,
    subject: "Fix login redirect",
    _links: {
      self: { href: `/api/v3/work_packages/${String(id)}` },
      project: { href: "/api/v3/projects/13", title: "Operations" },
    },
  };
}

function timeEntryElement(
  id: number,
  wpId: number,
  wpTitle: string,
  hoursIso: string,
  overrides?: { spentOn?: string; comment?: string },
): Record<string, unknown> {
  return {
    _type: "TimeEntry",
    id,
    hours: hoursIso,
    spentOn: overrides?.spentOn ?? "2026-08-21",
    // The API models comment as Formattable, never as a bare string.
    comment: {
      format: "markdown",
      raw: overrides?.comment ?? "pairing session",
      html: `<p>${overrides?.comment ?? "pairing session"}</p>`,
    },
    createdOn: "2026-08-21T18:00:00Z",
    _links: {
      self: { href: `/api/v3/time_entries/${String(id)}` },
      workPackage: {
        href: `/api/v3/work_packages/${String(wpId)}`,
        title: wpTitle,
      },
      project: { href: "/api/v3/projects/13", title: "Operations" },
      user: { href: "/api/v3/users/9", title: "Linh Nguyen" },
      activity: {
        href: "/api/v3/time_entries/activities/1",
        title: "Development",
      },
    },
  };
}

/**
 * The create-form fixture exactly as the instance builds it: linked
 * resources under _links and full activity representations under
 * activity/_embedded/allowedValues inside the embedded schema.
 */
function timeEntryFormFixture(): Record<string, unknown> {
  return {
    _type: "TimeEntryForm",
    _links: {
      self: { href: "/api/v3/time_entries/form" },
      validate: { href: "/api/v3/time_entries/form/validate" },
    },
    _embedded: {
      payload: { hours: null, spentOn: null },
      schema: {
        _type: "Schema",
        _links: { self: { href: "/api/v3/time_entries/form/schema" } },
        id: {
          _type: "Schema",
          name: "ID",
          type: "Integer",
          writable: false,
        },
        activity: {
          _type: "Schema",
          name: "Activity",
          type: "TimeEntriesActivity",
          writable: true,
          required: true,
          _embedded: {
            allowedValues: [
              {
                _type: "TimeEntriesActivity",
                id: 1,
                name: "Development",
                default: true,
                _links: {
                  self: { href: "/api/v3/time_entries/activities/1" },
                },
              },
              {
                _type: "TimeEntriesActivity",
                id: 2,
                name: "Support",
                default: false,
                _links: {
                  self: { href: "/api/v3/time_entries/activities/2" },
                },
              },
            ],
          },
        },
      },
    },
  };
}

/** The same create form for a project that offers no activity at all. */
function emptyActivityFormFixture(): Record<string, unknown> {
  const form = timeEntryFormFixture();
  const embedded = form._embedded as Record<string, unknown>;
  const schema = embedded.schema as Record<string, unknown>;
  const activity = schema.activity as Record<string, unknown>;
  return {
    ...form,
    _embedded: {
      ...embedded,
      schema: {
        ...schema,
        activity: { ...activity, _embedded: { allowedValues: [] } },
      },
    },
  };
}

/** Every vocabulary endpoint a metadata refresh walks, all empty. */
function refreshEndpoints(): Record<string, unknown> {
  const memberFilters = encodeURIComponent(
    JSON.stringify([{ project: { operator: "=", values: ["13"] } }]),
  );
  return {
    "/api/v3/types": halCollection(1, [{ id: 2, name: "Task", is_milestone: false }]),
    "/api/v3/statuses": halCollection(1, [
      { id: 1, name: "In progress", is_closed: false, is_default: true },
    ]),
    "/api/v3/priorities": halCollection(1, [{ id: 3, name: "High", is_default: false }]),
    "/api/v3/": {},
    [`/api/v3/memberships?filters=${memberFilters}`]: halCollection(0, []),
    "/api/v3/projects/13/versions": halCollection(0, []),
    "/api/v3/projects/13/categories": halCollection(0, []),
    "/api/v3/projects/13/types": halCollection(1, [{ id: 2, name: "Task" }]),
    "/api/v3/work_packages/schemas/13-2": {},
  };
}

async function runTime(
  configDir: string,
  cacheDir: string,
  args: ReadonlyArray<string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return run(
    ["time", ...args],
    { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
    {},
  );
}

function localIsoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${String(date.getFullYear())}-${month}-${day}`;
}

function entryPath(filters: unknown, pageSize: number): string {
  return (
    `/api/v3/time_entries?filters=${encodeURIComponent(JSON.stringify(filters))}`
    + `&pageSize=${String(pageSize)}`
  );
}

describe("time log", () => {
  test("--hours 1.5 and --hours 1h30m send byte-identical payloads", async () => {
    const payloads: Array<string> = [];
    for (const hoursValue of ["1.5", "1h30m"]) {
      const root = await makeTempRoom(`time-log-${hoursValue.replace(/\W/g, "")}-`);
      const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
      await writeMetadataFile(
        cacheDir,
        withVocabulary(baseMetadata(), [
          { id: 1, name: "Development", is_default: true },
        ]),
      );
      const { postBodies } = installMockApi({
        packages: {
          "/api/v3/work_packages/675": wpResource(675),
        },
        posts: [
          { status: 201, body: timeEntryElement(3001, 675, "Fix login redirect", "PT1H30M") },
        ],
      });
      const result = await runTime(configDir, cacheDir, [
        "log",
        "675",
        "--hours",
        hoursValue,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      // Output reports decimal hours, never the ISO wire form alone.
      expect(result.stdout).toContain("1.5");
      expect(postBodies).toHaveLength(1);
      payloads.push(JSON.stringify(postBodies[0]));
    }
    expect(payloads[0]).toBe(payloads[1]);
    expect(JSON.parse(payloads[0])).toEqual({
      hours: "PT1H30M",
      spentOn: localIsoDate(new Date()),
      _links: { workPackage: { href: "/api/v3/work_packages/675" } },
    });
  });

  test("--fields narrows the record the log reports", async () => {
    const root = await makeTempRoom("time-log-fields-json-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    await writeMetadataFile(
      cacheDir,
      withVocabulary(baseMetadata(), [
        { id: 1, name: "Development", is_default: true },
      ]),
    );
    installMockApi({
      packages: {
        "/api/v3/work_packages/675": wpResource(675),
      },
      posts: [
        { status: 201, body: timeEntryElement(3003, 675, "Fix login redirect", "PT1H30M") },
      ],
    });
    const result = await runTime(configDir, cacheDir, [
      "log",
      "675",
      "--hours",
      "1h30m",
      "--fields",
      "id,hours",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ id: 3003, hours: 1.5 });
  });

  test("an unknown --fields name says the entry was logged anyway", async () => {
    const root = await makeTempRoom("time-log-fields-miss-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    await writeMetadataFile(
      cacheDir,
      withVocabulary(baseMetadata(), [
        { id: 1, name: "Development", is_default: true },
      ]),
    );
    installMockApi({
      packages: {
        "/api/v3/work_packages/675": wpResource(675),
      },
      posts: [
        { status: 201, body: timeEntryElement(3004, 675, "Fix login redirect", "PT1H") },
      ],
    });
    const result = await runTime(configDir, cacheDir, [
      "log",
      "675",
      "--hours",
      "1h",
      "--fields",
      "hourz",
    ]);
    expect(result.exitCode).toBe(1);
    // Repeating the command would log a second entry, so the message has
    // to say the first one exists.
    expect(result.stderr).toContain("time entry 3004 was logged");
    expect(result.stderr).toContain('field "hourz" is not a column');
  });
  test("--activity resolves by name through the create form of the work package's project", async () => {
    const root = await makeTempRoom("time-log-activity-form-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    // Base metadata only: resolving the activity must fetch the vocabulary
    // of the work package's own project (13), not any profile default.
    await writeMetadataFile(cacheDir, baseMetadata());
    const { postBodies } = installMockApi({
      packages: {
        ...refreshEndpoints(),
        "/api/v3/work_packages/675": wpResource(675),
      },
      form: timeEntryFormFixture(),
      posts: [
        { status: 201, body: timeEntryElement(3002, 675, "Fix login redirect", "PT45M") },
      ],
    });
    const result = await runTime(configDir, cacheDir, [
      "log",
      "675",
      "--hours",
      "45m",
      "--activity",
      "Development",
    ]);
    expect(result.exitCode).toBe(0);
    expect(postBodies[0]?.hours).toBe("PT45M");
    const links = postBodies[0]?._links as Record<string, { href: string }>;
    expect(links.workPackage.href).toBe("/api/v3/work_packages/675");
    expect(links.activity.href).toBe("/api/v3/time_entries/activities/1");
  });

  test("an unmatched activity exits 1 listing the valid names", async () => {
    const root = await makeTempRoom("time-log-activity-miss-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    await writeMetadataFile(
      cacheDir,
      withVocabulary(baseMetadata(), [
        { id: 1, name: "Development", is_default: true },
        { id: 2, name: "Support", is_default: false },
      ]),
    );
    installMockApi({
      packages: {
        ...refreshEndpoints(),
        "/api/v3/work_packages/675": wpResource(675),
      },
      form: timeEntryFormFixture(),
    });
    const result = await runTime(configDir, cacheDir, [
      "log",
      "675",
      "--hours",
      "1h",
      "--activity",
      "Developmnt",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('activity "Developmnt" not found');
    expect(result.stderr).toContain("Development");
    expect(result.stderr).toContain("Support");
  });

  test("an unmatched activity in a project with none says so instead of listing nothing", async () => {
    const root = await makeTempRoom("time-log-activity-empty-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    await writeMetadataFile(cacheDir, withVocabulary(baseMetadata(), []));
    installMockApi({
      packages: {
        ...refreshEndpoints(),
        "/api/v3/work_packages/675": wpResource(675),
      },
      form: emptyActivityFormFixture(),
    });
    const result = await runTime(configDir, cacheDir, [
      "log",
      "675",
      "--hours",
      "1h",
      "--activity",
      "KhongCo",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      '[USAGE_ERROR] activity "KhongCo" not found; no activity is available to match.',
    );
    // The bare full stop of an empty candidate list is what this replaces.
    expect(result.stderr).not.toContain("closest first");
  });

  test("an unreadable --hours fails as usage before any traffic", async () => {
    const root = await makeTempRoom("time-log-bad-hours-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({});
    for (const bad of ["abc", "0", "-1", "1h30"]) {
      const result = await runTime(configDir, cacheDir, [
        "log",
        "675",
        "--hours",
        bad,
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("[USAGE_ERROR]");
      expect(result.stderr).toContain("1h30m");
    }
  });

  test("a rejected create maps onto the catalogue without retrying", async () => {
    const root = await makeTempRoom("time-log-rejected-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    await writeMetadataFile(
      cacheDir,
      withVocabulary(baseMetadata(), [
        { id: 1, name: "Development", is_default: true },
      ]),
    );
    installMockApi({
      packages: {
        "/api/v3/work_packages/675": wpResource(675),
      },
      posts: [
        { status: 422, body: { _type: "Error", message: "Hours is invalid." } },
      ],
    });
    const result = await runTime(configDir, cacheDir, [
      "log",
      "675",
      "--hours",
      "1.5",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("[API_ERROR]");
    expect(result.stderr).toContain("Hours is invalid.");
    expect(result.stderr).not.toContain("try again later");
  });

  test("a network failure on create reports the unknown state", async () => {
    const root = await makeTempRoom("time-log-network-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    await writeMetadataFile(
      cacheDir,
      withVocabulary(baseMetadata(), [
        { id: 1, name: "Development", is_default: true },
      ]),
    );
    installMockApi({
      packages: {
        "/api/v3/work_packages/675": wpResource(675),
      },
      posts: [{ status: 503 }],
    });
    const result = await runTime(configDir, cacheDir, [
      "log",
      "675",
      "--hours",
      "1.5",
    ]);
    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain("whether the entry was recorded is unknown");
  });
});

describe("time list", () => {
  const ENTITY_FILTERS = [
    { entity_type: { operator: "=", values: ["WorkPackage"] } },
    { entity_id: { operator: "=", values: ["675", "598"] } },
  ];

  test("--wp 675,598 queries both and renders one flat table with a work package column", async () => {
    const root = await makeTempRoom("time-list-flat-table-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      packages: {
        [entryPath(ENTITY_FILTERS, 100)]: halCollection(2, [
          timeEntryElement(3001, 675, "Fix login redirect", "PT1H30M"),
          timeEntryElement(3002, 598, "Design review", "PT2H"),
        ]),
      },
    });
    const result = await runTime(configDir, cacheDir, ["list", "--wp", "675,598"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("WORK PACKAGE");
    expect(result.stdout).toContain("Fix login redirect");
    expect(result.stdout).toContain("Design review");
    expect(result.stdout).toContain("1.5");
    expect(result.stdout).toContain("2");
  });

  test("--json returns one flat array carrying decimal and ISO hours", async () => {
    const root = await makeTempRoom("time-list-flat-json-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      packages: {
        [entryPath(ENTITY_FILTERS, 100)]: halCollection(2, [
          timeEntryElement(3001, 675, "Fix login redirect", "PT1H30M"),
          timeEntryElement(3002, 598, "Design review", "PT2H"),
        ]),
      },
    });
    const result = await runTime(configDir, cacheDir, [
      "list",
      "--wp",
      "675,598",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const rows = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 3001,
      wp: { id: 675, name: "Fix login redirect" },
      hours: 1.5,
      hours_iso: "PT1H30M",
      spentOn: "2026-08-21",
      user: { id: 9, name: "Linh Nguyen" },
      activity: { id: 1, name: "Development" },
    });
    // The internal filter spelling never reaches the caller.
    expect(JSON.stringify(rows)).not.toContain("entity_type");
    expect(JSON.stringify(rows)).not.toContain("entity_id");
  });

  test("--user me --from today resolves both into API filters", async () => {
    const root = await makeTempRoom("time-list-me-today-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const today = localIsoDate(new Date());
    installMockApi({
      packages: {
        "/api/v3/users/me": { id: 5, name: "Tuan Ha", login: "tuan" },
        [entryPath([
          { user_id: { operator: "=", values: ["5"] } },
          { spent_on: { operator: "<>d", values: [today, ""] } },
        ], 100)]: halCollection(1, [
          timeEntryElement(3010, 675, "Fix login redirect", "PT0.5S"),
        ]),
      },
    });
    const result = await runTime(configDir, cacheDir, [
      "list",
      "--user",
      "me",
      "--from",
      "today",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Fix login redirect");
  });

  test("a larger total warns about truncation on stderr and still exits 0", async () => {
    const root = await makeTempRoom("time-list-truncated-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      packages: {
        [entryPath(ENTITY_FILTERS, 100)]: halCollection(3, [
          timeEntryElement(3001, 675, "Fix login redirect", "PT1H30M"),
          timeEntryElement(3002, 598, "Design review", "PT2H"),
        ]),
      },
    });
    const result = await runTime(configDir, cacheDir, ["list", "--wp", "675,598"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe(
      "Showing 2 of 3 time entries. Pass --all to fetch every result.\n",
    );
  });

  test("--all --json emits NDJSON across pages", async () => {
    const root = await makeTempRoom("time-list-all-json-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const nextPath = `${entryPath(ENTITY_FILTERS, 100).replace("&pageSize=100", "")}&offset=2&pageSize=100`;
    installMockApi({
      packages: {
        [entryPath(ENTITY_FILTERS, 100)]: pagedCollection(
          3,
          [timeEntryElement(3001, 675, "Fix login redirect", "PT1H30M")],
          nextPath,
        ),
        [nextPath]: pagedCollection(3, [
          timeEntryElement(3002, 598, "Design review", "PT2H"),
        ]),
      },
    });
    const result = await runTime(configDir, cacheDir, [
      "list",
      "--wp",
      "675,598",
      "--all",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    const second = JSON.parse(lines[1]) as Record<string, unknown>;
    expect(second.wp).toEqual({ id: 598, name: "Design review" });
    expect(second.hours).toBe(2);
  });

  test("a non-numeric work package reference is refused before any traffic", async () => {
    const root = await makeTempRoom("time-list-bad-wp-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({});
    const result = await runTime(configDir, cacheDir, ["list", "--wp", "login-bug"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[USAGE_ERROR]");
  });
});

describe("time get", () => {
  test("shows one entry with decimal hours and the ISO form beside it", async () => {
    const root = await makeTempRoom("time-get-table-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      packages: {
        "/api/v3/time_entries/3001": timeEntryElement(
          3001,
          675,
          "Fix login redirect",
          "PT1H30M",
        ),
      },
    });
    const result = await runTime(configDir, cacheDir, ["get", "3001"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("FIELD");
    expect(result.stdout).toContain("hours");
    expect(result.stdout).toContain("1.5");
    expect(result.stdout).toContain("PT1H30M");
    expect(result.stdout).toContain("Fix login redirect");

    const jsonResult = await runTime(configDir, cacheDir, ["get", "3001", "--json"]);
    expect(jsonResult.exitCode).toBe(0);
    const record = JSON.parse(jsonResult.stdout) as Record<string, unknown>;
    expect(record.hours).toBe(1.5);
    expect(record.hours_iso).toBe("PT1H30M");
    expect(record.wp).toEqual({ id: 675, name: "Fix login redirect" });
    expect(JSON.stringify(record)).not.toContain("_links");
  });

  test("the comment reads back as the markdown behind the Formattable", async () => {
    const root = await makeTempRoom("time-get-comment-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      packages: {
        "/api/v3/time_entries/3001": timeEntryElement(
          3001,
          675,
          "Fix login redirect",
          "PT1H30M",
          { comment: "sua tu CLI" },
        ),
      },
    });
    const result = await runTime(configDir, cacheDir, [
      "get",
      "3001",
      "--fields",
      "id,hours,comment",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("sua tu CLI");

    const jsonResult = await runTime(configDir, cacheDir, ["get", "3001", "--json"]);
    const record = JSON.parse(jsonResult.stdout) as Record<string, unknown>;
    expect(record.comment).toBe("sua tu CLI");
  });

  test("a non-id reference is refused as usage", async () => {
    const root = await makeTempRoom("time-get-bad-ref-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({});
    const result = await runTime(configDir, cacheDir, ["get", "latest"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[USAGE_ERROR]");
  });
});

describe("time update", () => {
  const ENTRY_PATH = "/api/v3/time_entries/3001";

  test("edits hours, activity by name, comment, and date in one PATCH", async () => {
    const root = await makeTempRoom("time-update-all-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    await writeMetadataFile(cacheDir, baseMetadata());
    installMockApi({
      packages: {
        ...refreshEndpoints(),
        "/api/v3/work_packages/675": wpResource(675),
        [ENTRY_PATH]: timeEntryElement(3001, 675, "Fix login redirect", "PT1H30M"),
      },
      form: timeEntryFormFixture(),
      patchPath: ENTRY_PATH,
      patches: [
        {
          status: 200,
          body: timeEntryElement(3001, 675, "Fix login redirect", "PT2H", {
            spentOn: "2026-08-20",
            comment: "reworked after review",
          }),
        },
      ],
    });
    const result = await runTime(configDir, cacheDir, [
      "update",
      "3001",
      "--hours",
      "2h",
      "--activity",
      "Development",
      "--comment",
      "reworked after review",
      "--spent-on",
      "2026-08-20",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("2");
    expect(result.stdout).toContain("reworked after review");
    expect(result.stdout).toContain("2026-08-20");
  });

  test("--hours alone patches without reading the entry first", async () => {
    const root = await makeTempRoom("time-update-hours-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    // No GET endpoint installed: any read of the entry would fail the agent.
    installMockApi({
      patchPath: ENTRY_PATH,
      patches: [
        { status: 200, body: timeEntryElement(3001, 675, "Fix login redirect", "PT45M") },
      ],
    });
    const result = await runTime(configDir, cacheDir, [
      "update",
      "3001",
      "--hours",
      "45m",
    ]);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("0.75");
  });

  test("the PATCH payload carries exactly the given values", async () => {
    const root = await makeTempRoom("time-update-payload-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    await writeMetadataFile(cacheDir, baseMetadata());
    const api = installMockApi({
      packages: {
        ...refreshEndpoints(),
        "/api/v3/work_packages/675": wpResource(675),
        [ENTRY_PATH]: timeEntryElement(3001, 675, "Fix login redirect", "PT1H30M"),
      },
      form: timeEntryFormFixture(),
      patchPath: ENTRY_PATH,
      patches: [
        { status: 200, body: timeEntryElement(3001, 675, "Fix login redirect", "PT2H") },
      ],
    });
    const result = await runTime(configDir, cacheDir, [
      "update",
      "3001",
      "--hours",
      "2h",
      "--activity",
      "Development",
      "--comment",
      "reworked after review",
      "--spent-on",
      "2026-08-20",
    ]);
    expect(result.exitCode).toBe(0);
    expect(api.patchBodies).toEqual([
      {
        hours: "PT2H",
        spentOn: "2026-08-20",
        comment: { raw: "reworked after review" },
        _links: { activity: { href: "/api/v3/time_entries/activities/1" } },
      },
    ]);
  });

  test("an unmatched activity exits 1 listing the valid names", async () => {
    const root = await makeTempRoom("time-update-activity-miss-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    await writeMetadataFile(cacheDir, baseMetadata());
    const api = installMockApi({
      packages: {
        ...refreshEndpoints(),
        "/api/v3/work_packages/675": wpResource(675),
        [ENTRY_PATH]: timeEntryElement(3001, 675, "Fix login redirect", "PT1H30M"),
      },
      form: timeEntryFormFixture(),
      patchPath: ENTRY_PATH,
      patches: [{ status: 200 }],
    });
    const result = await runTime(configDir, cacheDir, [
      "update",
      "3001",
      "--activity",
      "Developmnt",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('activity "Developmnt" not found');
    expect(api.patchBodies).toHaveLength(0);
  });

  test("a malformed --spent-on is refused as usage before any traffic", async () => {
    const root = await makeTempRoom("time-update-bad-date-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({});
    const result = await runTime(configDir, cacheDir, [
      "update",
      "3001",
      "--spent-on",
      "soon",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[USAGE_ERROR]");
    expect(result.stderr).toContain("--spent-on");
  });

  test("no value to change exits 1 before any traffic", async () => {
    const root = await makeTempRoom("time-update-noop-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({});
    const result = await runTime(configDir, cacheDir, ["update", "3001"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("at least one value to change");
  });

  test("a rejected update maps onto the catalogue without retrying", async () => {
    const root = await makeTempRoom("time-update-rejected-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      patchPath: ENTRY_PATH,
      patches: [
        { status: 422, body: { _type: "Error", message: "Hours is invalid." } },
      ],
    });
    const result = await runTime(configDir, cacheDir, ["update", "3001", "--hours", "2h"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("[API_ERROR]");
    expect(result.stderr).toContain("Hours is invalid.");
  });

  test("a network failure on update reports the unknown state", async () => {
    const root = await makeTempRoom("time-update-network-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      patchPath: ENTRY_PATH,
      patches: [{ status: 503 }],
    });
    const result = await runTime(configDir, cacheDir, ["update", "3001", "--hours", "2h"]);
    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain("whether the change was applied is unknown");
  });
});

describe("time delete", () => {
  const ENTRY_PATH = "/api/v3/time_entries/3001";

  test("without --yes exits 1 and sends nothing even without a terminal", async () => {
    const root = await makeTempRoom("time-delete-guard-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({ deletePath: ENTRY_PATH });
    const result = await runTime(configDir, cacheDir, ["delete", "3001"], {});
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--yes");
  });

  test("without --yes exits 1 even with a terminal attached and changes nothing", async () => {
    const root = await makeTempRoom("time-delete-tty-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const api = installMockApi({ deletePath: ENTRY_PATH });
    const result = await runTime(configDir, cacheDir, ["delete", "3001"], {
      isTTY: true,
    });
    expect(result.exitCode).toBe(1);
    expect(api.deleteCalls()).toBe(0);
  });

  test("--yes deletes and reports it", async () => {
    const root = await makeTempRoom("time-delete-yes-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const api = installMockApi({ deletePath: ENTRY_PATH });
    const result = await runTime(configDir, cacheDir, ["delete", "3001", "--yes"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(api.deleteCalls()).toBe(1);
    expect(result.stdout).toContain("Deleted time entry 3001.");
  });

  test("a missing time entry exits 4", async () => {
    const root = await makeTempRoom("time-delete-miss-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({ deletePath: ENTRY_PATH, deleteStatus: 404 });
    const result = await runTime(configDir, cacheDir, ["delete", "3001", "--yes"]);
    expect(result.exitCode).toBe(4);
  });

  test("refuses a non-id reference without any request", async () => {
    const root = await makeTempRoom("time-delete-bad-ref-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const api = installMockApi({ deletePath: ENTRY_PATH });
    const result = await runTime(configDir, cacheDir, ["delete", "latest", "--yes"]);
    expect(result.exitCode).toBe(1);
    expect(api.deleteCalls()).toBe(0);
  });
});

describe("time report", () => {
  /** Dyadic hour amounts only, so every total is float-exact. */
  function reportEntries(): Array<Record<string, unknown>> {
    return [
      timeEntryElement(3001, 675, "Fix login redirect", "PT1H30M"),
      timeEntryElement(3002, 598, "Design review", "PT45M"),
      timeEntryElement(3003, 675, "Fix login redirect", "PT2H"),
    ];
  }

  test("aggregates over the same filters as time list and totals decimal hours", async () => {
    const root = await makeTempRoom("time-report-filters-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      packages: {
        [entryPath([
          { entity_type: { operator: "=", values: ["WorkPackage"] } },
          { entity_id: { operator: "=", values: ["675"] } },
        ], 100)]: halCollection(3, reportEntries()),
      },
    });
    // The strict mock proves both commands query byte-identical filters.
    const listed = await runTime(configDir, cacheDir, ["list", "--wp", "675"]);
    const reported = await runTime(configDir, cacheDir, ["report", "--wp", "675"]);
    expect(listed.exitCode).toBe(0);
    expect(reported.exitCode).toBe(0);
    expect(reported.stderr).toBe("");
    // Groups: wp 675 carries 1.5 + 2 = 3.5 over two entries; total 4.25.
    expect(reported.stdout).toContain("TOTAL");
    expect(reported.stdout).toContain("3.5");
    expect(reported.stdout).toContain("4.25");
    expect(reported.stdout.indexOf("3.5")).toBeLessThan(reported.stdout.indexOf("TOTAL"));
  });

  test("--json emits one flat group array whose hours sum to the entry total", async () => {
    const root = await makeTempRoom("time-report-json-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      packages: {
        [entryPath([], 100)]: halCollection(3, reportEntries()),
      },
    });
    const result = await runTime(configDir, cacheDir, ["report", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const groups = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({ wp: { id: 675, name: "Fix login redirect" }, entries: 2, hours: 3.5 });
    expect(groups[1]).toEqual({ wp: { id: 598, name: "Design review" }, entries: 1, hours: 0.75 });
    const sum = groups.reduce((carry, group) => carry + (group.hours as number), 0);
    expect(sum).toBeCloseTo(4.25, 10);
    expect(JSON.stringify(groups)).not.toContain("_links");
  });

  test("totals span every page so a paged set never under-reports", async () => {
    const root = await makeTempRoom("time-report-pages-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const nextPath = `${entryPath([], 100).replace("&pageSize=100", "")}&offset=100&pageSize=100`;
    installMockApi({
      packages: {
        [entryPath([], 100)]: pagedCollection(
          2,
          [timeEntryElement(3001, 675, "Fix login redirect", "PT1H30M")],
          nextPath,
        ),
        [nextPath]: pagedCollection(2, [
          timeEntryElement(3002, 598, "Design review", "PT45M"),
        ]),
      },
    });
    const result = await runTime(configDir, cacheDir, ["report"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("2.25");
  });

  test("an entry the instance spells with a day component still totals", async () => {
    const root = await makeTempRoom("time-report-days-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      packages: {
        // OpenProject spells any duration of 24 hours or more with a day
        // component, so a report over real logged time meets P3DT1H.
        [entryPath([], 100)]: halCollection(2, [
          timeEntryElement(3001, 675, "Fix login redirect", "P3DT1H"),
          timeEntryElement(3002, 675, "Fix login redirect", "PT30M"),
        ]),
      },
    });
    const result = await runTime(configDir, cacheDir, ["report"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("73.5");
  });

  test("an empty filtered set reports zero without error", async () => {
    const root = await makeTempRoom("time-report-empty-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      packages: {
        [entryPath([], 100)]: halCollection(0, []),
      },
    });
    const result = await runTime(configDir, cacheDir, ["report"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("TOTAL");
    const jsonResult = await runTime(configDir, cacheDir, ["report", "--json"]);
    expect(JSON.parse(jsonResult.stdout)).toEqual([]);
  });
});

describe("time list and time report project scope", () => {
  test("a profile default project narrows both the listing and the report", async () => {
    const root = await makeTempRoom("time-default-project-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE, 13);
    installMockApi({
      packages: {
        [entryPath([{ project: { operator: "=", values: ["13"] } }], 100)]:
          halCollection(1, [timeEntryElement(3001, 675, "Fix login redirect", "PT1H30M")]),
      },
    });
    // The strict mock proves both commands scope to the same project.
    const listed = await runTime(configDir, cacheDir, ["list"]);
    const reported = await runTime(configDir, cacheDir, ["report"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stderr).toBe("");
    expect(listed.stdout).toContain("Fix login redirect");
    expect(reported.exitCode).toBe(0);
    expect(reported.stdout).toContain("1.5");
  });

  test("the project clause leads and travels with the other filters", async () => {
    const root = await makeTempRoom("time-project-override-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE, 13);
    installMockApi({
      packages: {
        [entryPath([
          { project: { operator: "=", values: ["33"] } },
          { entity_type: { operator: "=", values: ["WorkPackage"] } },
          { entity_id: { operator: "=", values: ["675"] } },
        ], 100)]: halCollection(1, [
          timeEntryElement(3001, 675, "Fix login redirect", "PT1H30M"),
        ]),
      },
    });
    const result = await runTime(configDir, cacheDir, [
      "list",
      "--project",
      "33",
      "--wp",
      "675",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Fix login redirect");
  });

  test("with no project in context the listing stays instance-wide", async () => {
    const root = await makeTempRoom("time-no-project-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      packages: {
        [entryPath([], 100)]: halCollection(1, [
          timeEntryElement(3001, 675, "Fix login redirect", "PT1H30M"),
        ]),
      },
    });
    const result = await runTime(configDir, cacheDir, ["list"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Fix login redirect");
  });
});
