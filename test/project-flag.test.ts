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

const INSTANCE = "https://op.example.dev";
const PROJECTS_PAGE = "/api/v3/projects?pageSize=100";

/**
 * Installs exactly the endpoints listed. Any other request fails the whole
 * agent (net connect disabled), so a green run proves no extra HTTP traffic:
 * a numeric --project must never pay for the projects walk.
 */
function installMockApi(gets: Record<string, object>): void {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  cleanups.push(async () => {
    await mockAgent.close();
    setGlobalDispatcher(new Agent());
  });
  const pool = mockAgent.get(INSTANCE);
  for (const [path, body] of Object.entries(gets)) {
    pool.intercept({ path, method: "GET" }).reply(200, body).persist();
  }
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

function projectElement(
  id: number,
  identifier: string,
  name: string,
): Record<string, unknown> {
  return { _type: "Project", id, identifier, name, active: true, public: false };
}

const ALL_PROJECTS = [
  projectElement(13, "operations", "Operations"),
  projectElement(21, "demo-site", "Demo Site"),
];

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
      project: { href: "/api/v3/projects/21", title: "Demo Site" },
      type: { href: "/api/v3/types/2", title: "Task" },
      status: { href: "/api/v3/statuses/1", title: "In progress" },
      priority: { href: "/api/v3/priorities/3", title: "High" },
    },
  };
}

function scopedListing(projectId: string): string {
  return `/api/v3/work_packages?filters=${encodeURIComponent(
    JSON.stringify([{ project: { operator: "=", values: [projectId] } }]),
  )}&pageSize=100`;
}

async function runWp(
  configDir: string,
  cacheDir: string,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return run(
    ["wp", ...args],
    { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir, ...env },
    {},
  );
}

describe("--project name-or-id (#34)", () => {
  test.each([
    ["an identifier", "demo-site"],
    ["a name", "Demo Site"],
  ])("wp list accepts --project given as %s", async (_label, reference) => {
    const root = await makeTempRoom("wp-list-project-ref-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      [PROJECTS_PAGE]: halCollection(2, ALL_PROJECTS),
      [scopedListing("21")]: halCollection(1, [wpElement(3204, "Scratch item")]),
    });
    const result = await runWp(configDir, cacheDir, ["list", "--project", reference]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Scratch item");
  });

  test("a numeric id keeps the no-traffic fast path", async () => {
    const root = await makeTempRoom("wp-list-project-id-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    // No projects collection installed: a resolution walk would fail the
    // whole mock agent, so green proves the id never resolved by name.
    installMockApi({
      [scopedListing("21")]: halCollection(1, [wpElement(3204, "Scratch item")]),
    });
    const result = await runWp(configDir, cacheDir, ["list", "--project", "21"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Scratch item");
  });

  test("an unknown name exits 4 naming the project, not a bare usage error", async () => {
    const root = await makeTempRoom("wp-list-project-unknown-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      [PROJECTS_PAGE]: halCollection(2, ALL_PROJECTS),
    });
    const result = await runWp(configDir, cacheDir, ["list", "--project", "Demo Sit"]);
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain('project "Demo Sit" not found');
    expect(result.stderr).toContain("Demo Site");
    expect(result.stderr).not.toContain("USAGE_ERROR");
  });

  test("an invalid digit form is refused before any traffic", async () => {
    const root = await makeTempRoom("wp-list-project-zero-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({});
    const result = await runWp(configDir, cacheDir, ["list", "--project", "0"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[USAGE_ERROR]");
  });

  test("OP_CLI_PROJECT accepts a name too", async () => {
    const root = await makeTempRoom("wp-list-project-env-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      [PROJECTS_PAGE]: halCollection(2, ALL_PROJECTS),
      [scopedListing("21")]: halCollection(1, [wpElement(3204, "Scratch item")]),
    });
    const result = await runWp(
      configDir,
      cacheDir,
      ["list"],
      { OP_CLI_PROJECT: "demo-site" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Scratch item");
  });

  test("auth status reports the resolved numeric id for a named project", async () => {
    const root = await makeTempRoom("auth-status-project-ref-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      "/api/v3/users/me": { id: 7, name: "Ada Lovelace", login: "ada" },
      [PROJECTS_PAGE]: halCollection(2, ALL_PROJECTS),
    });
    const result = await run(
      ["auth", "status", "--json", "--project", "Demo Site"],
      { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
      {},
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).project).toBe(21);
  });
});
