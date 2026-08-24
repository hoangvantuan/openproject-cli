import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, test } from "vitest";

import { run } from "../src/run.js";
import { INSTANCE } from "./fixtures/metadata.js";

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
): Promise<{ configDir: string; cacheDir: string }> {
  const configDir = join(root, "config");
  const cacheDir = join(root, "cache");
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
  return { configDir, cacheDir };
}

const WP_PATH = "/api/v3/work_packages/675";
const TARGET_ID = 24;
const PROJECTS_WALK_PATH = "/api/v3/projects?pageSize=100";

/** One work package in project 13 at the given lockVersion. */
function wpInProject13(lockVersion: number, subject = "Ship the thing"): Record<string, unknown> {
  return {
    _type: "WorkPackage",
    id: 675,
    lockVersion,
    subject,
    createdAt: "2026-08-23T09:00:00Z",
    updatedAt: "2026-08-23T09:00:00Z",
    _links: {
      project: { href: "/api/v3/projects/13", title: "Operations" },
      type: { href: "/api/v3/types/2", title: "Task" },
      status: { href: "/api/v3/statuses/1", title: "In progress" },
      priority: { href: "/api/v3/priorities/3", title: "High" },
    },
  };
}

function wpLinks(projectHref: string, projectTitle: string): Record<string, unknown> {
  return {
    project: { href: projectHref, title: projectTitle },
    type: { href: "/api/v3/types/2", title: "Task" },
    status: { href: "/api/v3/statuses/1", title: "In progress" },
    priority: { href: "/api/v3/priorities/3", title: "High" },
  };
}

/** The moved record the instance returns, standing in project 24. */
function movedWp(lockVersion: number): Record<string, unknown> {
  return {
    ...wpInProject13(lockVersion),
    _links: wpLinks(`/api/v3/projects/${String(TARGET_ID)}`, "Web Platform"),
  };
}

