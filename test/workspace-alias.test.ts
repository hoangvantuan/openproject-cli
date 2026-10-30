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

const NOT_FOUND = {
  _type: "Error",
  errorIdentifier: "urn:openproject-org:api:v3:errors:NotFound",
  message: "not found",
};

interface Outcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Every request the run made, "METHOD path body" in order. */
  readonly requests: ReadonlyArray<string>;
}

function collection(elements: unknown[]): Record<string, unknown> {
  return {
    _type: "Collection",
    total: elements.length,
    count: elements.length,
    _embedded: { elements },
    _links: { self: { href: "/self" } },
  };
}

function scopedListing(projectId: string): string {
  return `/api/v3/work_packages?filters=${encodeURIComponent(
    JSON.stringify([{ project: { operator: "=", values: [projectId] } }]),
  )}&pageSize=100`;
}

const WP_BODY = {
  _type: "WorkPackage",
  id: 675,
  lockVersion: 1,
  subject: "Scratch item",
  createdAt: "2026-08-01T09:15:00Z",
  updatedAt: "2026-08-20T14:02:11Z",
  _links: {
    self: { href: "/api/v3/work_packages/675" },
    project: { href: "/api/v3/projects/13", title: "Operations" },
    type: { href: "/api/v3/types/2", title: "Task" },
    status: { href: "/api/v3/statuses/1", title: "In progress" },
  },
};

const GETS: Record<string, unknown> = {
  [scopedListing("13")]: collection([WP_BODY]),
  [scopedListing("13").replace("pageSize=100", "pageSize=1")]: collection([WP_BODY]),
  [`/api/v3/time_entries?filters=${encodeURIComponent(
    JSON.stringify([{ project: { operator: "=", values: ["13"] } }]),
  )}&pageSize=100`]: collection([]),
  "/api/v3/work_packages/675": WP_BODY,
  "/api/v3/projects/13": {
    _type: "Project",
    id: 13,
    identifier: "operations",
    name: "Operations",
    _links: {},
  },
  "/api/v3/projects?pageSize=100": collection([
    { _type: "Project", id: 13, identifier: "operations", name: "Operations" },
  ]),
};

/**
 * One command in its own room (config, cache seeded with a stored project
 * vocabulary) against a recording fake: unknown paths answer 404, so two
 * spellings of one command can be compared request for request.
 */
async function invoke(args: ReadonlyArray<string>): Promise<Outcome> {
  const root = await mkdtemp(join(tmpdir(), "workspace-alias-"));
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
      profiles: { default: { url: INSTANCE } },
    }),
  );
  await writeFile(
    join(configDir, "credentials.json"),
    JSON.stringify({ default: { api_key: "secret-key" } }),
    { mode: 0o600 },
  );
  await writeFile(
    join(cacheDir, "default", "metadata.json"),
    JSON.stringify({ ...baseMetadata(), projectScoped: { "13": { ...projectVocabulary({}), sprints: [], buckets: [] } } }),
  );
  const requests: Array<string> = [];
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  cleanups.push(async () => {
    await mockAgent.close();
    setGlobalDispatcher(new Agent());
  });
  mockAgent
    .get(INSTANCE)
    .intercept({ path: () => true, method: /.*/ })
    .reply((options) => {
      const body = typeof options.body === "string" ? options.body : "";
      requests.push(`${String(options.method)} ${options.path} ${body}`.trimEnd());
      const found = GETS[options.path];
      return found === undefined || options.method !== "GET"
        ? { statusCode: 404, data: NOT_FOUND }
        : { statusCode: 200, data: found };
    })
    .persist();
  const result = await run(
    args,
    { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
    {},
  );
  return { ...result, requests };
}

const REPRESENTATIVE: ReadonlyArray<ReadonlyArray<string>> = [
  ["wp", "list"],
  ["wp", "count"],
  ["wp", "create", "Scratch", "--type", "Task"],
  ["wp", "update", "675", "--subject", "y"],
  ["time", "list"],
  ["time", "log", "675", "--hours", "1", "--activity", "Development"],
  ["project", "get", "13"],
];

/** The commands whose writes the fake refuses (404), so they cannot succeed. */
const WRITES = new Set(["wp create", "wp update", "time log"]);

