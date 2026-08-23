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
const WP_PATH = "/api/v3/work_packages/675";

function baseMetadata(): Record<string, unknown> {
  return {
    types: [
      { id: 2, name: "Task", is_milestone: false },
      { id: 6, name: "Bug", is_milestone: false },
    ],
    statuses: [
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
    "2": [{ key: "customField11", id: 11, name: "Formula" }],
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

function scopedMetadata(): Record<string, unknown> {
  return {
    ...baseMetadata(),
    projectScoped: { "13": PROJECT_VOCABULARY },
  };
}

/** One stored work package in state `state`; `lockVersion` drives races. */
function wpRecord(
  lockVersion: number,
  state: "open" | "closed-by-b" | "field-touched-by-b",
): Record<string, unknown> {
  const status = state === "closed-by-b"
    ? { href: "/api/v3/statuses/3", title: "Closed by B" }
    : { href: "/api/v3/statuses/1", title: "In progress" };
  const formula = state === "field-touched-by-b" ? "8" : "2";
  return {
    _type: "WorkPackage",
    id: 675,
    lockVersion,
    subject: "Ship the thing",
    createdAt: "2026-08-23T09:00:00Z",
    updatedAt: "2026-08-23T09:00:00Z",
    customField11: formula,
    _links: {
      self: { href: WP_PATH },
      project: { href: "/api/v3/projects/13", title: "Operations" },
      type: { href: "/api/v3/types/2", title: "Task" },
      status,
      priority: { href: "/api/v3/priorities/3", title: "High" },
    },
  };
}

interface InstallOptions {
  /** Consumed in order by successive GETs of the work package. */
  readonly gets: ReadonlyArray<Record<string, unknown>>;
  /** Served to every GET once the ordered ones are used up. */
  readonly persistentGet?: Record<string, unknown>;
  /** Status/body returned by every PATCH; default 409. */
  readonly patchReplies?: ReadonlyArray<{ status: number; body?: unknown }>;
}

/**
 * Installs exactly these endpoints; any other request fails the whole
 * agent (net connect disabled), so patch-call counts prove how many
 * writes the command attempted.
 */
function installUpdateApi(
  options: InstallOptions,
): { patchBodies: Array<Record<string, unknown>>; patchCalls: () => number } {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  cleanups.push(async () => {
    await mockAgent.close();
    setGlobalDispatcher(new Agent());
  });
  const pool = mockAgent.get(INSTANCE);
  for (const body of options.gets) {
    pool.intercept({ path: WP_PATH, method: "GET" }).reply(200, body);
  }
  if (options.persistentGet !== undefined) {
    pool.intercept({ path: WP_PATH, method: "GET" })
      .reply(200, options.persistentGet)
      .persist();
  }
  const patchBodies: Array<Record<string, unknown>> = [];
  let patches = 0;
  pool.intercept({ path: WP_PATH, method: "PATCH" }).reply((call) => {
    patchBodies.push(JSON.parse(String(call.body)) as Record<string, unknown>);
    const reply = options.patchReplies?.[patches] ?? { status: 409, body: {} };
    patches += 1;
    return { statusCode: reply.status, data: reply.body ?? {} };
  }).persist();
  return { patchBodies, patchCalls: () => patches };
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
  const root = await makeTempRoom("wp-update-");
  return writeSingleProfile(root, INSTANCE, 13);
}

describe("wp update", () => {
  test("reads, then patches by name with the lockVersion of the read", async () => {
    const { configDir, cacheDir } = await standardRoom();
    await writeMetadataFile(cacheDir, scopedMetadata());
    installUpdateApi({
      gets: [wpRecord(1, "open")],
      patchReplies: [{ status: 200, body: wpRecord(2, "closed-by-b") }],
    });
    const result = await runWp(configDir, cacheDir, [
      "update",
      "675",
      "--status",
      "Closed",
      "--field",
      "Formula=7",
    ]);
    expect(result.exitCode).toBe(0);
  });

  test("sends the read lockVersion and the resolved hrefs", async () => {
    const { configDir, cacheDir } = await standardRoom();
    await writeMetadataFile(cacheDir, scopedMetadata());
    const { patchBodies } = installUpdateApi({
      gets: [wpRecord(1, "open")],
      patchReplies: [{ status: 200, body: wpRecord(2, "closed-by-b") }],
    });
    await runWp(configDir, cacheDir, [
      "update",
      "675",
      "--status",
      "Closed",
      "--field",
      "Formula=7",
    ]);
    expect(patchBodies).toHaveLength(1);
    expect(patchBodies[0]?.lockVersion).toBe(1);
    const links = patchBodies[0]?._links as Record<string, { href: string }>;
    expect(links.status.href).toBe("/api/v3/statuses/5");
    expect(patchBodies[0]?.customField11).toBe("7");
  });

  test("a pure race succeeds after exactly one retry", async () => {
    const { configDir, cacheDir } = await standardRoom();
    await writeMetadataFile(cacheDir, scopedMetadata());
    // Nobody touched status or Formula between the reads; only
    // lockVersion moved.
    const { patchBodies } = installUpdateApi({
      gets: [wpRecord(1, "open"), wpRecord(2, "open")],
      patchReplies: [
        { status: 409, body: {} },
        { status: 200, body: wpRecord(3, "closed-by-b") },
      ],
    });
    const result = await runWp(configDir, cacheDir, [
      "update",
      "675",
      "--status",
      "Closed",
      "--field",
      "Formula=7",
    ]);
    expect(result.exitCode).toBe(0);
    expect(patchBodies).toHaveLength(2);
    expect(patchBodies[1]?.lockVersion).toBe(2);
  });

  test("a touched field stops the update with exit 5 and its name", async () => {
    const { configDir, cacheDir } = await standardRoom();
    await writeMetadataFile(cacheDir, scopedMetadata());
    // Actor B moved status while this agent was editing it; Formula is
    // untouched even though the agent changes it too.
    const { patchBodies } = installUpdateApi({
      gets: [wpRecord(1, "open"), wpRecord(2, "closed-by-b")],
    });
    const result = await runWp(configDir, cacheDir, [
      "update",
      "675",
      "--status",
      "Closed",
      "--field",
      "Formula=7",
    ]);
    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("status");
    // Exactly one write attempt: no blind overwrite followed.
    expect(patchBodies).toHaveLength(1);
  });

  test("the second actor's value survives the refused update", async () => {
    const { configDir, cacheDir } = await standardRoom();
    await writeMetadataFile(cacheDir, scopedMetadata());
    installUpdateApi({
      gets: [wpRecord(1, "open"), wpRecord(2, "closed-by-b")],
      persistentGet: wpRecord(2, "closed-by-b"),
    });
    await runWp(configDir, cacheDir, [
      "update",
      "675",
      "--status",
      "Closed",
      "--field",
      "Formula=7",
    ]);
    const after = await runWp(configDir, cacheDir, ["get", "675", "--json"]);
    expect(after.exitCode).toBe(0);
    const record = JSON.parse(after.stdout) as {
      status: { id: number | null; name: string | null };
    };
    expect(record.status.id).toBe(3);
    expect(record.status.name).toBe("Closed by B");
  });

  test("names a touched custom field in machine-readable JSON", async () => {
    const { configDir, cacheDir } = await standardRoom();
    await writeMetadataFile(cacheDir, scopedMetadata());
    installUpdateApi({
      gets: [wpRecord(1, "open"), wpRecord(2, "field-touched-by-b")],
    });
    const result = await runWp(configDir, cacheDir, [
      "update",
      "675",
      "--json",
      "--field",
      "Formula=7",
    ]);
    expect(result.exitCode).toBe(5);
    const rendered = JSON.parse(result.stderr) as {
      error: {
        code: string;
        conflicting_fields?: Array<string>;
        message?: string;
        hint?: string;
      };
    };
    expect(rendered.error.code).toBe("CONFLICT");
    expect(rendered.error.conflicting_fields).toEqual(["customField11"]);
    expect(typeof rendered.error.message).toBe("string");
    expect(typeof rendered.error.hint).toBe("string");
  });

  test("never retries a conflict more than once", async () => {
    const { configDir, cacheDir } = await standardRoom();
    await writeMetadataFile(cacheDir, scopedMetadata());
    const { patchCalls } = installUpdateApi({
      gets: [],
      persistentGet: wpRecord(2, "open"),
    });
    const result = await runWp(configDir, cacheDir, [
      "update",
      "675",
      "--status",
      "Closed",
    ]);
    expect(result.exitCode).toBe(5);
    expect(patchCalls()).toBe(2);
  });

  test("a missing work package exits 4 on the initial read", async () => {
    const { configDir, cacheDir } = await standardRoom();
    await writeMetadataFile(cacheDir, scopedMetadata());
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    cleanups.push(async () => {
      await mockAgent.close();
      setGlobalDispatcher(new Agent());
    });
    mockAgent.get(INSTANCE)
      .intercept({ path: WP_PATH, method: "GET" })
      .reply(404, { _type: "Error" });
    const result = await runWp(configDir, cacheDir, [
      "update",
      "675",
      "--status",
      "Closed",
    ]);
    expect(result.exitCode).toBe(4);
  });

  test("refuses an update that changes nothing", async () => {
    const { configDir, cacheDir } = await standardRoom();
    await writeMetadataFile(cacheDir, scopedMetadata());
    installUpdateApi({ gets: [] });
    const result = await runWp(configDir, cacheDir, ["update", "675"]);
    expect(result.exitCode).toBe(1);
  });

  test("refuses a non-numeric reference", async () => {
    const { configDir, cacheDir } = await standardRoom();
    installUpdateApi({ gets: [] });
    const result = await runWp(configDir, cacheDir, [
      "update",
      "ship-the-thing",
      "--status",
      "Closed",
    ]);
    expect(result.exitCode).toBe(1);
  });
});
