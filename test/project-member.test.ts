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
const PRINCIPALS_PAGE = "/api/v3/principals?pageSize=100";
const ROLES_PAGE = "/api/v3/roles?pageSize=100";

function halCollection(
  total: number,
  elements: unknown[],
): Record<string, unknown> {
  return {
    _type: "Collection",
    total,
    count: elements.length,
    _embedded: { elements },
  };
}

function projectElement(
  id: number,
  identifier: string,
  name: string,
): Record<string, unknown> {
  return {
    _type: "Project",
    id,
    identifier,
    name,
    active: true,
    public: false,
    _links: { self: { href: `/api/v3/projects/${String(id)}` } },
  };
}

function principalElement(
  id: number,
  name: string,
  type = "User",
): Record<string, unknown> {
  return {
    _type: type,
    id,
    name,
    _links: { self: { href: `/api/v3/principals/${String(id)}` } },
  };
}

function roleElement(id: number, title: string): Record<string, unknown> {
  return {
    _type: "Role",
    id,
    title,
    _links: { self: { href: `/api/v3/roles/${String(id)}` } },
  };
}

function membershipElement(id: number): Record<string, unknown> {
  return {
    _type: "Membership",
    id,
    createdAt: "2026-08-24T09:00:00Z",
    updatedAt: "2026-08-24T09:00:00Z",
    _links: {
      self: { href: `/api/v3/memberships/${String(id)}` },
      project: { href: "/api/v3/projects/21", title: "Demo Site" },
      principal: { href: "/api/v3/users/7", title: "Linh Nguyen" },
      roles: [{ href: "/api/v3/roles/3", title: "Manager" }],
    },
  };
}

interface RecordedWrite {
  readonly path: string;
  readonly method: string;
  readonly body: string;
}

/**
 * Installs exactly the endpoints listed. Any other request fails the whole
 * agent (net connect disabled), so a green run proves no extra traffic.
 */
function installMemberApi(options: {
  readonly gets?: Record<string, unknown>;
  readonly posts?: ReadonlyArray<{
    readonly path: string;
    readonly status: number;
    readonly body?: unknown;
  }>;
  readonly deletes?: ReadonlyArray<{ path: string; status?: number }>;
}): { writes: Array<RecordedWrite>; postBodies: Array<Record<string, unknown>> } {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  cleanups.push(async () => {
    await mockAgent.close();
    setGlobalDispatcher(new Agent());
  });
  const pool = mockAgent.get(INSTANCE);
  const writes: Array<RecordedWrite> = [];
  const postBodies: Array<Record<string, unknown>> = [];
  for (const [path, body] of Object.entries(options.gets ?? {})) {
    pool.intercept({ path, method: "GET" }).reply(200, body).persist();
  }
  for (const post of options.posts ?? []) {
    pool.intercept({ path: post.path, method: "POST" }).reply((call) => {
      writes.push({
        path: post.path,
        method: "POST",
        body: String(call.body ?? ""),
      });
      postBodies.push(JSON.parse(String(call.body)) as Record<string, unknown>);
      return { statusCode: post.status, data: post.body ?? "" };
    }).persist();
  }
  for (const del of options.deletes ?? []) {
    pool.intercept({ path: del.path, method: "DELETE" }).reply((call) => {
      writes.push({
        path: del.path,
        method: "DELETE",
        body: String(call.body ?? ""),
      });
      return { statusCode: del.status ?? 204, data: "" };
    }).persist();
  }
  return { writes, postBodies };
}

const DEMO_SITE = projectElement(21, "demo-site", "Demo Site");
const PRINCIPALS = [
  principalElement(7, "Linh Nguyen"),
  principalElement(9, "Minh Tran"),
];
const ROLES = [
  roleElement(3, "Manager"),
  roleElement(4, "Member"),
];