describe("--workspace is an alias of --project (#57)", () => {
  test.each(REPRESENTATIVE.map((args) => [args.join(" "), args] as const))(
    "%s: --workspace 13 makes the same requests and output as --project 13",
    async (_label, args) => {
      const viaProject = await invoke([...args, "--project", "13"]);
      const viaWorkspace = await invoke([...args, "--workspace", "13"]);
      expect(viaWorkspace).toEqual(viaProject);
      // The comparison must not pass because both refused the flag.
      expect(viaWorkspace.stderr).not.toContain("unknown option");
      if (!WRITES.has(args.slice(0, 2).join(" "))) {
        expect(viaWorkspace.exitCode).toBe(0);
        // ...nor because the alias was ignored: project 13 shows in the traffic.
        expect(viaWorkspace.requests.join("\n")).toContain("13");
      }
    },
  );

  test("every meta subcommand that takes --project takes --workspace the same way", async () => {
    const taking: Array<string> = [];
    for (const path of await commandPaths("meta")) {
      const help = await invoke(["meta", ...path, "--help"]);
      if (help.stdout.includes("--project")) {
        taking.push(path.join(" "));
      }
    }
    expect(taking.length).toBeGreaterThan(5);
    for (const name of taking) {
      const viaProject = await invoke(["meta", name, "--project", "13"]);
      const viaWorkspace = await invoke(["meta", name, "--workspace", "13"]);
      expect(viaWorkspace, name).toEqual(viaProject);
      expect(viaWorkspace.exitCode, name).toBe(0);
      expect(viaWorkspace.requests, name).toEqual([]);
    }
  });

  test("--workspace resolves a name exactly like --project", async () => {
    const viaWorkspace = await invoke(["wp", "list", "--workspace", "Operations"]);
    expect(viaWorkspace.exitCode).toBe(0);
    expect(viaWorkspace.requests).toContain(`GET ${scopedListing("13")}`);
  });

  test("the same value on both flags is fine", async () => {
    const both = await invoke(["wp", "list", "--project", "13", "--workspace", "13"]);
    const one = await invoke(["wp", "list", "--project", "13"]);
    expect(both).toEqual(one);
    expect(both.exitCode).toBe(0);
  });

  test("different values are a USAGE_ERROR before any traffic", async () => {
    const result = await invoke(["wp", "list", "--project", "13", "--workspace", "14"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[USAGE_ERROR]");
    expect(result.stderr).toContain("--workspace");
    expect(result.requests).toEqual([]);
  });

  test("a conflict under --json is still one parseable error object", async () => {
    const result = await invoke([
      "wp", "list", "--json", "--project", "13", "--workspace", "14",
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe("USAGE_ERROR");
  });

  test("help lists --workspace as an alias of --project", async () => {
    const help = await invoke(["wp", "list", "--help"]);
    expect(help.stdout).toMatch(/--workspace <name-or-id>\s+alias of --project/);
  });
});

/** Every subcommand path under one group, read from its --help. */
async function commandPaths(
  group: string,
  prefix: ReadonlyArray<string> = [],
): Promise<Array<Array<string>>> {
  const help = await invoke([group, ...prefix, "--help"]);
  const listed = help.stdout.split("Commands:\n")[1];
  if (listed === undefined) {
    return [[...prefix]];
  }
  const names = listed
    .split("\n")
    .map((line) => /^ {2}([a-z][a-z-]*)/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined && name !== "help");
  const paths: Array<Array<string>> = [];
  for (const name of names) {
    paths.push(...await commandPaths(group, [...prefix, name]));
  }
  return paths;
}

describe("op-cli workspace is an alias of op-cli project (#57)", () => {
  test("every project subcommand exists under workspace with the same help", async () => {
    const paths = await commandPaths("project");
    expect(paths.length).toBeGreaterThan(5);
    for (const path of paths) {
      const asProject = await invoke(["project", ...path, "--help"]);
      const asWorkspace = await invoke(["workspace", ...path, "--help"]);
      expect(asWorkspace.exitCode).toBe(0);
      expect(asWorkspace.stdout).toBe(
        asProject.stdout.replaceAll("op-cli project", "op-cli workspace"),
      );
    }
  });

  test("workspace --help says it is an alias", async () => {
    const help = await invoke(["workspace", "--help"]);
    expect(help.stdout).toContain("Alias of project");
  });

  test("workspace list makes the same requests and output as project list", async () => {
    const asProject = await invoke(["project", "list", "--json"]);
    const asWorkspace = await invoke(["workspace", "list", "--json"]);
    expect(asWorkspace).toEqual(asProject);
    expect(asWorkspace.requests.length).toBeGreaterThan(0);
  });

  test("workspace get makes the same requests and output as project get", async () => {
    const asProject = await invoke(["project", "get", "13"]);
    const asWorkspace = await invoke(["workspace", "get", "13"]);
    expect(asWorkspace).toEqual(asProject);
    expect(asWorkspace.exitCode).toBe(0);
  });
});
