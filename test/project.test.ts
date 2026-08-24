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

interface RecordedWrite {
  readonly path: string;
  readonly method: string;
  readonly body: string;
}

/**
 * Installs exactly the endpoints listed. Any other request fails the whole
 * agent (net connect disabled), so a green run proves no extra HTTP traffic,
 * including no metadata prefetch behind the scenes.
 */
function installMockApi(options: {
  readonly gets?: Record<string, unknown>;
  readonly writes?: ReadonlyArray<{
    readonly path: string;
    readonly method: "POST" | "PATCH" | "DELETE";
    readonly status: number;
    readonly body?: unknown;
  }>;
}): { writes: Array<RecordedWrite> } {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  cleanups.push(async () => {
    await mockAgent.close();
    setGlobalDispatcher(new Agent());
  });
  const recorded: Array<RecordedWrite> = [];
  const pool = mockAgent.get(INSTANCE);
  for (const [path, body] of Object.entries(options.gets ?? {})) {
    pool.intercept({ path, method: "GET" }).reply(200, body).persist();
  }
  for (const write of options.writes ?? []) {
    pool
      .intercept({ path: write.path, method: write.method })
      .reply((call) => {
        recorded.push({
          path: write.path,
          method: write.method,
          body: String(call.body ?? ""),
        });
        return { statusCode: write.status, data: write.body ?? "" };
      })
      .persist();
  }
  return { writes: recorded };
}

/** A mock room where EVERY request fails; used to prove zero traffic. */
function installNoTrafficApi(): void {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  cleanups.push(async () => {
    await mockAgent.close();
    setGlobalDispatcher(new Agent());
  });
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
    description: { format: "markdown", raw: `${name} description.` },
    createdAt: "2026-08-01T09:15:00Z",
    updatedAt: "2026-08-20T14:02:11Z",
    favorited: false,
    _links: {
      self: { href: `/api/v3/projects/${String(id)}` },
      ...(id === 13 ? {} : { parent: { href: "/api/v3/projects/13", title: "Operations" } }),
    },
  };
}

const PROJECTS_PAGE = "/api/v3/projects?pageSize=100";

const ALL_PROJECTS = [
  projectElement(13, "operations", "Operations"),
  projectElement(21, "demo-site", "Demo Site"),
];


function listPath(filters: unknown, pageSize: number): string {
  // Same clause order the command builds: active, favorited, parent_id,
  // name_and_identifier.
  return (
    `/api/v3/projects?filters=${encodeURIComponent(JSON.stringify(filters))}` +
    `&pageSize=${String(pageSize)}`
  );
}

