import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, test } from "vitest";

import { run } from "../src/run.js";

type StoredProfiles = Record<string, { url: string; project?: number }>;

interface FixtureOptions {
  readonly defaultProfile?: string;
  readonly activeProfile?: string;
  readonly credentials?: Record<string, string>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function writeStoredProfiles(
  root: string,
  profiles: StoredProfiles,
  options: FixtureOptions = {},
): Promise<string> {
  const directory = join(root, "config");
  await mkdir(directory, { recursive: true });
  const config: Record<string, unknown> = {
    default_profile: options.defaultProfile ?? Object.keys(profiles)[0],
    profiles,
  };
  if (options.activeProfile !== undefined) {
    config.active_profile = options.activeProfile;
  }
  await writeFile(join(directory, "config.json"), JSON.stringify(config));
  const credentials: Record<string, { api_key: string }> = {};
  for (const [name, apiKey] of Object.entries(options.credentials ?? {})) {
    credentials[name] = { api_key: apiKey };
  }
  await writeFile(
    join(directory, "credentials.json"),
    JSON.stringify(credentials),
    { mode: 0o600 },
  );
  return directory;
}

function installMockAgent(): MockAgent {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  cleanups.push(async () => {
    await mockAgent.close();
    setGlobalDispatcher(new Agent());
  });
  return mockAgent;
}

function mockUser(
  mockAgent: MockAgent,
  origin: string,
  name: string,
  times = 1,
): void {
  mockAgent
    .get(origin)
    .intercept({ path: "/api/v3/users/me", method: "GET" })
    .reply(200, {
      _type: "User",
      id: 7,
      name,
      login: name.toLowerCase().replace(/\s+/g, "-"),
    })
    .times(times);
}

describe("multiple profiles", () => {
  test("auth use selects a profile and status follows the active profile over the default", async ({
    onTestFinished,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-use-"));
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const directory = await writeStoredProfiles(
      root,
      {
        default: { url: "https://op-a.example" },
        work: { url: "https://op-b.example" },
      },
      { credentials: { default: "key-a", work: "key-b" } },
    );
    const mockAgent = installMockAgent();
    mockUser(mockAgent, "https://op-b.example", "Grace Hopper");

    const switched = await run(
      ["auth", "use", "work"],
      { OP_CLI_CONFIG_DIR: directory },
      {},
    );

    expect(switched).toEqual({
      stdout: "Switched to profile work.\n",
      stderr: "",
      exitCode: 0,
    });
    const config = JSON.parse(
      await readFile(join(directory, "config.json"), "utf8"),
    );
    expect(config.active_profile).toBe("work");

    const status = await run(["auth", "status"], { OP_CLI_CONFIG_DIR: directory }, {});

    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("work");
    expect(status.stdout).toContain("https://op-b.example");
    expect(status.stdout).toContain("Grace Hopper");
    mockAgent.assertNoPendingInterceptors();
  });

  test("auth use rejects an unknown profile through the error catalogue", async ({
    onTestFinished,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-use-missing-"));
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const directory = await writeStoredProfiles(
      root,
      { default: { url: "https://op-a.example" } },
      { credentials: { default: "key-a" } },
    );

    const result = await run(
      ["auth", "use", "ghost"],
      { OP_CLI_CONFIG_DIR: directory },
      {},
    );

    expect(result).toEqual({
      stdout: "",
      stderr:
        "[PROFILE_NOT_FOUND] No active profile. Hint: run op-cli auth login.\n",
      exitCode: 1,
    });
    const config = JSON.parse(
      await readFile(join(directory, "config.json"), "utf8"),
    );
    expect(config.active_profile).toBeUndefined();
  });

  test("auth list renders every profile with the active marker", async ({
    onTestFinished,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-list-"));
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const directory = await writeStoredProfiles(
      root,
      {
        default: { url: "https://op-a.example", project: 13 },
        selfhost: { url: "https://op-b.example" },
      },
      { credentials: { default: "key-a" } },
    );

    const result = await run(["auth", "list"], { OP_CLI_CONFIG_DIR: directory }, {});

    expect(result).toEqual({
      stdout:
        "PROFILE   INSTANCE              PROJECT  ACTIVE\n" +
        "default   https://op-a.example  13       *\n" +
        "selfhost  https://op-b.example\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test("auth list emits one JSON object with --json", async ({
    onTestFinished,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-list-json-"));
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const directory = await writeStoredProfiles(
      root,
      {
        default: { url: "https://op-a.example", project: 13 },
        selfhost: { url: "https://op-b.example" },
      },
      { credentials: { default: "key-a" } },
    );

    const result = await run(
      ["auth", "list", "--json"],
      { OP_CLI_CONFIG_DIR: directory },
      {},
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      active: "default",
      profiles: [
        {
          name: "default",
          instance: "https://op-a.example",
          project: 13,
        },
        {
          name: "selfhost",
          instance: "https://op-b.example",
          project: null,
        },
      ],
    });
  });

  test("auth logout removes only the credentials and keeps the selection", async ({
    onTestFinished,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-logout-"));
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const directory = await writeStoredProfiles(
      root,
      {
        default: { url: "https://op-a.example" },
        work: { url: "https://op-b.example" },
      },
      {
        activeProfile: "work",
        credentials: { default: "key-a", work: "key-b" },
      },
    );

    const result = await run(["auth", "logout"], { OP_CLI_CONFIG_DIR: directory }, {});

    expect(result).toEqual({
      stdout: "Logged out of profile work.\n",
      stderr: "",
      exitCode: 0,
    });
    expect(JSON.parse(await readFile(join(directory, "config.json"), "utf8")))
      .toEqual({
        default_profile: "default",
        active_profile: "work",
        profiles: {
          default: { url: "https://op-a.example" },
          work: { url: "https://op-b.example" },
        },
      });
    expect(JSON.parse(
      await readFile(join(directory, "credentials.json"), "utf8"),
    )).toEqual({ default: { api_key: "key-a" } });

    const listing = await run(
      ["auth", "list"],
      { OP_CLI_CONFIG_DIR: directory },
      {},
    );

    expect(listing.stdout).toBe(
      "PROFILE  INSTANCE              PROJECT  ACTIVE\n" +
        "default  https://op-a.example\n" +
        "work     https://op-b.example           *\n",
    );

    const status = await run(
      ["auth", "status"],
      { OP_CLI_CONFIG_DIR: directory },
      {},
    );

    expect(status).toEqual({
      stdout: "",
      stderr:
        "[AUTH_FAILED] Authentication failed. Hint: run op-cli auth login.\n",
      exitCode: 3,
    });
  });

  test("auth logout of an unknown profile exits 1 with a stable code", async ({
    onTestFinished,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-logout-missing-"));
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const directory = await writeStoredProfiles(
      root,
      { default: { url: "https://op-a.example" } },
      { credentials: { default: "key-a" } },
    );

    const result = await run(
      ["auth", "logout", "--profile", "ghost"],
      { OP_CLI_CONFIG_DIR: directory },
      {},
    );

    expect(result).toEqual({
      stdout: "",
      stderr:
        "[PROFILE_NOT_FOUND] No active profile. Hint: run op-cli auth login.\n",
      exitCode: 1,
    });
    expect(JSON.parse(await readFile(join(directory, "config.json"), "utf8")))
      .toEqual({
        default_profile: "default",
        profiles: { default: { url: "https://op-a.example" } },
      });
  });

  test("auth list reports a missing configuration through the error catalogue", async ({
    onTestFinished,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-list-empty-"));
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const result = await run(
      ["auth", "list"],
      { OP_CLI_CONFIG_DIR: join(root, "missing") },
      {},
    );

    expect(result).toEqual({
      stdout: "",
      stderr:
        "[PROFILE_NOT_FOUND] No active profile. Hint: run op-cli auth login.\n",
      exitCode: 1,
    });
  });
});

describe("context precedence", () => {
  test("environment alone drives auth status with no file on disk", async ({
    onTestFinished,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-env-only-"));
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const mockAgent = installMockAgent();
    mockUser(mockAgent, "https://ci.example", "CI User", 2);

    const env = {
      OPENPROJECT_URL: "https://ci.example",
      OPENPROJECT_API_KEY: "ci-key",
    };
    const table = await run(["auth", "status"], env, {});
    const json = await run(["auth", "status", "--json"], env, {});

    expect(table).toEqual({
      stdout:
        "PROFILE  INSTANCE            PROJECT  USER\n" +
        "env      https://ci.example           CI User\n",
      stderr: "",
      exitCode: 0,
    });
    expect(JSON.parse(json.stdout)).toEqual({
      profile: "env",
      instance: "https://ci.example",
      project: null,
      user: { id: 7, name: "CI User", login: "ci-user" },
    });
    mockAgent.assertNoPendingInterceptors();
  });

  test("--profile overrides OP_CLI_PROFILE for exactly one command", async ({
    onTestFinished,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-flag-profile-"));
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const directory = await writeStoredProfiles(
      root,
      {
        default: { url: "https://op-a.example" },
        work: { url: "https://op-b.example" },
      },
      { credentials: { default: "key-a", work: "key-b" } },
    );
    const mockAgent = installMockAgent();
    mockUser(mockAgent, "https://op-a.example", "Ada Lovelace");
    mockUser(mockAgent, "https://op-b.example", "Grace Hopper");

    const env = { OP_CLI_CONFIG_DIR: directory, OP_CLI_PROFILE: "work" };
    const overridden = await run(["auth", "status", "--json", "--profile", "default"], env, {});
    const followUp = await run(["auth", "status", "--json"], env, {});

    expect(JSON.parse(overridden.stdout).profile).toBe("default");
    expect(JSON.parse(overridden.stdout).instance).toBe("https://op-a.example");
    expect(JSON.parse(followUp.stdout).profile).toBe("work");
    expect(JSON.parse(
      await readFile(join(directory, "config.json"), "utf8"),
    ).active_profile).toBeUndefined();
    mockAgent.assertNoPendingInterceptors();
  });

  test("--project overrides OP_CLI_PROJECT", async ({ onTestFinished }) => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-flag-project-"));
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const directory = await writeStoredProfiles(
      root,
      { default: { url: "https://op-a.example" } },
      { credentials: { default: "key-a" } },
    );
    const mockAgent = installMockAgent();
    mockUser(mockAgent, "https://op-a.example", "Ada Lovelace", 2);

    const env = { OP_CLI_CONFIG_DIR: directory, OP_CLI_PROJECT: "31" };
    const overridden = await run(
      ["auth", "status", "--json", "--project", "21"],
      env,
      {},
    );
    const followUp = await run(["auth", "status", "--json"], env, {});

    expect(JSON.parse(overridden.stdout).project).toBe(21);
    expect(JSON.parse(followUp.stdout).project).toBe(31);
    mockAgent.assertNoPendingInterceptors();
  });

  test("environment overrides the selected profile's stored values", async ({
    onTestFinished,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-env-over-"));
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const directory = await writeStoredProfiles(
      root,
      { default: { url: "https://op-a.example", project: 13 } },
      { credentials: { default: "key-a" } },
    );
    const mockAgent = installMockAgent();
    mockUser(mockAgent, "https://override.example", "Proxy User");

    const result = await run(
      ["auth", "status", "--json"],
      {
        OP_CLI_CONFIG_DIR: directory,
        OPENPROJECT_URL: "https://override.example",
        OPENPROJECT_API_KEY: "ov-key",
        OP_CLI_PROJECT: "99",
      },
      {},
    );

    expect(JSON.parse(result.stdout)).toEqual({
      // The environment served this run, so it renders as the environment
      // profile instead of claiming the overridden stored one (#20).
      profile: "env",
      instance: "https://override.example",
      project: 99,
      user: { id: 7, name: "Proxy User", login: "proxy-user" },
    });
    mockAgent.assertNoPendingInterceptors();
  });

  test("the profile default project is honoured and --project overrides it", async ({
    onTestFinished,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-default-project-"));
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const directory = await writeStoredProfiles(
      root,
      { work: { url: "https://op-b.example", project: 5 } },
      { defaultProfile: "work", credentials: { work: "key-b" } },
    );
    const mockAgent = installMockAgent();
    mockUser(mockAgent, "https://op-b.example", "Grace Hopper", 2);

    const env = { OP_CLI_CONFIG_DIR: directory };
    const honoured = await run(["auth", "status", "--json"], env, {});
    const overridden = await run(
      ["auth", "status", "--json", "--project", "7"],
      env,
      {},
    );

    expect(JSON.parse(honoured.stdout).project).toBe(5);
    expect(JSON.parse(overridden.stdout).project).toBe(7);
    mockAgent.assertNoPendingInterceptors();
  });
});

describe("review round 1", () => {
  test("an explicit unknown profile name fails even when environment could serve", async ({
    onTestFinished,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-explicit-missing-"));
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const directory = await writeStoredProfiles(
      root,
      { default: { url: "https://op-a.example" } },
      { credentials: { default: "key-a" } },
    );

    const result = await run(
      ["auth", "status", "--profile", "ghost"],
      {
        OP_CLI_CONFIG_DIR: directory,
        OPENPROJECT_URL: "https://ci.example",
        OPENPROJECT_API_KEY: "ci-key",
      },
      {},
    );

    expect(result).toEqual({
      stdout: "",
      stderr:
        "[PROFILE_NOT_FOUND] No active profile. Hint: run op-cli auth login.\n",
      exitCode: 1,
    });
  });

  // Superseded by issue #21: naming a profile that was never stored is an
  // error even when the environment could serve the request, because
  // environment variables alone form an implicit *unnamed* profile that no
  // name can select.
  test("a profile flag naming nothing on disk fails even with no config file", async ({
    onTestFinished,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-flag-env-only-"));
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    // No interceptor is registered: net connect stays disabled, so any
    // request at all would surface as a different error than the refusal.
    const mockAgent = installMockAgent();

    const result = await run(
      ["auth", "status", "--json", "--profile", "ghost"],
      {
        OP_CLI_CONFIG_DIR: join(root, "missing"),
        OPENPROJECT_URL: "https://ci.example",
        OPENPROJECT_API_KEY: "ci-key",
      },
      {},
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe("PROFILE_NOT_FOUND");
    mockAgent.assertNoPendingInterceptors();
  });

  test("auth login merges into stored profiles instead of wiping them", async ({
    onTestFinished,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-login-merge-"));
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const directory = await writeStoredProfiles(
      root,
      {
        default: { url: "https://op-a.example" },
        work: { url: "https://op-b.example", project: 5 },
      },
      {
        defaultProfile: "work",
        activeProfile: "work",
        credentials: { work: "key-b" },
      },
    );
    const mockAgent = installMockAgent();
    mockUser(mockAgent, "https://op-a.example", "Ada Lovelace");

    const answers = ["https://op-a.example/", "key-a"];
    const result = await run(
      ["auth", "login"],
      { OP_CLI_CONFIG_DIR: directory },
      { prompt: async () => answers.shift() ?? "", stdinIsTTY: true },
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(await readFile(join(directory, "config.json"), "utf8")))
      .toEqual({
        default_profile: "work",
        active_profile: "work",
        profiles: {
          default: { url: "https://op-a.example" },
          work: { url: "https://op-b.example", project: 5 },
        },
      });
    expect(JSON.parse(
      await readFile(join(directory, "credentials.json"), "utf8"),
    )).toEqual({
      default: { api_key: "key-a" },
      work: { api_key: "key-b" },
    });
    expect((await stat(join(directory, "credentials.json"))).mode & 0o777).toBe(
      0o600,
    );
    mockAgent.assertNoPendingInterceptors();
  });

  test("stored config without a credentials file maps to the auth exit code", async ({
    onTestFinished,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-no-credentials-"));
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const directory = join(root, "config");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "config.json"),
      JSON.stringify({
        default_profile: "default",
        profiles: { default: { url: "https://op-a.example" } },
      }),
    );

    const result = await run(["auth", "status"], { OP_CLI_CONFIG_DIR: directory }, {});
    expect(result).toEqual({
      stdout: "",
      stderr: "[AUTH_FAILED] Authentication failed. Hint: run op-cli auth login.\n",
      exitCode: 3,
    });
  });
});

describe("login into named profiles and stored default projects", () => {
  test("auth login --profile creates a second profile and leaves the old one intact", async ({
    onTestFinished,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-login-named-"));
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const directory = await writeStoredProfiles(
      root,
      { default: { url: "https://op-a.example" } },
      {
        defaultProfile: "default",
        activeProfile: "default",
        credentials: { default: "key-a" },
      },
    );
    const mockAgent = installMockAgent();
    mockUser(mockAgent, "https://op-b.example", "Grace Hopper");
    const answers = ["https://op-b.example/", "key-b"];
    const result = await run(
      ["auth", "login", "--profile", "work", "--project", "13"],
      { OP_CLI_CONFIG_DIR: directory },
      { prompt: async () => answers.shift() ?? "", stdinIsTTY: true },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("using profile work.");
    expect(JSON.parse(await readFile(join(directory, "config.json"), "utf8")))
      .toEqual({
        default_profile: "default",
        active_profile: "default",
        profiles: {
          default: { url: "https://op-a.example" },
          work: { url: "https://op-b.example", project: 13 },
        },
      });
    expect(JSON.parse(
      await readFile(join(directory, "credentials.json"), "utf8"),
    )).toEqual({
      default: { api_key: "key-a" },
      work: { api_key: "key-b" },
    });
    expect((await stat(join(directory, "credentials.json"))).mode & 0o777).toBe(
      0o600,
    );
    mockAgent.assertNoPendingInterceptors();
  });

  test("auth use --project records the default project without re-login", async ({
    onTestFinished,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-use-project-"));
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const directory = await writeStoredProfiles(
      root,
      {
        default: { url: "https://op-a.example" },
        work: { url: "https://op-b.example" },
      },
      { credentials: { default: "key-a", work: "key-b" } },
    );

    const result = await run(
      ["auth", "use", "work", "--project", "13"],
      { OP_CLI_CONFIG_DIR: directory },
      {},
    );

    expect(result).toEqual({
      stdout: "Switched to profile work.\n",
      stderr: "",
      exitCode: 0,
    });
    const config = JSON.parse(
      await readFile(join(directory, "config.json"), "utf8"),
    );
    expect(config.active_profile).toBe("work");
    expect(config.profiles.work).toEqual({
      url: "https://op-b.example",
      project: 13,
    });
    expect(config.profiles.default).toEqual({ url: "https://op-a.example" });
  });
});

describe("issue 21: an unknown profile name with no config file", () => {
  // The environment carries working credentials in every test here, so a
  // refusal can only come from the name itself and never from a missing
  // instance URL or API key.
  const environmentCredentials = {
    OPENPROJECT_URL: "https://real.example.com",
    OPENPROJECT_API_KEY: "env-key",
  };

  async function emptyConfigDirectory(label: string): Promise<{
    readonly root: string;
    readonly directory: string;
  }> {
    const root = await mkdtemp(join(tmpdir(), `op-cli-${label}-`));
    const directory = join(root, "config");
    await mkdir(directory, { recursive: true });
    return { root, directory };
  }

  test("a work package command refuses instead of running against the environment", async ({
    onTestFinished,
  }) => {
    const { root, directory } = await emptyConfigDirectory("issue21-wp");
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const mockAgent = installMockAgent();

    const result = await run(
      ["wp", "list", "--profile", "khongcoprofile"],
      { ...environmentCredentials, OP_CLI_CONFIG_DIR: directory },
      {},
    );

    expect(result).toEqual({
      stdout: "",
      stderr:
        "[PROFILE_NOT_FOUND] No active profile. Hint: run op-cli auth login.\n",
      exitCode: 1,
    });
    mockAgent.assertNoPendingInterceptors();
  });

  test("doctor refuses the unknown name instead of reporting every check as pass", async ({
    onTestFinished,
  }) => {
    const { root, directory } = await emptyConfigDirectory("issue21-doctor");
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const mockAgent = installMockAgent();

    const result = await run(
      ["doctor", "--profile", "khongcoprofile"],
      {
        ...environmentCredentials,
        OP_CLI_CONFIG_DIR: directory,
        OP_CLI_CACHE_DIR: join(root, "cache"),
      },
      {},
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^\[PROFILE_NOT_FOUND\]/);
    mockAgent.assertNoPendingInterceptors();
  });

  test("OP_CLI_PROFILE naming nothing stored is refused like the flag", async ({
    onTestFinished,
  }) => {
    const { root, directory } = await emptyConfigDirectory("issue21-env-var");
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const mockAgent = installMockAgent();

    const result = await run(
      ["auth", "status"],
      {
        ...environmentCredentials,
        OP_CLI_CONFIG_DIR: directory,
        OP_CLI_PROFILE: "khongcoprofile",
      },
      {},
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^\[PROFILE_NOT_FOUND\]/);
    mockAgent.assertNoPendingInterceptors();
  });

  // A config file that parses but carries no `profiles` key must refuse the
  // same way rather than crashing on the missing map.
  test("a config file without a profiles map refuses the named profile", async ({
    onTestFinished,
  }) => {
    const { root, directory } = await emptyConfigDirectory("issue21-no-map");
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    await writeFile(join(directory, "config.json"), JSON.stringify({}));
    const mockAgent = installMockAgent();

    const result = await run(
      ["auth", "status", "--profile", "khongcoprofile"],
      { ...environmentCredentials, OP_CLI_CONFIG_DIR: directory },
      {},
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^\[PROFILE_NOT_FOUND\]/);
    mockAgent.assertNoPendingInterceptors();
  });

  // The unnamed environment profile stays reachable: the refusal is about the
  // name, not about running without a config file.
  test("the same environment without a profile name still serves the command", async ({
    onTestFinished,
  }) => {
    const { root, directory } = await emptyConfigDirectory("issue21-unnamed");
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const mockAgent = installMockAgent();
    mockUser(mockAgent, "https://real.example.com", "Env User");

    const result = await run(
      ["auth", "status", "--json"],
      { ...environmentCredentials, OP_CLI_CONFIG_DIR: directory },
      {},
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).profile).toBe("env");
    mockAgent.assertNoPendingInterceptors();
  });
});

describe("profile flag carries its own values (#20)", () => {
  test("an explicit --profile carries its stored url and key over conflicting environment", async ({
    onTestFinished,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-flag-values-"));
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const directory = await writeStoredProfiles(
      root,
      { default: { url: "https://op-a.example" } },
      { credentials: { default: "key-a" } },
    );
    const mockAgent = installMockAgent();
    mockUser(mockAgent, "https://op-a.example", "Ada Lovelace");

    const result = await run(
      ["auth", "status", "--json", "--profile", "default"],
      {
        OP_CLI_CONFIG_DIR: directory,
        OPENPROJECT_URL: "https://override.example",
        OPENPROJECT_API_KEY: "ov-key",
      },
      {},
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      profile: "default",
      instance: "https://op-a.example",
    });
    // The request must have gone to the named profile's instance, never to
    // the environment's; disableNetConnect makes any other origin fail.
    mockAgent.assertNoPendingInterceptors();
  });

  test("auth status --profile and auth list agree on the named instance under conflict", async ({
    onTestFinished,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-agree-"));
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const directory = await writeStoredProfiles(
      root,
      { default: { url: "https://op-a.example" } },
      { credentials: { default: "key-a" } },
    );
    const mockAgent = installMockAgent();
    mockUser(mockAgent, "https://op-a.example", "Ada Lovelace");

    const env = {
      OP_CLI_CONFIG_DIR: directory,
      OPENPROJECT_URL: "https://override.example",
      OPENPROJECT_API_KEY: "ov-key",
    };
    const list = JSON.parse(
      (await run(["auth", "list", "--json"], env, {})).stdout,
    );
    const status = JSON.parse(
      (await run(["auth", "status", "--json", "--profile", "default"], env, {})).stdout,
    );

    expect(status.instance).toBe(list.profiles[0].instance);
    expect(status.profile).toBe(list.profiles[0].name);
  });

  test("a run served by the environment stops claiming the overridden profile", async ({
    onTestFinished,
  }) => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-env-claim-"));
    onTestFinished(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const directory = await writeStoredProfiles(
      root,
      { default: { url: "https://op-a.example" } },
      { credentials: { default: "key-a" } },
    );
    const mockAgent = installMockAgent();
    mockUser(mockAgent, "https://override.example", "Proxy User", 2);

    const baseEnv = {
      OP_CLI_CONFIG_DIR: directory,
      OPENPROJECT_URL: "https://override.example",
      OPENPROJECT_API_KEY: "ov-key",
    };
    const activeRun = await run(["auth", "status", "--json"], baseEnv, {});
    const envTierRun = await run(
      ["auth", "status", "--json"],
      { ...baseEnv, OP_CLI_PROFILE: "default" },
      {},
    );

    // No flag and no OP_CLI_PROFILE-free claim: the run is served by the
    // environment, so it renders as the environment profile.
    expect(JSON.parse(activeRun.stdout).profile).toBe("env");
    expect(JSON.parse(activeRun.stdout).instance).toBe("https://override.example");
    // OP_CLI_PROFILE stays in the environment tier with today's behaviour.
    expect(JSON.parse(envTierRun.stdout).profile).toBe("env");
    mockAgent.assertNoPendingInterceptors();
  });
});
