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

const INSTANCE_URL = "https://openproject.example";
const USER = { id: 1, name: "Ada", login: "ada" };
const EMPTY_COLLECTION = {
  _type: "Collection",
  total: 0,
  count: 0,
  _embedded: { elements: [] },
};

interface Reply {
  readonly status: number;
  readonly body?: unknown;
}

interface StubOptions {
  readonly root?: Reply | "unreachable";
  readonly me?: Reply;
  readonly projects?: Reply;
}

async function makeRoom(withCredentials: boolean): Promise<{
  configDir: string;
  cacheDir: string;
  env: Record<string, string>;
}> {
  const root = await mkdtemp(join(tmpdir(), "op-cli-doctor-"));
  cleanups.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const configDir = join(root, "config");
  const cacheDir = join(root, "cache");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      default_profile: "default",
      active_profile: "default",
      profiles: { default: { url: INSTANCE_URL } },
    }),
  );
  if (withCredentials) {
    await writeFile(
      join(configDir, "credentials.json"),
      JSON.stringify({ default: { api_key: "secret-key" } }),
      { mode: 0o600 },
    );
  }
  return { configDir, cacheDir, env: { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir } };
}

function stubInstance(mockAgent: MockAgent, options: StubOptions): void {
  const pool = mockAgent.get(INSTANCE_URL);
  const root = options.root ?? {
    status: 200,
    body: { _type: "Root", apiVersion: "3", coreVersion: "13.2" },
  };
  if (root === "unreachable") {
    pool
      .intercept({ path: "/api/v3/", method: "GET" })
      .replyWithError(new Error("connect ECONNREFUSED"));
  } else {
    pool.intercept({ path: "/api/v3/", method: "GET" }).reply(root.status, root.body ?? {});
  }
  const me = options.me ?? { status: 200, body: USER };
  pool.intercept({ path: "/api/v3/users/me", method: "GET" }).reply(me.status, me.body ?? {});
  const projects = options.projects ?? { status: 200, body: EMPTY_COLLECTION };
  pool
    .intercept({ path: "/api/v3/projects?pageSize=1", method: "GET" })
    .reply(projects.status, projects.body ?? {});
}

