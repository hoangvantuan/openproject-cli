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

interface RecordedCall {
  readonly url: string;
  readonly method: string;
}

type FetchStub = (
  input: unknown,
  init?: { method?: string; signal?: AbortSignal | null },
) => Promise<Response>;

/**
 * Replace the global fetch for one test; the returned function puts the
 * real one back. The HTTP client has no other injectable seam, and the
 * budget under test lives between fetch and its abort signal.
 */
function installFetchStub(stub: FetchStub): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

/** A fetch that records every call and only ends when its signal aborts. */
function hangUntilAborted(): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const restore = installFetchStub((input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted === true) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  cleanups.push(async () => restore());
  return { calls };
}

/** A fetch that answers after a real delay, unless the signal fires first. */
function delayThenRespond(ms: number, respond: () => Response): void {
  const restore = installFetchStub((_input, init) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(respond()), ms);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal?.reason);
      }, { once: true });
    }));
  cleanups.push(async () => restore());
}

/**
 * Capture the milliseconds the client hands to AbortSignal.timeout, and
 * cut the real wait short so asserting the default budget costs 50 ms
 * instead of 10 s. The captured number is the budget under test; the
 * shortcut only decides when the abort lands.
 *
 * Real timers are deliberate here: AbortSignal.timeout schedules on the
 * native loop, so vitest's fake timers cannot advance it; only a genuine
 * delay produces the TimeoutError reason this file asserts on.
 */
function captureTimeoutBudgets(abortAfterMs: number): {
  budgets: number[];
  restore: () => void;
} {
  const real = AbortSignal.timeout;
  const budgets: number[] = [];
  AbortSignal.timeout = ((ms: number) => {
    budgets.push(ms);
    return real.call(AbortSignal, abortAfterMs);
  }) as typeof AbortSignal.timeout;
  return { budgets, restore: () => { AbortSignal.timeout = real; } };
}

describe("the per-request timeout budget", () => {
  test("a read that outlives the default budget is a timeout, not an unreachable instance", async () => {
    const root = await makeTempRoom("op-cli-timeout-default-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    hangUntilAborted();
    const capture = captureTimeoutBudgets(50);
    try {
      const result = await run(
        ["auth", "status"],
        { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
        {},
      );

      expect(result.exitCode).toBe(6);
      expect(result.stderr).toBe(
        "[NETWORK_ERROR] The request exceeded the 10000 ms timeout. "
          + "Hint: raise OP_CLI_TIMEOUT_MS and try again.\n",
      );
      expect(capture.budgets).toEqual([10_000]);
    } finally {
      capture.restore();
    }
  });

  test("OP_CLI_TIMEOUT_MS=30000 lets a slow request finish inside the budget", async () => {
    const root = await makeTempRoom("op-cli-timeout-raised-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    delayThenRespond(150, () => new Response(
      JSON.stringify({ id: 9, name: "Linh Nguyen", login: "linh" }),
      { status: 200, headers: { "content-type": "application/hal+json" } },
    ));
    const capture = captureTimeoutBudgets(400);
    try {
      const result = await run(
        ["auth", "status"],
        {
          OP_CLI_CONFIG_DIR: configDir,
          OP_CLI_CACHE_DIR: cacheDir,
          OP_CLI_TIMEOUT_MS: "30000",
        },
        {},
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Linh Nguyen");
      expect(capture.budgets).toEqual([30_000]);
    } finally {
      capture.restore();
    }
  });

  test("an unusable OP_CLI_TIMEOUT_MS is a usage error before any request", async () => {
    for (const raw of ["abc", "1.5", "0", "-5"]) {
      const root = await makeTempRoom("op-cli-timeout-invalid-");
      const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
      const probe = hangUntilAborted();
      const result = await run(
        ["auth", "status"],
        {
          OP_CLI_CONFIG_DIR: configDir,
          OP_CLI_CACHE_DIR: cacheDir,
          OP_CLI_TIMEOUT_MS: raw,
        },
        {},
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(
        `[USAGE_ERROR] OP_CLI_TIMEOUT_MS "${raw}" is not a positive integer. `
          + "Hint: pass a whole number of milliseconds, 1 or more.\n",
      );
      expect(probe.calls).toEqual([]);
    }
  });

  test("the JSON form of a timeout carries a machine-readable marker", async () => {
    const root = await makeTempRoom("op-cli-timeout-json-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    hangUntilAborted();
    const result = await run(
      ["auth", "status"],
      {
        OP_CLI_CONFIG_DIR: configDir,
        OP_CLI_CACHE_DIR: cacheDir,
        OP_CLI_OUTPUT: "json",
        OP_CLI_TIMEOUT_MS: "100",
      },
      {},
    );

    expect(result.exitCode).toBe(6);
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: "NETWORK_ERROR",
        message: "The request exceeded the 100 ms timeout.",
        hint: "raise OP_CLI_TIMEOUT_MS and try again.",
        timedOut: true,
        timeoutMs: 100,
      },
    });
  });

  test("a connection failure keeps the reachability wording, in JSON without the marker", async () => {
    const root = await makeTempRoom("op-cli-timeout-conn-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    cleanups.push(async () => {
      await mockAgent.close();
      setGlobalDispatcher(new Agent());
    });

    const result = await run(
      ["auth", "status"],
      {
        OP_CLI_CONFIG_DIR: configDir,
        OP_CLI_CACHE_DIR: cacheDir,
        OP_CLI_OUTPUT: "json",
      },
      {},
    );

    expect(result.exitCode).toBe(6);
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: "NETWORK_ERROR",
        message: "Could not reach the instance.",
        hint: "check the instance URL and try again.",
      },
    });
  });

  test("a write that times out is attempted once and still exits 6", async () => {
    const root = await makeTempRoom("op-cli-timeout-write-");
    const { configDir, cacheDir } = await writeSingleProfile(root, INSTANCE);
    const probe = hangUntilAborted();
    const result = await run(
      ["wp", "delete", "675", "--yes"],
      {
        OP_CLI_CONFIG_DIR: configDir,
        OP_CLI_CACHE_DIR: cacheDir,
        OP_CLI_TIMEOUT_MS: "100",
      },
      {},
    );

    expect(result.exitCode).toBe(6);
    expect(result.stderr).toBe(
      "[NETWORK_ERROR] The request exceeded the 100 ms timeout. "
        + "Hint: raise OP_CLI_TIMEOUT_MS and try again.\n",
    );
    // One attempt only: a replayed delete could destroy a second record.
    expect(probe.calls).toEqual([
      { url: `${INSTANCE}/api/v3/work_packages/675`, method: "DELETE" },
    ]);
  });
});