async function runProject(
  configDir: string,
  cacheDir: string,
  args: ReadonlyArray<string>,
  io: Record<string, unknown> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return run(
    ["project", ...args],
    { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
    io,
  );
}

describe("project group registration", () => {
  test("the group exposes every command of ticket #12", async () => {
    const root = await makeTempRoom("project-help-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installNoTrafficApi();
    const result = await runProject(configDir, cacheDir, ["--help"]);
    expect(result.exitCode).toBe(0);
    for (const name of [
      "list",
      "get",
      "create",
      "update",
      "copy",
      "star",
      "unstar",
      "versions",
      "categories",
      "types",
      "delete",
    ]) {
      expect(result.stdout).toContain(name);
    }
  });
});

describe("project get", () => {
  test("resolves an id directly", async () => {
    const root = await makeTempRoom("project-get-id-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({ gets: { "/api/v3/projects/21": projectElement(21, "demo-site", "Demo Site") } });
    const result = await runProject(configDir, cacheDir, ["get", "21"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Demo Site");
    expect(result.stdout).toContain("demo-site");
  });

  test.each([
    ["an identifier", "demo-site"],
    ["a name", "Demo Site"],
  ])("resolves %s through the collection", async (_label, reference) => {
    const root = await makeTempRoom(`project-get-ref-${reference}-`);
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      gets: {
        [PROJECTS_PAGE]: halCollection(2, ALL_PROJECTS),
        "/api/v3/projects/21": projectElement(21, "demo-site", "Demo Site"),
      },
    });
    const result = await runProject(configDir, cacheDir, ["get", reference]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Demo Site");
  });

  test("a value matching two projects by different keys exits 1 instead of guessing", async () => {
    const root = await makeTempRoom("project-get-ambiguous-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      gets: {
        [PROJECTS_PAGE]: halCollection(2, [
          projectElement(13, "shared-key", "Operations"),
          projectElement(21, "demo-site", "shared-key"),
        ]),
      },
    });
    const result = await runProject(configDir, cacheDir, ["get", "shared-key"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ambiguous");
    expect(result.stderr).toContain("13");
    expect(result.stderr).toContain("21");
  });

  test("a missing project exits 4 suggesting close names", async () => {
    const root = await makeTempRoom("project-get-missing-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      gets: { [PROJECTS_PAGE]: halCollection(2, ALL_PROJECTS) },
    });
    const result = await runProject(configDir, cacheDir, ["get", "Demo Sit"]);
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("Demo Site");
  });

  test("--json emits one flat record", async () => {
    const root = await makeTempRoom("project-get-json-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({ gets: { "/api/v3/projects/21": projectElement(21, "demo-site", "Demo Site") } });
    const result = await runProject(configDir, cacheDir, ["get", "21", "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed["id"]).toBe(21);
    expect(parsed["identifier"]).toBe("demo-site");
  });
});

describe("project list", () => {
  test("lists projects with no truncation notice on a complete page", async () => {
    const root = await makeTempRoom("project-list-basic-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      gets: { [PROJECTS_PAGE]: halCollection(2, ALL_PROJECTS) },
    });
    const result = await runProject(configDir, cacheDir, ["list"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Operations");
    expect(result.stdout).toContain("demo-site");
    expect(result.stderr).toBe("");
  });

  test("warns on stderr and stays exit 0 when the page was cut", async () => {
    const root = await makeTempRoom("project-list-trunc-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      gets: { [PROJECTS_PAGE]: halCollection(9, [ALL_PROJECTS[0]]) },
    });
    const result = await runProject(configDir, cacheDir, ["list"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Showing 1 of 9 projects");
    expect(result.stderr).toContain("--all");
  });

  test("--limit narrows the requested pageSize", async () => {
    const root = await makeTempRoom("project-list-limit-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      gets: {
        "/api/v3/projects?pageSize=25": halCollection(0, []),
      },
    });
    const result = await runProject(configDir, cacheDir, ["list", "--limit", "25"]);
    expect(result.exitCode).toBe(0);
  });

  test("--all walks every page", async () => {
    const root = await makeTempRoom("project-list-all-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      gets: {
        [PROJECTS_PAGE]: halCollection(3, [ALL_PROJECTS[0]], "/api/v3/projects?offset=2&pageSize=100"),
        "/api/v3/projects?offset=2&pageSize=100": halCollection(
          3,
          [ALL_PROJECTS[1], projectElement(30, "infra", "Infrastructure")],
        ),
      },
    });
    const result = await runProject(configDir, cacheDir, ["list", "--all"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Operations");
    expect(result.stdout).toContain("Infrastructure");
    expect(result.stderr).toBe("");
  });

  test("documented filters reach the API as one filters query", async () => {
    const root = await makeTempRoom("project-list-filters-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      gets: {
        [listPath(
          [
            { active: { operator: "=", values: ["t"] } },
            { favorited: { operator: "=", values: ["t"] } },
            { parent_id: { operator: "=", values: ["13"] } },
            { name_and_identifier: { operator: "~", values: ["demo"] } },
          ],
          100,
        )]: halCollection(0, []),
      },
    });
    const result = await runProject(configDir, cacheDir, [
      "list",
      "--active",
      "--favorite",
      "--parent",
      "13",
      "--search",
      "demo",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("--archived maps to active=false and rejects --active together with it", async () => {
    const root = await makeTempRoom("project-list-archived-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      gets: { [listPath([{ active: { operator: "=", values: ["f"] } }], 100)]: halCollection(0, []) },
    });
    const ok = await runProject(configDir, cacheDir, ["list", "--archived"]);
    expect(ok.exitCode).toBe(0);
    const bad = await runProject(configDir, cacheDir, ["list", "--active", "--archived"]);
    expect(bad.exitCode).toBe(1);
  });

  test("--json emits one flat JSON array", async () => {
    const root = await makeTempRoom("project-list-json-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      gets: { [PROJECTS_PAGE]: halCollection(2, ALL_PROJECTS) },
    });
    const result = await runProject(configDir, cacheDir, ["list", "--json"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.["identifier"]).toBe("operations");
  });
});

describe("project create", () => {
  test("posts name, identifier, and optional attributes, then renders the record", async () => {
    const root = await makeTempRoom("project-create-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const api = installMockApi({
      gets: { [PROJECTS_PAGE]: halCollection(2, ALL_PROJECTS) },
      writes: [
        {
          path: "/api/v3/projects",
          method: "POST",
          status: 201,
          body: projectElement(40, "new-project", "New Project"),
        },
      ],
    });
    const result = await runProject(configDir, cacheDir, [
      "create",
      "New Project",
      "--identifier",
      "new-project",
      "--description",
      "Fresh workspace.",
      "--public",
      "--parent",
      "Operations",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("New Project");
    expect(api.writes).toHaveLength(1);
    const sent = JSON.parse(api.writes[0]?.body ?? "{}") as Record<string, unknown>;
    expect(sent["name"]).toBe("New Project");
    expect(sent["identifier"]).toBe("new-project");
    expect(sent["public"]).toBe(true);
    const links = sent["_links"] as Record<string, { href: string }>;
    expect(links["parent"]?.href).toBe("/api/v3/projects/13");
  });

  test("a rejected create points at the values, not at waiting", async () => {
    const root = await makeTempRoom("project-create-rejected-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      writes: [
        {
          path: "/api/v3/projects",
          method: "POST",
          status: 422,
          body: { _type: "Error", message: "Identifier has already been taken." },
        },
      ],
    });
    const result = await runProject(configDir, cacheDir, [
      "create",
      "dup",
      "--identifier",
      "op-cli-qa-0824",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      "[API_ERROR] OpenProject rejected the create: Identifier has already been taken.",
    );
    // Waiting cannot help a refused write; only different values can.
    expect(result.stderr).not.toContain("try again later");
    expect(result.stderr).toContain("Hint: fix the rejected values and repeat the command.");
  });

  test("a rate-limited create is the one refusal that waiting repairs", async () => {
    const root = await makeTempRoom("project-create-throttled-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      writes: [
        {
          path: "/api/v3/projects",
          method: "POST",
          status: 429,
          body: { _type: "Error", message: "Too many requests." },
        },
      ],
    });
    const result = await runProject(configDir, cacheDir, [
      "create",
      "dup",
      "--identifier",
      "op-cli-qa-0825",
    ]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Too many requests.");
    expect(result.stderr).toContain("Hint: try again later.");
  });

  test("without --identifier exits 1 before any request", async () => {
    const root = await makeTempRoom("project-create-noid-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installNoTrafficApi();
    const result = await runProject(configDir, cacheDir, ["create", "New Project"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("identifier");
  });
});

describe("project update", () => {
  test("patches the resolved project and renders the updated record", async () => {
    const root = await makeTempRoom("project-update-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const api = installMockApi({
      gets: {
        [PROJECTS_PAGE]: halCollection(2, ALL_PROJECTS),
        "/api/v3/projects/21": projectElement(21, "demo-site", "Demo Site"),
      },
      writes: [
        {
          path: "/api/v3/projects/21",
          method: "PATCH",
          status: 200,
          body: projectElement(21, "demo-site", "Demo Site Renamed"),
        },
      ],
    });
    const result = await runProject(configDir, cacheDir, [
      "update",
      "demo-site",
      "--name",
      "Demo Site Renamed",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Demo Site Renamed");
    const sent = JSON.parse(api.writes[0]?.body ?? "{}") as Record<string, unknown>;
    expect(sent["name"]).toBe("Demo Site Renamed");
  });

  test("without any change exits 1 before any request", async () => {
    const root = await makeTempRoom("project-update-empty-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installNoTrafficApi();
    const result = await runProject(configDir, cacheDir, ["update", "21"]);
    expect(result.exitCode).toBe(1);
  });
});

describe("project copy", () => {
  test("reads the source and creates a new project carrying its attributes", async () => {
    const root = await makeTempRoom("project-copy-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const api = installMockApi({
      gets: {
        [PROJECTS_PAGE]: halCollection(2, ALL_PROJECTS),
        "/api/v3/projects/21": projectElement(21, "demo-site", "Demo Site"),
      },
      writes: [
        {
          path: "/api/v3/projects",
          method: "POST",
          status: 201,
          body: projectElement(41, "demo-copy", "Demo Copy"),
        },
      ],
    });
    const result = await runProject(configDir, cacheDir, [
      "copy",
      "Demo Site",
      "Demo Copy",
      "--identifier",
      "demo-copy",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Demo Copy");
    expect(api.writes).toHaveLength(1);
    const sent = JSON.parse(api.writes[0]?.body ?? "{}") as Record<string, unknown>;
    expect(sent["name"]).toBe("Demo Copy");
    expect(sent["identifier"]).toBe("demo-copy");
    const links = sent["_links"] as Record<string, { href: string }>;
    expect(links["parent"]?.href).toBe("/api/v3/projects/13");
  });

  test("without --identifier exits 1 before any request", async () => {
    const root = await makeTempRoom("project-copy-noid-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installNoTrafficApi();
    const result = await runProject(configDir, cacheDir, ["copy", "21", "Another Name"]);
    expect(result.exitCode).toBe(1);
  });
});

describe("project star and unstar", () => {
  test("star resolves the project then POSTs favorite", async () => {
    const root = await makeTempRoom("project-star-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const api = installMockApi({
      gets: {
        [PROJECTS_PAGE]: halCollection(2, ALL_PROJECTS),
        "/api/v3/projects/21": projectElement(21, "demo-site", "Demo Site"),
      },
      writes: [{ path: "/api/v3/projects/21/favorite", method: "POST", status: 204 }],
    });
    const result = await runProject(configDir, cacheDir, ["star", "demo-site"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Demo Site");
    expect(api.writes[0]?.method).toBe("POST");
    expect(api.writes[0]?.path).toBe("/api/v3/projects/21/favorite");
  });

  test("unstar DELETEs the favorite mark", async () => {
    const root = await makeTempRoom("project-unstar-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const api = installMockApi({
      gets: { "/api/v3/projects/21": projectElement(21, "demo-site", "Demo Site") },
      writes: [{ path: "/api/v3/projects/21/favorite", method: "DELETE", status: 204 }],
    });
    const result = await runProject(configDir, cacheDir, ["unstar", "21"]);
    expect(result.exitCode).toBe(0);
    expect(api.writes[0]?.method).toBe("DELETE");
    expect(result.stdout).toContain("Unstarred");
  });
});

describe("project vocabulary listings", () => {
  test("versions lists id, name, and status of the project's versions", async () => {
    const root = await makeTempRoom("project-versions-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      gets: {
        [PROJECTS_PAGE]: halCollection(2, ALL_PROJECTS),
        "/api/v3/projects/21": projectElement(21, "demo-site", "Demo Site"),
        "/api/v3/projects/21/versions?pageSize=100": halCollection(1, [
          { _type: "Version", id: 5, name: "0.1.0", status: "open" },
        ]),
      },
    });
    const result = await runProject(configDir, cacheDir, ["versions", "demo-site"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("0.1.0");
    expect(result.stdout).toContain("open");
  });

  test("categories supports --json and --fields", async () => {
    const root = await makeTempRoom("project-categories-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      gets: {
        [PROJECTS_PAGE]: halCollection(2, ALL_PROJECTS),
        "/api/v3/projects/21": projectElement(21, "demo-site", "Demo Site"),
        "/api/v3/projects/21/categories?pageSize=100": halCollection(2, [
          { _type: "Category", id: 3, name: "Backend" },
          { _type: "Category", id: 4, name: "Frontend" },
        ]),
      },
    });
    const result = await runProject(configDir, cacheDir, [
      "categories",
      "demo-site",
      "--json",
      "--fields",
      "name",
    ]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as Array<Record<string, unknown>>;
    expect(parsed).toEqual([{ name: "Backend" }, { name: "Frontend" }]);
  });

  test("types lists the work package types usable in the project", async () => {
    const root = await makeTempRoom("project-types-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      gets: {
        [PROJECTS_PAGE]: halCollection(2, ALL_PROJECTS),
        "/api/v3/projects/21": projectElement(21, "demo-site", "Demo Site"),
        "/api/v3/projects/21/types?pageSize=100": halCollection(2, [
          { _type: "Type", id: 2, name: "Task", isMilestone: false },
          { _type: "Type", id: 7, name: "Milestone", isMilestone: true },
        ]),
      },
    });
    const result = await runProject(configDir, cacheDir, ["types", "demo-site"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Milestone");
    expect(result.stdout).toContain("Task");
  });
});
describe("project delete", () => {
  test("without --yes exits 1 and sends nothing, with or without a TTY", async () => {
    const root = await makeTempRoom("project-delete-guard-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installNoTrafficApi();
    for (const io of [{}, { isTTY: true }]) {
      const result = await runProject(configDir, cacheDir, ["delete", "demo-site"], io);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("[USAGE_ERROR]");
      expect(result.stderr).toContain("--yes");
    }
  });

  test("with --yes resolves the reference and sends exactly one DELETE", async () => {
    const root = await makeTempRoom("project-delete-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const api = installMockApi({
      gets: {
        [PROJECTS_PAGE]: halCollection(2, ALL_PROJECTS),
      },
      writes: [{ path: "/api/v3/projects/21", method: "DELETE", status: 204 }],
    });
    const result = await runProject(configDir, cacheDir, ["delete", "demo-site", "--yes"]);
    expect(result.exitCode).toBe(0);
    expect(api.writes).toEqual([
      { path: "/api/v3/projects/21", method: "DELETE", body: "" },
    ]);
    expect(result.stdout).toContain("Deleted project Demo Site (21).");
  });

  test("a missing project exits 4 without deleting anything", async () => {
    const root = await makeTempRoom("project-delete-missing-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installMockApi({
      gets: {
        [PROJECTS_PAGE]: halCollection(2, ALL_PROJECTS),
      },
      writes: [],
    });
    const result = await runProject(configDir, cacheDir, ["delete", "no-such-project", "--yes"]);
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("[NOT_FOUND]");
  });
});