describe("op-cli doctor", () => {
  test("reports each check separately and exits zero on a healthy instance", async () => {
    const room = await makeRoom(true);
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    stubInstance(mockAgent, {});
    try {
      const result = await run(["doctor"], room.env, {});
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("connectivity");
      expect(result.stdout).toContain("pass");
      expect(result.stdout).toContain(USER.login);
      expect(result.stdout).toContain("permissions");
      expect(result.stdout).toContain("versions");
      expect(result.stdout).toContain("13.2");
      expect(result.stderr).toBe("");
    } finally {
      await mockAgent.close();
      setGlobalDispatcher(new Agent());
    }
  });

  test("doctor --json emits one JSON object with every check result", async () => {
    const room = await makeRoom(true);
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    stubInstance(mockAgent, {});
    try {
      const result = await run(["doctor", "--json"], room.env, {});
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout) as {
        ok: boolean;
        checks: Array<{ check: string; status: string; detail: string }>;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.checks.map((check) => check.check)).toEqual([
        "connectivity",
        "credentials",
        "permissions",
        "versions",
      ]);
      for (const check of parsed.checks) {
        expect(check.status).toBe("pass");
      }
    } finally {
      await mockAgent.close();
      setGlobalDispatcher(new Agent());
    }
  });

  test("an unreachable instance maps to the network exit code", async () => {
    const room = await makeRoom(true);
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    stubInstance(mockAgent, { root: "unreachable" });
    try {
      const result = await run(["doctor"], room.env, {});
      expect(result.exitCode).toBe(6);
      expect(result.stderr).toMatch(/^\[NETWORK_ERROR\]/);
      expect(result.stdout).toContain("skipped");
      expect(result.stdout).toContain("connectivity");
      expect(result.stdout).toContain("fail");
    } finally {
      await mockAgent.close();
      setGlobalDispatcher(new Agent());
    }
  });

  test("bad credentials map to the auth exit code while earlier checks stay visible", async () => {
    const room = await makeRoom(true);
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    stubInstance(mockAgent, { me: { status: 401, body: { _type: "Error" } } });
    try {
      const result = await run(["doctor"], room.env, {});
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toMatch(/^\[AUTH_FAILED\]/);
      expect(result.stdout).toContain("connectivity");
      expect(result.stdout).toContain("fail");
    } finally {
      await mockAgent.close();
      setGlobalDispatcher(new Agent());
    }
  });

  test("an unsupported instance API version carries its own catalogue code", async () => {
    const room = await makeRoom(true);
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    stubInstance(mockAgent, {
      root: { status: 200, body: { _type: "Root", apiVersion: "2", coreVersion: "11.3" } },
    });
    try {
      const result = await run(["doctor"], room.env, {});
      expect(result.exitCode).toBe(7);
      expect(result.stderr).toMatch(/^\[UNSUPPORTED_VERSION\]/);
      expect(result.stdout).toContain("versions");
      expect(result.stdout).toContain("fail");
    } finally {
      await mockAgent.close();
      setGlobalDispatcher(new Agent());
    }
  });

  test("a core version below v13 warns without failing outright", async () => {
    const room = await makeRoom(true);
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    stubInstance(mockAgent, {
      root: { status: 200, body: { _type: "Root", apiVersion: "3", coreVersion: "12.5" } },
    });
    try {
      const result = await run(["doctor"], room.env, {});
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("warn");
      expect(result.stdout).toContain("12.5");
      expect(result.stderr).toBe("");
    } finally {
      await mockAgent.close();
      setGlobalDispatcher(new Agent());
    }
  });

  test("a stock instance without version metadata still passes the version check", async () => {
    const room = await makeRoom(true);
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    stubInstance(mockAgent, {
      root: { status: 200, body: { _type: "Root" } },
    });
    try {
      const result = await run(["doctor"], room.env, {});
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("versions");
      expect(result.stderr).toBe("");
    } finally {
      await mockAgent.close();
      setGlobalDispatcher(new Agent());
    }
  });

  test("a core-only root explains that the api version was not reported", async () => {
    const room = await makeRoom(true);
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    stubInstance(mockAgent, {
      root: { status: 200, body: { _type: "Root", coreVersion: "17.7.0" } },
    });
    try {
      const result = await run(["doctor"], room.env, {});
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("core 17.7.0");
      expect(result.stdout).toContain("api version not reported");
      expect(result.stdout).not.toContain("api unknown");
      expect(result.stderr).toBe("");
    } finally {
      await mockAgent.close();
      setGlobalDispatcher(new Agent());
    }
  });
  test("doctor without any configured profile reports the missing profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-doctor-empty-"));
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const result = await run(
      ["doctor"],
      { OP_CLI_CONFIG_DIR: join(root, "config"), OP_CLI_CACHE_DIR: join(root, "cache") },
      {},
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^\[PROFILE_NOT_FOUND\]/);
  });

  test("doctor --profile diagnoses the named profile instead of the active one", async () => {
    const room = await makeRoom(true);
    await writeFile(
      join(room.configDir, "config.json"),
      JSON.stringify({
        default_profile: "default",
        active_profile: "default",
        profiles: {
          default: { url: "https://default.example" },
          other: { url: INSTANCE_URL },
        },
      }),
    );
    await writeFile(
      join(room.configDir, "credentials.json"),
      JSON.stringify({
        default: { api_key: "secret-key" },
        other: { api_key: "other-key" },
      }),
      { mode: 0o600 },
    );
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    stubInstance(mockAgent, {});
    try {
      const result = await run(["doctor", "--profile", "other"], room.env, {});
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(INSTANCE_URL);
      expect(result.stdout).not.toContain("https://default.example");
    } finally {
      await mockAgent.close();
      setGlobalDispatcher(new Agent());
    }
  });

  test("a permissions failure maps to the auth exit code", async () => {
    const room = await makeRoom(true);
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    stubInstance(mockAgent, { projects: { status: 403, body: { _type: "Error" } } });
    try {
      const result = await run(["doctor"], room.env, {});
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toMatch(/^\[AUTH_FAILED\]/);
      expect(result.stdout).toContain("permissions");
      expect(result.stdout).toContain("fail");
    } finally {
      await mockAgent.close();
      setGlobalDispatcher(new Agent());
    }
  });

  test("doctor --json on failure emits checks JSON and a catalogued JSON error", async () => {
    const room = await makeRoom(true);
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    stubInstance(mockAgent, {
      root: { status: 200, body: { _type: "Root", apiVersion: "2" } },
    });
    try {
      const result = await run(["doctor", "--json"], room.env, {});
      expect(result.exitCode).toBe(7);
      const parsed = JSON.parse(result.stdout) as {
        ok: boolean;
        checks: Array<{ check: string; status: string }>;
      };
      expect(parsed.ok).toBe(false);
      const versions = parsed.checks.find((check) => check.check === "versions");
      expect(versions?.status).toBe("fail");
      const renderedError = JSON.parse(result.stderr) as {
        error: { code: string };
      };
      expect(renderedError.error.code).toBe("UNSUPPORTED_VERSION");
    } finally {
      await mockAgent.close();
      setGlobalDispatcher(new Agent());
    }
  });
});

describe("op-cli --version", () => {
  test("prints the CLI version without configuration or credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-version-"));
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const result = await run(
      ["--version"],
      { OP_CLI_CONFIG_DIR: join(root, "config"), OP_CLI_CACHE_DIR: join(root, "cache") },
      {},
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^op-cli \d+\.\d+\.\d+\n$/);
    expect(result.stderr).toBe("");
  });

  test("appends the stored instance version without needing credentials", async () => {
    const room = await makeRoom(false);
    await mkdir(join(room.cacheDir, "default"), { recursive: true });
    await writeFile(
      join(room.cacheDir, "default", "metadata.json"),
      JSON.stringify({
        instance: {
          url: INSTANCE_URL,
          api_version: "3",
          core_version: "13.2",
          fetched_at: "2026-08-23T00:00:00.000Z",
        },
      }),
    );
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    try {
      const result = await run(["--version"], room.env, {});
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/^op-cli \d+\.\d+\.\d+\n/);
      expect(result.stdout).toContain(INSTANCE_URL);
      expect(result.stdout).toContain("13.2");
      expect(result.stderr).toBe("");
      mockAgent.assertNoPendingInterceptors();
    } finally {
      await mockAgent.close();
      setGlobalDispatcher(new Agent());
    }
  });
});
