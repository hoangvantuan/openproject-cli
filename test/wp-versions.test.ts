import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, test } from "vitest";

import { run } from "../src/run.js";
import { baseMetadata, INSTANCE, projectVocabulary } from "./fixtures/metadata.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

const WP_PATH = "/api/v3/work_packages/675";

interface VersionFieldSpec {
  readonly targetVersions?: { readonly multiple: boolean };
  readonly observedInVersions?: { readonly multiple: boolean };
}

interface Room {
  readonly configDir: string;
  readonly cacheDir: string;
}

/** A cache whose project vocabulary carries `fields` for Task (2) and Bug (6). */
async function room(
  fields: VersionFieldSpec | undefined,
  versions = [
    { id: 31, name: "0.9.0", status: "open" },
    { id: 32, name: "1.0.0", status: "open" },
  ],
): Promise<Room> {
  const root = await mkdtemp(join(tmpdir(), "wp-versions-"));
  cleanups.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const configDir = join(root, "config");
  const cacheDir = join(root, "cache");
  await mkdir(configDir, { recursive: true });
  await mkdir(join(cacheDir, "default"), { recursive: true });
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      default_profile: "default",
      active_profile: "default",
      profiles: { default: { url: INSTANCE, project: 13 } },
    }),
  );
  await writeFile(
    join(configDir, "credentials.json"),
    JSON.stringify({ default: { api_key: "secret-key" } }),
    { mode: 0o600 },
  );
  const vocabulary = projectVocabulary(
    {},
    fields === undefined ? {} : { "2": fields, "6": fields },
  );
  const stored = { ...vocabulary, versions } as Record<string, unknown>;
  await writeFile(
    join(cacheDir, "default", "metadata.json"),
    JSON.stringify({ ...baseMetadata(), projectScoped: { "13": stored } }),
  );
  return { configDir, cacheDir };
}

function install(): {
  bodies: Array<{ method: string; body: Record<string, unknown> }>;
  paths: Array<string>;
} {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  cleanups.push(async () => {
    await mockAgent.close();
    setGlobalDispatcher(new Agent());
  });
  const pool = mockAgent.get(INSTANCE);
  const bodies: Array<{ method: string; body: Record<string, unknown> }> = [];
  const paths: Array<string> = [];
  const record = {
    _type: "WorkPackage",
    id: 675,
    lockVersion: 3,
    subject: "Ship",
    _links: {
      type: { href: "/api/v3/types/2", title: "Task" },
      project: { href: "/api/v3/projects/13", title: "Operations" },
      targetVersions: [{ href: "/api/v3/versions/31", title: "0.9.0" }],
      version: { href: "/api/v3/versions/31", title: "0.9.0" },
    },
  };
  pool.intercept({ path: WP_PATH, method: "GET" }).reply(200, record).persist();
  pool.intercept({ path: WP_PATH, method: "PATCH" }).reply((call) => {
    bodies.push({ method: "PATCH", body: JSON.parse(String(call.body)) });
    return { statusCode: 200, data: record };
  }).persist();
  pool.intercept({ path: "/api/v3/work_packages", method: "POST" }).reply((call) => {
    bodies.push({ method: "POST", body: JSON.parse(String(call.body)) });
    return { statusCode: 201, data: record };
  }).persist();
  pool.intercept({ path: (path) => path.startsWith("/api/v3/work_packages?"), method: "GET" })
    .reply((call) => {
      paths.push(String(call.path));
      return {
        statusCode: 200,
        data: {
          _type: "Collection",
          total: 4,
          count: 0,
          pageSize: 100,
          offset: 1,
          _embedded: { elements: [] },
          _links: {},
        },
      };
    })
    .persist();
  return { bodies, paths };
}

async function wp(
  r: Room,
  args: ReadonlyArray<string>,
  stdin?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return run(
    ["wp", ...args],
    { OP_CLI_CONFIG_DIR: r.configDir, OP_CLI_CACHE_DIR: r.cacheDir },
    stdin === undefined ? {} : { readStdin: async () => stdin },
  );
}

