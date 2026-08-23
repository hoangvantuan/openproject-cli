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
const WP_PATH = "/api/v3/work_packages/675";

/**
 * Installs only the listed DELETE replies; any other request fails the
 * whole agent (net connect disabled), so a green run proves a refused
 * delete touched nothing.
 */
function installDeleteApi(
  status: number,
): { deleteCalls: () => number } {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  cleanups.push(async () => {
    await mockAgent.close();
    setGlobalDispatcher(new Agent());
  });
  let calls = 0;
  mockAgent.get(INSTANCE)
    .intercept({ path: WP_PATH, method: "DELETE" })
    .reply(() => {
      calls += 1;
      return { statusCode: status, data: "" };
    })
    .persist();
  return { deleteCalls: () => calls };
}

async function runWpWithIo(
  configDir: string,
  cacheDir: string,
  args: ReadonlyArray<string>,
  io: { isTTY?: boolean },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return run(
    ["wp", ...args],
    { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
    io,
  );
}

describe("wp delete", () => {
  test("without --yes exits 1 and sends nothing even without a terminal", async () => {
    const root = await makeTempRoom("wp-delete-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installDeleteApi(204);
    const result = await runWpWithIo(configDir, cacheDir, ["delete", "675"], {});
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--yes");
  });

  test("without --yes exits 1 even with a terminal attached", async () => {
    const root = await makeTempRoom("wp-delete-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const api = installDeleteApi(204);
    const result = await runWpWithIo(configDir, cacheDir, ["delete", "675"], {
      isTTY: true,
    });
    expect(result.exitCode).toBe(1);
    expect(api.deleteCalls()).toBe(0);
  });

  test("--yes deletes and reports it", async () => {
    const root = await makeTempRoom("wp-delete-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const api = installDeleteApi(204);
    const result = await runWpWithIo(configDir, cacheDir, [
      "delete",
      "675",
      "--yes",
    ], {});
    expect(result.exitCode).toBe(0);
    expect(api.deleteCalls()).toBe(1);
    expect(result.stdout).toContain("675");
  });

  test("a missing work package exits 4", async () => {
    const root = await makeTempRoom("wp-delete-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installDeleteApi(404);
    const result = await runWpWithIo(configDir, cacheDir, [
      "delete",
      "675",
      "--yes",
    ], {});
    expect(result.exitCode).toBe(4);
  });

  test("refuses a non-numeric reference without any request", async () => {
    const root = await makeTempRoom("wp-delete-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const api = installDeleteApi(204);
    const result = await runWpWithIo(configDir, cacheDir, [
      "delete",
      "ship-the-thing",
      "--yes",
    ], {});
    expect(result.exitCode).toBe(1);
    expect(api.deleteCalls()).toBe(0);
  });
});
