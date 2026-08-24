import { mkdir, mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
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

interface InstallOptions {
  readonly instanceUrl: string;
  readonly packages?: Record<string, unknown>;
}

/**
 * Installs exactly the endpoints listed. Any other request fails the whole
 * agent (net connect disabled), so a green run proves no extra HTTP traffic,
 * including no metadata prefetch behind the scenes.
 */
function installMockApi(options: InstallOptions): MockAgent {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  cleanups.push(async () => {
    await mockAgent.close();
    setGlobalDispatcher(new Agent());
  });
  const pool = mockAgent.get(options.instanceUrl);
  for (const [path, body] of Object.entries(options.packages ?? {})) {
    pool.intercept({ path, method: "GET" }).reply(200, body).persist();
  }
  return mockAgent;
}

// A scrubbed single-work-package HAL fixture shaped like a real v3 response:
// scalars at the top level, resources under _links, no _embedded payload.
function workPackageFixture(): Record<string, unknown> {
  return {
    _type: "WorkPackage",
    id: 1520,
    lockVersion: 7,
    subject: "Fix login redirect",
    description: { format: "markdown", raw: "Repro: open /login." },
    startDate: "2026-08-10",
    dueDate: null,
    percentageDone: 40,
    createdAt: "2026-08-01T09:15:00Z",
    updatedAt: "2026-08-20T14:02:11Z",
    _links: {
      self: { href: "/api/v3/work_packages/1520" },
      project: { href: "/api/v3/projects/13", title: "Operations" },
      type: { href: "/api/v3/types/2", title: "Task" },
      status: { href: "/api/v3/statuses/12", title: "In progress" },
      priority: { href: "/api/v3/priorities/3", title: "High" },
      author: { href: "/api/v3/users/5", title: "Tuan Ha" },
      assignee: { href: "/api/v3/users/9", title: "Linh Nguyen" },
      version: { href: "/api/v3/versions/21", title: "0.1.0" },
      category: { href: null, title: null },
      attachments: { href: "/api/v3/work_packages/1520/attachments" },
      // Operations, not resources: a real record carries dozens of them.
      update: { href: "/api/v3/work_packages/1520/form", method: "post" },
      updateImmediately: { href: "/api/v3/work_packages/1520", method: "patch" },
      delete: { href: "/api/v3/work_packages/1520", method: "delete" },
      pdf: { href: "/api/v3/work_packages/1520/pdf" },
      configureForm: { href: "/api/v3/types/2/edit/form_configuration" },
    },
  };
}

async function runWpGet(
  configDir: string,
  cacheDir: string,
  args: ReadonlyArray<string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return run(["wp", "get", ...args], { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir }, {});
}

describe("wp get", () => {
  test("renders the flattened record as a field-value table by default", async () => {
    const root = await makeTempRoom("op-cli-wp-table-");
    const { configDir, cacheDir } = await writeSingleProfile(root, "https://op.example");
    installMockApi({
      instanceUrl: "https://op.example",
      packages: { "/api/v3/work_packages/1520": workPackageFixture() },
    });

    const result = await runWpGet(configDir, cacheDir, ["1520"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      renderTable(
        ["FIELD", "VALUE"],
        [
          ["id", "1520"],
          ["subject", "Fix login redirect"],
          ["type", "Task"],
          ["status", "In progress"],
          ["priority", "High"],
          ["assignee", "Linh Nguyen"],
          ["author", "Tuan Ha"],
          ["project", "Operations"],
          ["version", "0.1.0"],
          ["category", ""],
          ["startDate", "2026-08-10"],
          ["dueDate", ""],
          ["createdAt", "2026-08-01T09:15:00Z"],
          ["updatedAt", "2026-08-20T14:02:11Z"],
          ["lockVersion", "7"],
          ["description", '{"format":"markdown","raw":"Repro: open /login."}'],
          ["percentageDone", "40"],
        ],
      ),
    );
  });

  test("--json emits a bare flat record with links reduced to id and name", async () => {
    const root = await makeTempRoom("op-cli-wp-json-");
    const { configDir, cacheDir } = await writeSingleProfile(root, "https://op.example");
    installMockApi({
      instanceUrl: "https://op.example",
      packages: { "/api/v3/work_packages/1520": workPackageFixture() },
    });

    const result = await runWpGet(configDir, cacheDir, ["1520", "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed)[0]).toBe("id");
    expect(parsed).toEqual({
      id: 1520,
      lockVersion: 7,
      subject: "Fix login redirect",
      description: { format: "markdown", raw: "Repro: open /login." },
      startDate: "2026-08-10",
      dueDate: null,
      percentageDone: 40,
      createdAt: "2026-08-01T09:15:00Z",
      updatedAt: "2026-08-20T14:02:11Z",
      project: { id: 13, name: "Operations" },
      type: { id: 2, name: "Task" },
      status: { id: 12, name: "In progress" },
      priority: { id: 3, name: "High" },
      author: { id: 5, name: "Tuan Ha" },
      assignee: { id: 9, name: "Linh Nguyen" },
      version: { id: 21, name: "0.1.0" },
      // An unset attribute is data: the record says so instead of hiding it.
      category: { id: null, name: null },
    });
    for (const banned of ["_links", "_embedded", "_type", "error", "_meta"]) {
      expect(parsed[banned]).toBeUndefined();
    }
  });

  test("--json drops the links that name no resource", async () => {
    const root = await makeTempRoom("op-cli-wp-json-links-");
    const { configDir, cacheDir } = await writeSingleProfile(root, "https://op.example");
    installMockApi({
      instanceUrl: "https://op.example",
      packages: { "/api/v3/work_packages/1520": workPackageFixture() },
    });

    const result = await runWpGet(configDir, cacheDir, ["1520", "--json"]);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    // An operation carries no data, and the id it would flatten to is the
    // work package's own, which reads as a resource it is not.
    for (const operation of ["update", "updateImmediately", "delete", "pdf", "configureForm"]) {
      expect(parsed[operation], operation).toBeUndefined();
    }
    // A collection endpoint names nothing either.
    expect(parsed["attachments"]).toBeUndefined();
  });

  test("--fields picks the same named columns in the JSON record", async () => {
    const root = await makeTempRoom("op-cli-wp-fields-json-");
    const { configDir, cacheDir } = await writeSingleProfile(root, "https://op.example");
    installMockApi({
      instanceUrl: "https://op.example",
      packages: { "/api/v3/work_packages/1520": workPackageFixture() },
    });

    const result = await runWpGet(configDir, cacheDir, [
      "1520",
      "--json",
      "--fields",
      "id,status",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      id: 1520,
      status: { id: 12, name: "In progress" },
    });
  });

  test("--fields picks the same named columns in the table", async () => {
    const root = await makeTempRoom("op-cli-wp-fields-table-");
    const { configDir, cacheDir } = await writeSingleProfile(root, "https://op.example");
    installMockApi({
      instanceUrl: "https://op.example",
      packages: { "/api/v3/work_packages/1520": workPackageFixture() },
    });

    const result = await runWpGet(configDir, cacheDir, [
      "1520",
      "--fields",
      "subject,status",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      renderTable(
        ["FIELD", "VALUE"],
        [
          ["subject", "Fix login redirect"],
          ["status", "In progress"],
        ],
      ),
    );
  });

  test("an unknown --fields name exits 1 listing valid fields, closest first", async () => {
    const root = await makeTempRoom("op-cli-wp-fields-miss-");
    const { configDir, cacheDir } = await writeSingleProfile(root, "https://op.example");
    installMockApi({
      instanceUrl: "https://op.example",
      packages: { "/api/v3/work_packages/1520": workPackageFixture() },
    });

    const result = await runWpGet(configDir, cacheDir, [
      "1520",
      "--fields",
      "statu",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('field "statu" is not a column.');
    const statusAt = result.stderr.indexOf("status");
    const subjectAt = result.stderr.indexOf("subject");
    const updatedAtAt = result.stderr.indexOf("updatedAt");
    expect(statusAt).toBeGreaterThan(-1);
    expect(statusAt).toBeLessThan(subjectAt);
    expect(subjectAt).toBeLessThan(updatedAtAt);
  });

  test("a work package that does not exist exits 4", async () => {
    const root = await makeTempRoom("op-cli-wp-missing-");
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
      .intercept({ path: "/api/v3/work_packages/999999", method: "GET" })
      .reply(404, { _type: "Error", message: "WorkPackage 999999 does not exist." });

    const result = await runWpGet(configDir, cacheDir, ["999999"]);

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toMatch(/^\[NOT_FOUND\]/);
  });

  test("a reference that is not all digits is refused as misuse", async () => {
    const root = await makeTempRoom("op-cli-wp-nonnumeric-");
    const { configDir, cacheDir } = await writeSingleProfile(root, "https://op.example");
    installMockApi({ instanceUrl: "https://op.example", packages: {} });

    const result = await runWpGet(configDir, cacheDir, ["Fix login redirect"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^\[USAGE_ERROR\]/);
    expect(result.stderr).toContain('"Fix login redirect"');
  });

  test("an all-digits reference is used as an id and never resolved", async () => {
    const root = await makeTempRoom("op-cli-wp-id-passthrough-");
    const { configDir, cacheDir } = await writeSingleProfile(root, "https://op.example");
    installMockApi({
      instanceUrl: "https://op.example",
      packages: { "/api/v3/work_packages/1520": workPackageFixture() },
    });

    const result = await runWpGet(configDir, cacheDir, ["1520", "--json"]);

    // Green means the WP endpoint answered and nothing else was contacted:
    // net connect is disabled, so a metadata prefetch would fail the run.
    expect(result.exitCode).toBe(0);
    await expect(readdir(cacheDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