const MULTI = { targetVersions: { multiple: true }, observedInVersions: { multiple: true } };
const SINGLE = { targetVersions: { multiple: false }, observedInVersions: { multiple: false } };
const LEGACY = {};

describe("wp --version writes through the schema (#47)", () => {
  test("update writes targetVersions when the schema has it, never version", async () => {
    const r = await room(MULTI);
    const api = install();
    const result = await wp(r, ["update", "675", "--version", "1.0.0"]);
    expect(result.exitCode).toBe(0);
    expect(api.bodies[0]?.body._links).toEqual({
      targetVersions: [{ href: "/api/v3/versions/32" }],
    });
  });

  test("update falls back to version when the schema lacks targetVersions", async () => {
    const r = await room(LEGACY);
    const api = install();
    const result = await wp(r, ["update", "675", "--version", "1.0.0"]);
    expect(result.exitCode).toBe(0);
    expect(api.bodies[0]?.body._links).toEqual({
      version: { href: "/api/v3/versions/32" },
    });
  });

  test("create writes targetVersions", async () => {
    const r = await room(MULTI);
    const api = install();
    const result = await wp(r, ["create", "Ship", "--type", "Task", "--version", "0.9.0"]);
    expect(result.exitCode).toBe(0);
    const links = api.bodies[0]?.body._links as Record<string, unknown>;
    expect(links.targetVersions).toEqual([{ href: "/api/v3/versions/31" }]);
    expect(links).not.toHaveProperty("version");
  });

  test("create falls back to version on a legacy schema", async () => {
    const r = await room(LEGACY);
    const api = install();
    await wp(r, ["create", "Ship", "--type", "Task", "--version", "0.9.0"]);
    const links = api.bodies[0]?.body._links as Record<string, unknown>;
    expect(links.version).toEqual({ href: "/api/v3/versions/31" });
    expect(links).not.toHaveProperty("targetVersions");
  });

  test("repeatable when the schema allows several", async () => {
    const r = await room(MULTI);
    const api = install();
    await wp(r, ["update", "675", "--version", "0.9.0", "--version", "1.0.0"]);
    expect(api.bodies[0]?.body._links).toEqual({
      targetVersions: [
        { href: "/api/v3/versions/31" },
        { href: "/api/v3/versions/32" },
      ],
    });
  });

  test("more than one value is a USAGE_ERROR when the schema allows one", async () => {
    const r = await room(SINGLE);
    const api = install();
    const result = await wp(r, ["update", "675", "--version", "0.9.0", "--version", "1.0.0"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--version");
    expect(api.bodies).toEqual([]);
  });

  test("more than one value is a USAGE_ERROR on the legacy version link", async () => {
    const r = await room(LEGACY);
    install();
    const result = await wp(r, ["update", "675", "--version", "0.9.0", "--version", "1.0.0"]);
    expect(result.exitCode).toBe(1);
  });

  test('--version "" clears targetVersions with an empty array', async () => {
    const r = await room(MULTI);
    const api = install();
    const result = await wp(r, ["update", "675", "--version", ""]);
    expect(result.exitCode).toBe(0);
    expect(api.bodies[0]?.body._links).toEqual({ targetVersions: [] });
  });

  test('--version "" clears the legacy link with a null href', async () => {
    const r = await room(LEGACY);
    const api = install();
    await wp(r, ["update", "675", "--version", ""]);
    expect(api.bodies[0]?.body._links).toEqual({ version: { href: null } });
  });

  test('--version "" mixed with a value is refused', async () => {
    const r = await room(MULTI);
    const api = install();
    const result = await wp(r, ["update", "675", "--version", "", "--version", "1.0.0"]);
    expect(result.exitCode).toBe(1);
    expect(api.bodies).toEqual([]);
  });

  test('--version "" on create is refused', async () => {
    const r = await room(MULTI);
    install();
    const result = await wp(r, ["create", "Ship", "--version", ""]);
    expect(result.exitCode).toBe(1);
  });

  test("a legacy cache without version_fields is refreshed from the schema", async () => {
    const r = await room(MULTI);
    // Rewrite the cache the way an older release left it.
    const path = join(r.cacheDir, "default", "metadata.json");
    const { readFile } = await import("node:fs/promises");
    const stored = JSON.parse(await readFile(path, "utf8")) as {
      projectScoped: Record<string, Record<string, unknown>>;
    };
    delete stored.projectScoped["13"]?.version_fields;
    await writeFile(path, JSON.stringify(stored));
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    cleanups.push(async () => {
      await mockAgent.close();
      setGlobalDispatcher(new Agent());
    });
    const pool = mockAgent.get(INSTANCE);
    const collection = (elements: Array<Record<string, unknown>>): Record<string, unknown> => ({
      _type: "Collection",
      total: elements.length,
      count: elements.length,
      pageSize: 100,
      offset: 1,
      _embedded: { elements },
      _links: {},
    });
    const empty = collection([]);
    for (const p of ["/api/v3/types", "/api/v3/statuses", "/api/v3/priorities"]) {
      pool.intercept({ path: (candidate) => candidate.startsWith(p), method: "GET" })
        .reply(200, empty).persist();
    }
    pool.intercept({ path: "/api/v3/projects/13", method: "GET" })
      .reply(200, { id: 13, identifier: "ops", name: "Operations" }).persist();
    pool.intercept({ path: (c) => c.startsWith("/api/v3/projects/13/versions"), method: "GET" })
      .reply(200, collection([{ id: 32, name: "1.0.0", status: "open" }])).persist();
    pool.intercept({ path: (c) => c.startsWith("/api/v3/projects/13/types"), method: "GET" })
      .reply(200, collection([{ id: 2, name: "Task" }])).persist();
    for (const p of ["memberships", "categories", "time_entries/activities"]) {
      pool.intercept({ path: (c) => c.includes(p), method: "GET" })
        .reply(200, empty).persist();
    }
    pool.intercept({ path: "/api/v3/time_entries/form", method: "POST" })
      .reply(200, { _embedded: { schema: {} } }).persist();
    pool.intercept({ path: "/api/v3/projects/13/work_packages/form", method: "POST" })
      .reply(200, {
        _embedded: {
          schema: { targetVersions: { type: "[]Version", options: { multiple: true } } },
        },
      }).persist();
    pool.intercept({ path: WP_PATH, method: "GET" }).reply(200, {
      id: 675,
      lockVersion: 1,
      _links: { type: { href: "/api/v3/types/2" } },
    });
    const bodies: Array<Record<string, unknown>> = [];
    pool.intercept({ path: WP_PATH, method: "PATCH" }).reply((call) => {
      bodies.push(JSON.parse(String(call.body)));
      return { statusCode: 200, data: { id: 675, _links: {} } };
    });
    const result = await wp(r, ["update", "675", "--version", "1.0.0"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(bodies[0]?._links).toEqual({ targetVersions: [{ href: "/api/v3/versions/32" }] });
  });
});

describe("wp --observed-in (#47)", () => {
  test("update writes observedInVersions", async () => {
    const r = await room(MULTI);
    const api = install();
    await wp(r, ["update", "675", "--observed-in", "0.9.0", "--observed-in", "1.0.0"]);
    expect(api.bodies[0]?.body._links).toEqual({
      observedInVersions: [
        { href: "/api/v3/versions/31" },
        { href: "/api/v3/versions/32" },
      ],
    });
  });

  test("create writes observedInVersions next to targetVersions", async () => {
    const r = await room(MULTI);
    const api = install();
    await wp(r, ["create", "Ship", "--type", "Task", "--version", "0.9.0", "--observed-in", "1.0.0"]);
    const links = api.bodies[0]?.body._links as Record<string, unknown>;
    expect(links.targetVersions).toEqual([{ href: "/api/v3/versions/31" }]);
    expect(links.observedInVersions).toEqual([{ href: "/api/v3/versions/32" }]);
  });

  test('"" clears on update', async () => {
    const r = await room(MULTI);
    const api = install();
    await wp(r, ["update", "675", "--observed-in", ""]);
    expect(api.bodies[0]?.body._links).toEqual({ observedInVersions: [] });
  });

  test("is a USAGE_ERROR when the schema lacks the field", async () => {
    const r = await room({ targetVersions: { multiple: true } });
    const api = install();
    const result = await wp(r, ["update", "675", "--observed-in", "0.9.0"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--observed-in");
    expect(api.bodies).toEqual([]);
  });

  test("more than one value is refused when the schema allows one", async () => {
    const r = await room(SINGLE);
    install();
    const result = await wp(r, ["update", "675", "--observed-in", "0.9.0", "--observed-in", "1.0.0"]);
    expect(result.exitCode).toBe(1);
  });

  test("filters list and count by observedInVersion", async () => {
    const r = await room(MULTI);
    const api = install();
    const list = await wp(r, ["list", "--observed-in", "1.0.0"]);
    expect(list.exitCode, list.stderr).toBe(0);
    const count = await wp(r, ["count", "--observed-in", "0.9.0", "--observed-in", "32"]);
    expect(count.exitCode, count.stderr).toBe(0);
    const decode = (path: string | undefined): unknown =>
      JSON.parse(decodeURIComponent(/filters=([^&]*)/.exec(path ?? "")?.[1] ?? ""));
    expect(decode(api.paths[0])).toContainEqual({
      observedInVersion: { operator: "=", values: ["32"] },
    });
    expect(decode(api.paths[1])).toContainEqual({
      observedInVersion: { operator: "=", values: ["31", "32"] },
    });
  });

  test("filtering is a USAGE_ERROR when the schema lacks the field", async () => {
    const r = await room(LEGACY);
    install();
    const result = await wp(r, ["list", "--observed-in", "1.0.0"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--observed-in");
  });
});

describe("wp create --stdin versions (#47)", () => {
  test("version accepts a string or an array of strings", async () => {
    const r = await room(MULTI);
    const api = install();
    const result = await wp(r, ["create", "--stdin", "--type", "Task"], JSON.stringify([
      { subject: "One", version: "0.9.0" },
      { subject: "Two", version: ["0.9.0", "1.0.0"], observedIn: "1.0.0" },
    ]));
    expect(result.exitCode, result.stderr).toBe(0);
    const links = api.bodies.map((entry) => entry.body._links as Record<string, unknown>);
    expect(links[0]?.targetVersions).toEqual([{ href: "/api/v3/versions/31" }]);
    expect(links[1]?.targetVersions).toEqual([
      { href: "/api/v3/versions/31" },
      { href: "/api/v3/versions/32" },
    ]);
    expect(links[1]?.observedInVersions).toEqual([{ href: "/api/v3/versions/32" }]);
  });

  test("an empty or non-string entry is refused for that item", async () => {
    const r = await room(MULTI);
    const api = install();
    const result = await wp(r, ["create", "--stdin"], JSON.stringify([
      { subject: "One", version: [""] },
      { subject: "Two", version: [3] },
    ]));
    expect(result.exitCode).toBe(1);
    expect(api.bodies).toEqual([]);
    expect(result.stdout).toContain("input 0");
    expect(result.stdout).toContain("input 1");
  });
});

describe("wp get shows targetVersions (#47)", () => {
  test("default record lists targetVersions; version stays in JSON", async () => {
    const r = await room(MULTI);
    install();
    const table = await wp(r, ["get", "675"]);
    expect(table.stdout).toContain("targetVersions");
    const json = await wp(r, ["get", "675", "--json"]);
    const record = JSON.parse(json.stdout) as Record<string, unknown>;
    expect(record).toHaveProperty("version");
    expect(record).toHaveProperty("targetVersions");
  });
});