function targetProjectHit(): Record<string, unknown> {
  return {
    _type: "Project",
    id: TARGET_ID,
    identifier: "web",
    name: "Web Platform",
  };
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

interface InstallOptions {
  /** Consumed in order by successive GETs of the work package. */
  readonly gets?: ReadonlyArray<Record<string, unknown>>;
  /** Served to every GET once the ordered ones are used up. */
  readonly persistentGet?: Record<string, unknown>;
  /** Status/body returned by each PATCH, in order. */
  readonly patchReplies: ReadonlyArray<{ status: number; body?: unknown }>;
  /** Serve the target project by id (default true). */
  readonly targetById?: boolean;
  /** Serve the projects walk for name resolution. */
  readonly projectsWalk?: Record<string, unknown> | false;
}

/**
 * Installs exactly these endpoints; any other request fails the whole
 * agent (net connect disabled), so the patch count proves how many
 * writes the command attempted.
 */
function installMoveApi(
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
  for (const body of options.gets ?? []) {
    pool.intercept({ path: WP_PATH, method: "GET" }).reply(200, body);
  }
  if (options.persistentGet !== undefined) {
    pool.intercept({ path: WP_PATH, method: "GET" })
      .reply(200, options.persistentGet)
      .persist();
  }
  if (options.targetById !== false) {
    pool.intercept({ path: `/api/v3/projects/${String(TARGET_ID)}`, method: "GET" })
      .reply(200, targetProjectHit())
      .persist();
  }
  if (options.projectsWalk !== false) {
    pool.intercept({ path: PROJECTS_WALK_PATH, method: "GET" })
      .reply(200, options.projectsWalk ?? halCollection(1, [targetProjectHit()]))
      .persist();
  }
  const patchBodies: Array<Record<string, unknown>> = [];
  let patches = 0;
  pool.intercept({ path: WP_PATH, method: "PATCH" }).reply((call) => {
    patchBodies.push(JSON.parse(String(call.body)) as Record<string, unknown>);
    const reply = options.patchReplies[patches] ?? { status: 409, body: {} };
    patches += 1;
    return { statusCode: reply.status, data: reply.body ?? {} };
  }).persist();
  return { patchBodies, patchCalls: () => patches };
}

async function runMove(
  configDir: string,
  cacheDir: string,
  args: ReadonlyArray<string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return run(
    ["wp", "move", ...args],
    { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
    {},
  );
}

async function standardRoom(): Promise<{ configDir: string; cacheDir: string }> {
  const root = await makeTempRoom("wp-move-");
  return writeSingleProfile(root);
}

describe("wp move", () => {
  test("moves by target id, sending lockVersion and the project link only", async () => {
    const { configDir, cacheDir } = await standardRoom();
    const api = installMoveApi({
      gets: [wpInProject13(2)],
      patchReplies: [{ status: 200, body: movedWp(3) }],
    });
    const result = await runMove(configDir, cacheDir, ["675", String(TARGET_ID)]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Ship the thing");
    expect(result.stdout).toContain("Web Platform");
    expect(api.patchBodies).toEqual([
      {
        lockVersion: 2,
        _links: { project: { href: `/api/v3/projects/${String(TARGET_ID)}` } },
      },
    ]);
  });

  test("resolves a target given by name through the projects walk", async () => {
    const { configDir, cacheDir } = await standardRoom();
    const api = installMoveApi({
      gets: [wpInProject13(2)],
      targetById: false,
      projectsWalk: halCollection(2, [
        { id: 13, identifier: "operations", name: "Operations" },
        targetProjectHit(),
      ]),
      patchReplies: [{ status: 200, body: movedWp(3) }],
    });
    const result = await runMove(configDir, cacheDir, ["675", "Web Platform"]);
    expect(result.exitCode).toBe(0);
    expect(api.patchBodies).toHaveLength(1);
  });

  test("refuses a work package already in the target without writing", async () => {
    const { configDir, cacheDir } = await standardRoom();
    const api = installMoveApi({
      persistentGet: movedWp(4),
      patchReplies: [],
    });
    const result = await runMove(configDir, cacheDir, ["675", String(TARGET_ID)]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already in project Web Platform (24)");
    expect(api.patchCalls()).toBe(0);
  });

  test("a 409 with an untouched project retries once with the fresh lockVersion", async () => {
    const { configDir, cacheDir } = await standardRoom();
    const api = installMoveApi({
      gets: [wpInProject13(2), wpInProject13(3, "Ship the thing, retitled")],
      patchReplies: [
        { status: 409, body: {} },
        { status: 200, body: movedWp(4) },
      ],
    });
    const result = await runMove(configDir, cacheDir, ["675", String(TARGET_ID)]);
    expect(result.exitCode).toBe(0);
    expect(api.patchCalls()).toBe(2);
    expect(api.patchBodies[1]).toMatchObject({ lockVersion: 3 });
  });

  test("a 409 after a concurrent move elsewhere is a named conflict", async () => {
    const { configDir, cacheDir } = await standardRoom();
    const api = installMoveApi({
      gets: [
        wpInProject13(2),
        {
          ...wpInProject13(3),
          _links: {
            ...wpInProject13(3)._links,
            project: { href: "/api/v3/projects/99", title: "Elsewhere" },
          },
        },
      ],
      patchReplies: [{ status: 409, body: {} }],
    });
    const result = await runMove(configDir, cacheDir, ["675", String(TARGET_ID)]);
    expect(result.exitCode).toBe(5);
    expect(result.stderr).toContain("[CONFLICT]");
    expect(result.stderr).toContain("moved while this move ran");
    expect(api.patchCalls()).toBe(1);
  });

  test("a 409 after somebody else moved it to the exact target reports the record", async () => {
    const { configDir, cacheDir } = await standardRoom();
    const api = installMoveApi({
      gets: [wpInProject13(2), movedWp(5)],
      patchReplies: [{ status: 409, body: {} }],
    });
    const result = await runMove(configDir, cacheDir, ["675", String(TARGET_ID)]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Web Platform");
    expect(api.patchCalls()).toBe(1);
  });

  test("a refusal the instance explains surfaces as API_ERROR with its words", async () => {
    const { configDir, cacheDir } = await standardRoom();
    installMoveApi({
      gets: [wpInProject13(2)],
      patchReplies: [
        {
          status: 422,
          body: {
            _type: "Error",
            message: "Type is not defined in the target project.",
            _embedded: { details: {} },
          },
        },
      ],
    });
    const result = await runMove(configDir, cacheDir, ["675", String(TARGET_ID)]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("[API_ERROR]");
    expect(result.stderr).toContain("Type is not defined in the target project.");
  });

  test("refuses a non-id work package reference before any traffic", async () => {
    const { configDir, cacheDir } = await standardRoom();
    const api = installMoveApi({
      gets: [],
      patchReplies: [],
    });
    const result = await runMove(configDir, cacheDir, ["six-seven-five", "24"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not an id");
    expect(api.patchCalls()).toBe(0);
  });
});
