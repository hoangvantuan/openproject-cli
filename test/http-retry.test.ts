import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, expect, test } from "vitest";

import { OpCliError } from "../src/core/errors.js";
import { apiGet } from "../src/core/http.js";
import {
  baseMetadata,
  customFieldsFromSchema,
  INSTANCE,
  projectVocabulary,
  schemaFragment,
} from "./fixtures/metadata.js";
import { run } from "../src/run.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

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

test("a GET retries exactly once on 429 and then succeeds", async () => {
  const mockAgent = installMockAgent();
  const pool = mockAgent.get(INSTANCE);
  // Two single-shot interceptors: a third request would fail the whole
  // agent, so assertNoPendingInterceptors pins the count at exactly two.
  pool
    .intercept({ path: "/api/v3/types", method: "GET" })
    .reply(429, { _type: "Error" })
    .times(1);
  pool
    .intercept({ path: "/api/v3/types", method: "GET" })
    .reply(200, { _type: "Collection", elements: [] })
    .times(1);

  const result = await apiGet(INSTANCE, "key", "/api/v3/types");

  expect(result).toEqual({ _type: "Collection", elements: [] });
  mockAgent.assertNoPendingInterceptors();
});

test("a GET failing with 500 twice exits through the error catalogue", async () => {
  const mockAgent = installMockAgent();
  const pool = mockAgent.get(INSTANCE);
  pool
    .intercept({ path: "/api/v3/types", method: "GET" })
    .reply(500, { _type: "Error" })
    .times(1);
  pool
    .intercept({ path: "/api/v3/types", method: "GET" })
    .reply(500, { _type: "Error" })
    .times(1);

  const failure = await apiGet(INSTANCE, "key", "/api/v3/types").catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(OpCliError);
  expect((failure as OpCliError).code).toBe("API_ERROR");
  expect((failure as OpCliError).exitCode).toBe(2);
  mockAgent.assertNoPendingInterceptors();
});

test("a write never retries: one POST against 500 exits 6", async () => {
  const root = await mkdtemp(join(tmpdir(), "op-cli-write-retry-"));
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
      profiles: { default: { url: INSTANCE, project: 13 } },
    }),
  );
  await writeFile(
    join(configDir, "credentials.json"),
    JSON.stringify({ default: { api_key: "secret-key" } }),
    { mode: 0o600 },
  );
  const taskFields = schemaFragment([{ index: 8, name: "Estimate" }]);
  await mkdir(join(cacheDir, "default"), { recursive: true });
  await writeFile(
    join(cacheDir, "default", "metadata.json"),
    JSON.stringify({
      ...baseMetadata(),
      projectScoped: {
        "13": projectVocabulary({
          "2": customFieldsFromSchema(taskFields),
        }),
      },
    }),
  );
  const mockAgent = installMockAgent();
  // The create POST is consumed once; if the client retried, the second
  // attempt would hit no interceptor and surface as INTERNAL_ERROR.
  mockAgent
    .get(INSTANCE)
    .intercept({ path: "/api/v3/work_packages", method: "POST" })
    .reply(500, { _type: "Error", message: "boom" });

  const result = await run(
    ["wp", "create", "F", "--type", "Task"],
    { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
    {},
  );

  expect(result.exitCode).toBe(6);
  expect(result.stderr).toContain("NETWORK_ERROR");
  mockAgent.assertNoPendingInterceptors();
});