/** The collection pages every by-name resolution walks. */
function baseGets(): Record<string, unknown> {
  return {
    [PROJECTS_PAGE]: halCollection(1, [DEMO_SITE]),
    [PRINCIPALS_PAGE]: halCollection(PRINCIPALS.length, PRINCIPALS),
    [ROLES_PAGE]: halCollection(ROLES.length, ROLES),
  };
}

/** The memberships filter query the remove command builds. */
function membershipsPath(projectId: number, principalId: number): string {
  const filters = encodeURIComponent(JSON.stringify([
    { project: { operator: "=", values: [String(projectId)] } },
    { principal: { operator: "=", values: [String(principalId)] } },
  ]));
  return `/api/v3/memberships?filters=${filters}&pageSize=100`;
}

async function runProject(
  configDir: string,
  cacheDir: string,
  args: ReadonlyArray<string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return run(
    ["project", ...args],
    { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
    {},
  );
}

describe("project member registration", () => {
  test("the project group exposes member add and remove", async () => {
    const root = await makeTempRoom("member-help-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const result = await runProject(configDir, cacheDir, ["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("member");
    const sub = await runProject(configDir, cacheDir, ["member", "--help"]);
    expect(sub.exitCode).toBe(0);
    expect(sub.stdout).toContain("add");
    expect(sub.stdout).toContain("remove");
  });
});

describe("project member add", () => {
  test("resolves project, principal, and roles by name into one POST", async () => {
    const root = await makeTempRoom("member-add-names-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const { writes, postBodies } = installMemberApi({
      gets: baseGets(),
      posts: [
        { path: "/api/v3/memberships", status: 201, body: membershipElement(77) },
      ],
    });
    const result = await runProject(configDir, cacheDir, [
      "member",
      "add",
      "demo-site",
      "Linh Nguyen",
      "Manager",
    ]);
    expect(result.exitCode).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe("/api/v3/memberships");
    const links = postBodies[0]?._links as {
      project: { href: string };
      principal: { href: string };
      roles: Array<{ href: string }>;
    };
    expect(links.project.href).toBe("/api/v3/projects/21");
    expect(links.principal.href).toBe("/api/v3/principals/7");
    expect(links.roles).toEqual([{ href: "/api/v3/roles/3" }]);
    expect(result.stdout).toContain("77");
  });

  test("accepts several roles in one membership", async () => {
    const root = await makeTempRoom("member-add-multirole-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const { postBodies } = installMemberApi({
      gets: baseGets(),
      posts: [
        { path: "/api/v3/memberships", status: 201, body: membershipElement(78) },
      ],
    });
    const result = await runProject(configDir, cacheDir, [
      "member",
      "add",
      "Demo Site",
      "Minh Tran",
      "Manager",
      "Member",
    ]);
    expect(result.exitCode).toBe(0);
    const links = postBodies[0]?._links as {
      roles: Array<{ href: string }>;
    };
    expect(links.roles).toEqual([
      { href: "/api/v3/roles/3" },
      { href: "/api/v3/roles/4" },
    ]);
  });

  test("resolves me through authentication without listing principals", async () => {
    const root = await makeTempRoom("member-add-me-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    // No principals endpoint installed: any principal walk would fail.
    const { postBodies } = installMemberApi({
      gets: {
        [PROJECTS_PAGE]: halCollection(1, [DEMO_SITE]),
        [ROLES_PAGE]: halCollection(ROLES.length, ROLES),
        "/api/v3/users/me": {
          _type: "User",
          id: 5,
          name: "Admin User",
          login: "admin",
        },
      },
      posts: [
        { path: "/api/v3/memberships", status: 201, body: membershipElement(79) },
      ],
    });
    const result = await runProject(configDir, cacheDir, [
      "member",
      "add",
      "demo-site",
      "me",
      "Member",
    ]);
    expect(result.exitCode).toBe(0);
    const links = postBodies[0]?._links as {
      principal: { href: string };
    };
    expect(links.principal.href).toBe("/api/v3/principals/5");
  });

  test("takes all-digits values as ids with no resolution traffic", async () => {
    const root = await makeTempRoom("member-add-ids-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    // Only the numeric project reference is fetched; the principal and
    // role ids pass through untouched, so those endpoints stay unmounted
    // and would fail the agent on any lookup attempt.
    const { postBodies } = installMemberApi({
      gets: { "/api/v3/projects/21": DEMO_SITE },
      posts: [
        { path: "/api/v3/memberships", status: 201, body: membershipElement(80) },
      ],
    });
    const result = await runProject(configDir, cacheDir, [
      "member",
      "add",
      "21",
      "7",
      "3",
    ]);
    expect(result.exitCode).toBe(0);
    const links = postBodies[0]?._links as {
      project: { href: string };
      principal: { href: string };
      roles: Array<{ href: string }>;
    };
    expect(links.project.href).toBe("/api/v3/projects/21");
    expect(links.principal.href).toBe("/api/v3/principals/7");
    expect(links.roles).toEqual([{ href: "/api/v3/roles/3" }]);
  });

  test("a missing principal name exits 1 suggesting close names", async () => {
    const root = await makeTempRoom("member-add-missing-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMemberApi({ gets: baseGets() });
    const result = await runProject(configDir, cacheDir, [
      "member",
      "add",
      "demo-site",
      "Linh Nguyem",
      "Member",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("principal");
    expect(result.stderr).toContain("Linh Nguyen");
  });

  test("an ambiguous principal name exits 1 naming both ids", async () => {
    const root = await makeTempRoom("member-add-ambiguous-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMemberApi({
      gets: {
        ...baseGets(),
        [PRINCIPALS_PAGE]: halCollection(2, [
          principalElement(7, "Same Name"),
          principalElement(9, "Same Name"),
        ]),
      },
    });
    const result = await runProject(configDir, cacheDir, [
      "member",
      "add",
      "demo-site",
      "Same Name",
      "Member",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ambiguous");
    expect(result.stderr).toContain("7");
    expect(result.stderr).toContain("9");
  });

  test("a missing role exits 1 and sends nothing", async () => {
    const root = await makeTempRoom("member-add-badrole-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMemberApi({ gets: baseGets() });
    const result = await runProject(configDir, cacheDir, [
      "member",
      "add",
      "demo-site",
      "Linh Nguyen",
      "Managr",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("role");
    expect(result.stderr).toContain("Manager");
  });

  test("--json renders the created membership as one flat record", async () => {
    const root = await makeTempRoom("member-add-json-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMemberApi({
      gets: baseGets(),
      posts: [
        { path: "/api/v3/memberships", status: 201, body: membershipElement(81) },
      ],
    });
    const result = await runProject(configDir, cacheDir, [
      "member",
      "add",
      "demo-site",
      "Linh Nguyen",
      "Manager",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed["id"]).toBe(81);
  });
});

describe("project member remove", () => {
  test("finds the membership and deletes it", async () => {
    const root = await makeTempRoom("member-remove-ok-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const { writes } = installMemberApi({
      gets: {
        ...baseGets(),
        [membershipsPath(21, 7)]: halCollection(1, [membershipElement(77)]),
      },
      deletes: [{ path: "/api/v3/memberships/77" }],
    });
    const result = await runProject(configDir, cacheDir, [
      "member",
      "remove",
      "demo-site",
      "Linh Nguyen",
    ]);
    expect(result.exitCode).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe("/api/v3/memberships/77");
    expect(writes[0]?.method).toBe("DELETE");
    expect(result.stdout).toContain("77");
  });

  test("a non-member exits 4 without sending a delete", async () => {
    const root = await makeTempRoom("member-remove-none-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMemberApi({
      gets: {
        ...baseGets(),
        [membershipsPath(21, 7)]: halCollection(0, []),
      },
    });
    const result = await runProject(configDir, cacheDir, [
      "member",
      "remove",
      "demo-site",
      "Linh Nguyen",
    ]);
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("not a member");
  });
});
