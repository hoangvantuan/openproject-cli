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

/** The exact ancestor-filtered count request `wp delete` issues first. */
function descendantCountPath(id: string): string {
  const filters = encodeURIComponent(
    JSON.stringify([{ ancestor: { operator: "=", values: [id] } }]),
  );
  return `/api/v3/work_packages?filters=${filters}&pageSize=1`;
}

/**
 * Installs the DELETE reply and the descendant-count reply; any other
 * request fails the whole agent (net connect disabled), so a green run
 * proves a refused delete sent no write and touched nothing else.
 * `descendants: "fail"` answers the count read with a 404.
 */
function installDeleteApi(
  status: number,
  descendants: number | "fail" = 0,
): { deleteCalls: () => number; countCalls: () => number } {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  cleanups.push(async () => {
    await mockAgent.close();
    setGlobalDispatcher(new Agent());
  });
  let deletes = 0;
  mockAgent.get(INSTANCE)
    .intercept({ path: WP_PATH, method: "DELETE" })
    .reply(() => {
      deletes += 1;
      return { statusCode: status, data: "" };
    })
    .persist();
  let counts = 0;
  const count = mockAgent.get(INSTANCE)
    .intercept({ path: descendantCountPath("675"), method: "GET" });
  if (descendants === "fail") {
    count.reply(() => {
      counts += 1;
      return { statusCode: 404, data: { message: "work package not found" } };
    }).persist();
  } else {
    count.reply(() => {
      counts += 1;
      return {
        statusCode: 200,
        data: { total: descendants, count: descendants, _embedded: { elements: [] } },
      };
    }).persist();
  }
  return { deleteCalls: () => deletes, countCalls: () => counts };
}

async function runWpWithIo(
  configDir: string,
  cacheDir: string,
  args: ReadonlyArray<string>,
  io: { stdinIsTTY?: boolean },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return run(
    ["wp", ...args],
    { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
    io,
  );
}

describe("wp delete", () => {
  test("without --yes exits 1 and deletes nothing even without a terminal", async () => {
    const root = await makeTempRoom("wp-delete-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const api = installDeleteApi(204);
    const result = await runWpWithIo(configDir, cacheDir, ["delete", "675"], {});
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--yes");
    expect(api.deleteCalls()).toBe(0);
  });

  test("without --yes exits 1 and deletes nothing even with a terminal attached", async () => {
    const root = await makeTempRoom("wp-delete-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const api = installDeleteApi(204);
    const result = await runWpWithIo(configDir, cacheDir, ["delete", "675"], {
      stdinIsTTY: true,
    });
    expect(result.exitCode).toBe(1);
    expect(api.deleteCalls()).toBe(0);
  });

  test("without --yes the refusal names the descendant count", async () => {
    const root = await makeTempRoom("wp-delete-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const api = installDeleteApi(204, 2);
    const result = await runWpWithIo(configDir, cacheDir, ["delete", "675"], {});
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Work package 675 has 2 descendants; they are deleted with it.",
    );
    expect(result.stderr).toContain("--yes");
    expect(api.deleteCalls()).toBe(0);
  });

  test("without --yes a single descendant stays singular", async () => {
    const root = await makeTempRoom("wp-delete-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installDeleteApi(204, 1);
    const result = await runWpWithIo(configDir, cacheDir, ["delete", "675"], {});
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("has 1 descendant;");
    expect(result.stderr).not.toContain("1 descendants");
  });

  test("--yes deletes a leaf and reports exactly as before", async () => {
    const root = await makeTempRoom("wp-delete-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const api = installDeleteApi(204, 0);
    const result = await runWpWithIo(configDir, cacheDir, [
      "delete",
      "675",
      "--yes",
    ], {});
    expect(result.exitCode).toBe(0);
    expect(api.deleteCalls()).toBe(1);
    expect(result.stdout).toBe("Deleted work package 675.\n");
  });

  test("--yes on a parent states how many descendants were destroyed", async () => {
    const root = await makeTempRoom("wp-delete-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const api = installDeleteApi(204, 3);
    const result = await runWpWithIo(configDir, cacheDir, [
      "delete",
      "675",
      "--yes",
    ], {});
    expect(result.exitCode).toBe(0);
    expect(api.deleteCalls()).toBe(1);
    expect(result.stdout).toBe(
      "Deleted work package 675 and its 3 descendants.\n",
    );
  });

  test("--yes on a parent of one states one descendant", async () => {
    const root = await makeTempRoom("wp-delete-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installDeleteApi(204, 1);
    const result = await runWpWithIo(configDir, cacheDir, [
      "delete",
      "675",
      "--yes",
    ], {});
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "Deleted work package 675 and its 1 descendant.\n",
    );
  });

  test("a missing work package exits 4", async () => {
    const root = await makeTempRoom("wp-delete-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    installDeleteApi(404, "fail");
    const result = await runWpWithIo(configDir, cacheDir, [
      "delete",
      "675",
      "--yes",
    ], {});
    expect(result.exitCode).toBe(4);
  });

  test("a failed descendant count does not block a confirmed deletion", async () => {
    const root = await makeTempRoom("wp-delete-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const api = installDeleteApi(204, "fail");
    const result = await runWpWithIo(configDir, cacheDir, [
      "delete",
      "675",
      "--yes",
    ], {});
    expect(result.exitCode).toBe(0);
    expect(api.countCalls()).toBe(1);
    expect(api.deleteCalls()).toBe(1);
    expect(result.stdout).toBe("Deleted work package 675.\n");
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
    expect(api.countCalls()).toBe(0);
  });
});
