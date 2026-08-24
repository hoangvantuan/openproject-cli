import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, MockAgent, setGlobalDispatcher } from "undici";
import { expect, test } from "vitest";

import { run } from "../src/run.js";

test("every surfaced error belongs to the closed error catalogue", async () => {
  const root = await mkdtemp(join(tmpdir(), "op-cli-error-catalogue-"));
  const configDirectory = join(root, "config");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    join(configDirectory, "config.json"),
    JSON.stringify({
      default_profile: "default",
      profiles: { default: { url: "https://openproject.example" } },
    }),
  );
  await writeFile(
    join(configDirectory, "credentials.json"),
    JSON.stringify({ default: { api_key: "secret-key" } }),
    { mode: 0o600 },
  );

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  const pool = mockAgent.get("https://openproject.example");
  pool
    .intercept({ path: "/api/v3/users/me", method: "GET" })
    .reply(500, { _type: "Error" });
  pool
    .intercept({ path: "/api/v3/users/me", method: "GET" })
    .reply(500, { _type: "Error" });
  pool
    .intercept({ path: "/api/v3/users/me", method: "GET" })
    .reply(401, { _type: "Error" });
  pool
    .intercept({ path: "/api/v3/users/me", method: "GET" })
    .replyWithError(new Error("connect ECONNREFUSED"));
  pool
    .intercept({ path: "/api/v3/", method: "GET" })
    .reply(200, { _type: "Root", apiVersion: "2" });
  pool
    .intercept({ path: "/api/v3/users/me", method: "GET" })
    .reply(200, { id: 1, name: "Ada", login: "ada" });
  pool
    .intercept({ path: "/api/v3/projects?pageSize=1", method: "GET" })
    .reply(200, { _type: "Collection", total: 0, count: 0 });

  try {
    const env = {
      OP_CLI_CONFIG_DIR: configDirectory,
      OP_CLI_CACHE_DIR: join(root, "cache"),
    };
    const results = [
      await run(["unknown"], env, {}),
      await run(
        ["auth", "login"],
        env,
        {
          prompt: async () => {
            throw new Error("input failed");
          },
          stdinIsTTY: true,
        },
      ),
      await run(
        ["auth", "status"],
        {
          OP_CLI_CONFIG_DIR: join(root, "missing"),
          OP_CLI_CACHE_DIR: join(root, "cache"),
        },
        {},
      ),
      await run(["auth", "status"], env, {}),
      await run(["auth", "status"], env, {}),
      await run(["auth", "status"], env, {}),
      await run(["doctor"], env, {}),
    ];
    const closedCatalogue: Record<string, true> = {
      USAGE_ERROR: true,
      PROFILE_NOT_FOUND: true,
      API_ERROR: true,
      INTERNAL_ERROR: true,
      AUTH_FAILED: true,
      UNSUPPORTED_VERSION: true,
      NETWORK_ERROR: true,
    };
    const surfacedCodes = new Set<string>();

    for (const result of results) {
      const match = /^\[([A-Z_]+)\]/.exec(result.stderr);
      expect(match, result.stderr).not.toBeNull();
      const code = match?.[1] ?? "";
      expect(code in closedCatalogue, code).toBe(true);
      surfacedCodes.add(code);
    }

    expect(surfacedCodes).toEqual(new Set(Object.keys(closedCatalogue)));
    mockAgent.assertNoPendingInterceptors();
  } finally {
    await mockAgent.close();
    setGlobalDispatcher(new Agent());
    await rm(root, { recursive: true, force: true });
  }
});
