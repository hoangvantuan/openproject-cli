import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

async function writeStoredProfile(root: string): Promise<void> {
  const directory = join(root, "config");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({
      default_profile: "default",
      profiles: {
        default: { url: "https://openproject.example" },
      },
    }),
  );
  await writeFile(
    join(directory, "credentials.json"),
    JSON.stringify({
      default: { api_key: "secret-key" },
    }),
    { mode: 0o600 },
  );
}

describe("op-cli entry function", () => {
  test("returns help through the in-process seam", async () => {
    const result = await run(["--help"], {}, {});

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: op-cli");
    expect(result.stdout).toContain("auth");
  });

  test("command misuse returns the stable usage error", async () => {
    const result = await run(["unknown"], {}, {});

    expect(result).toEqual({
      stdout: "",
      stderr:
        "[USAGE_ERROR] Invalid command usage. Hint: run op-cli --help.\n",
      exitCode: 1,
    });
  });

  test("auth login without interactive IO returns a catalogued usage error", async () => {
    const result = await run(["auth", "login"], {}, {});

    expect(result).toEqual({
      stdout: "",
      stderr:
        "[USAGE_ERROR] Invalid command usage. Hint: run op-cli --help.\n",
      exitCode: 1,
    });
  });

  test("auth login rejects an invalid instance URL as command misuse", async () => {
    const answers = ["not a URL", "secret-key"];
    const result = await run(
      ["auth", "login"],
      {},
      { prompt: async () => answers.shift() ?? "" },
    );

    expect(result).toEqual({
      stdout: "",
      stderr:
        "[USAGE_ERROR] Invalid command usage. Hint: run op-cli --help.\n",
      exitCode: 1,
    });
  });

  test("unexpected IO failures still return a catalogued error", async () => {
    const result = await run(
      ["auth", "login"],
      {},
      {
        prompt: async () => {
          throw new Error("input failed");
        },
      },
    );

    expect(result).toEqual({
      stdout: "",
      stderr:
        "[INTERNAL_ERROR] Unexpected failure. Hint: retry or report the error.\n",
      exitCode: 2,
    });
  });

  test("auth login verifies credentials and stores the default profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-login-"));
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    cleanups.push(async () => {
      await mockAgent.close();
      setGlobalDispatcher(new Agent());
    });
    const pool = mockAgent.get("https://openproject.example");
    pool
      .intercept({
        path: "/api/v3/users/me",
        method: "GET",
        headers: {
          authorization: `Basic ${Buffer.from("apikey:secret-key").toString("base64")}`,
        },
      })
      .reply(200, { _type: "User", id: 7, name: "Ada Lovelace", login: "ada" });

    const answers = ["https://openproject.example/", "secret-key"];
    const prompts: Array<{ message: string; secret: boolean }> = [];
    const result = await run(
      ["auth", "login"],
      {
        OP_CLI_CONFIG_DIR: join(root, "config"),
        OP_CLI_CACHE_DIR: join(root, "cache"),
      },
      {
        prompt: async (message, secret) => {
          prompts.push({ message, secret });
          return answers.shift() ?? "";
        },
      },
    );

    expect(result).toEqual({
      stdout:
        "Authenticated Ada Lovelace at https://openproject.example using profile default.\n",
      stderr: "",
      exitCode: 0,
    });
    expect(prompts).toEqual([
      { message: "Instance URL: ", secret: false },
      { message: "API key: ", secret: true },
    ]);
    expect(JSON.parse(await readFile(join(root, "config", "config.json"), "utf8"))).toEqual({
      default_profile: "default",
      profiles: {
        default: { url: "https://openproject.example" },
      },
    });
    expect(
      JSON.parse(await readFile(join(root, "config", "credentials.json"), "utf8")),
    ).toEqual({
      default: { api_key: "secret-key" },
    });
    expect((await stat(join(root, "config", "credentials.json"))).mode & 0o777).toBe(
      0o600,
    );
    mockAgent.assertNoPendingInterceptors();
  });

  test("auth login rejects bad credentials without writing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-auth-failure-"));
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    cleanups.push(async () => {
      await mockAgent.close();
      setGlobalDispatcher(new Agent());
    });
    mockAgent
      .get("https://openproject.example")
      .intercept({ path: "/api/v3/users/me", method: "GET" })
      .reply(401, { _type: "Error", errorIdentifier: "urn:openproject-org:api:v3:errors:Unauthenticated" });

    const answers = ["https://openproject.example", "wrong-key"];
    const result = await run(
      ["auth", "login"],
      {
        OP_CLI_CONFIG_DIR: join(root, "config"),
        OP_CLI_CACHE_DIR: join(root, "cache"),
      },
      {
        prompt: async () => answers.shift() ?? "",
      },
    );

    expect(result).toEqual({
      stdout: "",
      stderr:
        "[AUTH_FAILED] Authentication failed. Hint: run op-cli auth login.\n",
      exitCode: 3,
    });
    await expect(readFile(join(root, "config", "config.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(root, "config", "credentials.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    mockAgent.assertNoPendingInterceptors();
  });

  test("auth login maps an unreachable instance to the network exit code", async () => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-network-failure-"));
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    cleanups.push(async () => {
      await mockAgent.close();
      setGlobalDispatcher(new Agent());
    });
    mockAgent
      .get("https://unreachable.example")
      .intercept({ path: "/api/v3/users/me", method: "GET" })
      .replyWithError(new Error("connect ECONNREFUSED"));

    const answers = ["https://unreachable.example", "secret-key"];
    const result = await run(
      ["auth", "login"],
      {
        OP_CLI_CONFIG_DIR: join(root, "config"),
        OP_CLI_CACHE_DIR: join(root, "cache"),
      },
      {
        prompt: async () => answers.shift() ?? "",
      },
    );

    expect(result).toEqual({
      stdout: "",
      stderr:
        "[NETWORK_ERROR] Could not reach the instance. Hint: check the instance URL and try again.\n",
      exitCode: 6,
    });
    await expect(readFile(join(root, "config", "config.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(root, "config", "credentials.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    mockAgent.assertNoPendingInterceptors();
  });

  test("auth login maps another API failure to exit code 2", async () => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-api-failure-"));
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    cleanups.push(async () => {
      await mockAgent.close();
      setGlobalDispatcher(new Agent());
    });
    mockAgent
      .get("https://openproject.example")
      .intercept({ path: "/api/v3/users/me", method: "GET" })
      .reply(500, { _type: "Error", errorIdentifier: "urn:openproject-org:api:v3:errors:InternalError" });

    const answers = ["https://openproject.example", "secret-key"];
    const result = await run(
      ["auth", "login"],
      {
        OP_CLI_CONFIG_DIR: join(root, "config"),
        OP_CLI_CACHE_DIR: join(root, "cache"),
      },
      {
        prompt: async () => answers.shift() ?? "",
      },
    );

    expect(result).toEqual({
      stdout: "",
      stderr:
        "[API_ERROR] OpenProject request failed. Hint: try again later.\n",
      exitCode: 2,
    });
    await expect(readFile(join(root, "config", "config.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    mockAgent.assertNoPendingInterceptors();
  });

  test("auth status renders the same table content with or without a TTY", async () => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-status-table-"));
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
    });
    await writeStoredProfile(root);
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    cleanups.push(async () => {
      await mockAgent.close();
      setGlobalDispatcher(new Agent());
    });
    mockAgent
      .get("https://openproject.example")
      .intercept({ path: "/api/v3/users/me", method: "GET" })
      .reply(200, { _type: "User", id: 7, name: "Ada Lovelace", login: "ada" })
      .times(2);
    const env = {
      OP_CLI_CONFIG_DIR: join(root, "config"),
      OP_CLI_CACHE_DIR: join(root, "cache"),
    };

    const withoutTty = await run(["auth", "status"], env, { isTTY: false });
    const withTty = await run(["auth", "status"], env, { isTTY: true });

    expect(withoutTty).toEqual({
      stdout:
        "PROFILE  INSTANCE                     PROJECT  USER\n" +
        "default  https://openproject.example           Ada Lovelace\n",
      stderr: "",
      exitCode: 0,
    });
    expect(withTty).toEqual(withoutTty);
    mockAgent.assertNoPendingInterceptors();
  });

  test("auth status emits one JSON object with --json", async () => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-status-json-"));
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
    });
    await writeStoredProfile(root);
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    cleanups.push(async () => {
      await mockAgent.close();
      setGlobalDispatcher(new Agent());
    });
    mockAgent
      .get("https://openproject.example")
      .intercept({ path: "/api/v3/users/me", method: "GET" })
      .reply(200, { _type: "User", id: 7, name: "Ada Lovelace", login: "ada" });

    const result = await run(
      ["auth", "status", "--json"],
      {
        OP_CLI_CONFIG_DIR: join(root, "config"),
        OP_CLI_CACHE_DIR: join(root, "cache"),
      },
      { isTTY: true },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      profile: "default",
      instance: "https://openproject.example",
      project: null,
      user: {
        id: 7,
        name: "Ada Lovelace",
        login: "ada",
      },
    });
    expect(result.stdout.endsWith("\n")).toBe(true);
    mockAgent.assertNoPendingInterceptors();
  });

  test("auth status emits catalogued errors as JSON in JSON mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-status-json-error-"));
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
    });
    await writeStoredProfile(root);
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    cleanups.push(async () => {
      await mockAgent.close();
      setGlobalDispatcher(new Agent());
    });
    mockAgent
      .get("https://openproject.example")
      .intercept({ path: "/api/v3/users/me", method: "GET" })
      .reply(401, { _type: "Error" });

    const result = await run(
      ["auth", "status", "--json"],
      {
        OP_CLI_CONFIG_DIR: join(root, "config"),
        OP_CLI_CACHE_DIR: join(root, "cache"),
      },
      {},
    );

    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: "AUTH_FAILED",
        message: "Authentication failed.",
        hint: "run op-cli auth login.",
      },
    });
    expect(result.stderr.endsWith("\n")).toBe(true);
    mockAgent.assertNoPendingInterceptors();
  });

  test("auth status reports a missing active profile through the error catalogue", async () => {
    const root = await mkdtemp(join(tmpdir(), "op-cli-no-profile-"));
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const result = await run(
      ["auth", "status"],
      {
        OP_CLI_CONFIG_DIR: join(root, "config"),
        OP_CLI_CACHE_DIR: join(root, "cache"),
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
});
