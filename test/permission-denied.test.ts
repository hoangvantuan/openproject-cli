import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, expect, test } from "vitest";

import { run } from "../src/run.js";

const INSTANCE_URL = "https://openproject.example";

let root: string;
let env: Record<string, string>;
let mockAgent: MockAgent;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "op-cli-permission-"));
  const configDir = join(root, "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify({
      default_profile: "default",
      profiles: { default: { url: INSTANCE_URL } },
    }),
  );
  await writeFile(
    join(configDir, "credentials.json"),
    JSON.stringify({ default: { api_key: "secret-key" } }),
    { mode: 0o600 },
  );
  env = { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: join(root, "cache") };
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

afterEach(async () => {
  await mockAgent.close();
  setGlobalDispatcher(new Agent());
  await rm(root, { recursive: true, force: true });
});

test("a 403 is a permission refusal naming the path and the server's reason", async () => {
  mockAgent.get(INSTANCE_URL)
    .intercept({ path: "/api/v3/users/me", method: "GET" })
    .reply(403, {
      _type: "Error",
      errorIdentifier: "urn:openproject-org:api:v3:errors:MissingPermission",
      message: "You are not authorized to access this resource.",
    });

  const result = await run(["auth", "status", "--json"], env, {});

  expect(result.exitCode).toBe(8);
  const error = JSON.parse(result.stderr).error;
  expect(error.code).toBe("PERMISSION_DENIED");
  expect(error.message).toContain("/api/v3/users/me");
  expect(error.message).toContain("You are not authorized to access this resource.");
  expect(error.hint).not.toMatch(/auth login/);
  expect(error).toMatchObject({ status: 403, path: "/api/v3/users/me" });
});

test("a 403 without a server message still names the path", async () => {
  mockAgent.get(INSTANCE_URL)
    .intercept({ path: "/api/v3/users/me", method: "GET" })
    .reply(403, "");

  const result = await run(["auth", "status"], env, {});

  expect(result.exitCode).toBe(8);
  expect(result.stderr).toMatch(/^\[PERMISSION_DENIED\] .*\/api\/v3\/users\/me/);
});

test("a 401 still means the credentials failed", async () => {
  mockAgent.get(INSTANCE_URL)
    .intercept({ path: "/api/v3/users/me", method: "GET" })
    .reply(401, { _type: "Error" });

  const result = await run(["auth", "status"], env, {});

  expect(result.exitCode).toBe(3);
  expect(result.stderr).toMatch(/^\[AUTH_FAILED\]/);
  expect(result.stderr).toContain("auth login");
});
