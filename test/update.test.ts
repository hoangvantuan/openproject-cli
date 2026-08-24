import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, test } from "vitest";

import { run } from "../src/run.js";

const REGISTRY = "https://registry.npmjs.org";
const REGISTRY_LATEST = "/@tuanhv%2Fop-cli/latest";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

interface ScratchEnv {
  readonly root: string;
  readonly env: Record<string, string>;
}

async function scratchEnv(prefix: string): Promise<ScratchEnv> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const configDirectory = join(root, "config");
  await mkdir(configDirectory, { recursive: true });
  // `auth list` is the notice testbed: an offline command that succeeds,
  // so any stderr it carries can only come from the notice itself.
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
  );
  return {
    root,
    env: {
      OP_CLI_CONFIG_DIR: configDirectory,
      OP_CLI_CACHE_DIR: join(root, "cache"),
    },
  };
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

function registryReplies(mockAgent: MockAgent, version: string): void {
  mockAgent
    .get(REGISTRY)
    .intercept({ path: REGISTRY_LATEST, method: "GET" })
    .reply(200, { name: "@tuanhv/op-cli", version });
}

async function noticeCacheExists(scratch: ScratchEnv): Promise<boolean> {
  try {
    await stat(join(scratch.env.OP_CLI_CONFIG_DIR, "update-check.json"));
    return true;
  } catch {
    return false;
  }
}

async function writeNoticeCache(
  scratch: ScratchEnv,
  cache: { checkedAt: number; latest: string },
): Promise<void> {
  await mkdir(scratch.env.OP_CLI_CONFIG_DIR, { recursive: true });
  await writeFile(
    join(scratch.env.OP_CLI_CONFIG_DIR, "update-check.json"),
    JSON.stringify(cache),
  );
}

interface ExternalCall {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
}

// A recording seam for the two process shapes the update command needs:
// an installer whose streams are inherited (resolved with an exit code)
// and a probe whose stdout is captured (resolved from a table keyed by
// the joined arguments; a missing key resolves undefined).
function spawnSeam(script: {
  readonly captures?: Record<string, string>;
  readonly installExitCode?: number;
}): {
  readonly calls: ExternalCall[];
  readonly runExternal: (file: string, args: readonly string[]) => Promise<number>;
  readonly captureExternal: (
    file: string,
    args: readonly string[],
  ) => Promise<string | undefined>;
} {
  const calls: ExternalCall[] = [];
  return {
    calls,
    runExternal: async (file, args) => {
      calls.push({ file, args });
      return script.installExitCode ?? 0;
    },
    captureExternal: async (file, args) => {
      calls.push({ file, args });
      return script.captures?.[args.join(" ")];
    },
  };
}

describe("new-version notice", () => {
  test("a non-TTY stderr never asks the registry, even for a newer release", async () => {
    const scratch = await scratchEnv("op-cli-notice-no-tty-");
    const mockAgent = installMockAgent();
    registryReplies(mockAgent, "9.9.9");

    const result = await run(["auth", "list"], scratch.env, { stdinIsTTY: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("9.9.9");
    // No lookup means no cache write either.
    expect(await noticeCacheExists(scratch)).toBe(false);
    // The pending interceptor is itself the proof: no request was made.
  });

  test("OP_CLI_NO_UPDATE_CHECK=1 opts out even on a TTY", async () => {
    const scratch = await scratchEnv("op-cli-notice-disabled-");
    const mockAgent = installMockAgent();
    registryReplies(mockAgent, "9.9.9");

    const result = await run(
      ["auth", "list"],
      { ...scratch.env, OP_CLI_NO_UPDATE_CHECK: "1" },
      { stdinIsTTY: true, stderrIsTTY: true },
    );

    expect(result.exitCode).toBe(0);
    expect(await noticeCacheExists(scratch)).toBe(false);
    // The pending interceptor is itself the proof: no request was made.
  });

  test("a TTY stderr gets one notice line and never touches stdout", async () => {
    const scratch = await scratchEnv("op-cli-notice-tty-");
    const mockAgent = installMockAgent();
    registryReplies(mockAgent, "9.9.9");

    const result = await run(["auth", "list"], scratch.env, { stderrIsTTY: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(
      /^op-cli 9\.9\.9 available \(running \d+\.\d+\.\d+\); run op-cli update\n$/,
    );
    expect(result.stderr.split("\n").filter((line) => line !== "").length).toBe(1);
    expect(result.stdout).not.toContain("9.9.9");
    const cached = JSON.parse(
      await readFile(join(scratch.env.OP_CLI_CONFIG_DIR, "update-check.json"), "utf8"),
    ) as { checkedAt: number; latest: string };
    expect(cached.latest).toBe("9.9.9");
    expect(cached.checkedAt).toBeGreaterThan(Date.now() - 60_000);
    mockAgent.assertNoPendingInterceptors();
  });

  test("a cache younger than 24h serves the notice without a request", async () => {
    const scratch = await scratchEnv("op-cli-notice-fresh-cache-");
    const mockAgent = installMockAgent();
    // Net access is disabled and no interceptor is registered: a fetch
    // would fail silently and swallow the notice with it.
    await writeNoticeCache(scratch, { checkedAt: Date.now(), latest: "9.9.9" });

    const result = await run(["auth", "list"], scratch.env, { stderrIsTTY: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/^op-cli 9\.9\.9 available \(running /);
    const cached = JSON.parse(
      await readFile(join(scratch.env.OP_CLI_CONFIG_DIR, "update-check.json"), "utf8"),
    ) as { latest: string };
    expect(cached.latest).toBe("9.9.9");
    mockAgent.assertNoPendingInterceptors();
  });

  test("an unreachable registry stays silent and caches nothing", async () => {
    const scratch = await scratchEnv("op-cli-notice-unreachable-");
    installMockAgent();

    const result = await run(["auth", "list"], scratch.env, { stderrIsTTY: true });

    expect(result).toMatchObject({ stderr: "", exitCode: 0 });
    expect(await noticeCacheExists(scratch)).toBe(false);
  });

  test("a cache older than 24h forces a fresh lookup", async () => {
    const scratch = await scratchEnv("op-cli-notice-stale-cache-");
    const mockAgent = installMockAgent();
    registryReplies(mockAgent, "9.9.9");
    const staleAt = Date.now() - 25 * 60 * 60 * 1000;
    await writeNoticeCache(scratch, { checkedAt: staleAt, latest: "0.0.1" });

    const result = await run(["auth", "list"], scratch.env, { stderrIsTTY: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/^op-cli 9\.9\.9 available \(running /);
    const cached = JSON.parse(
      await readFile(join(scratch.env.OP_CLI_CONFIG_DIR, "update-check.json"), "utf8"),
    ) as { checkedAt: number; latest: string };
    expect(cached.latest).toBe("9.9.9");
    expect(cached.checkedAt).toBeGreaterThan(staleAt + 60_000);
    mockAgent.assertNoPendingInterceptors();
  });

  test("an unreachable registry stays silent and caches nothing", async () => {
    const scratch = await scratchEnv("op-cli-notice-unreachable-");
    installMockAgent();

    const result = await run(["auth", "list"], scratch.env, { stderrIsTTY: true });

    expect(result).toMatchObject({ stderr: "", exitCode: 0 });
    expect(await noticeCacheExists(scratch)).toBe(false);
  });

  test("a registry release that is not newer prints nothing but still caches", async () => {
    const scratch = await scratchEnv("op-cli-notice-older-");
    const mockAgent = installMockAgent();
    registryReplies(mockAgent, "0.0.1");

    const result = await run(["auth", "list"], scratch.env, { stderrIsTTY: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const cached = JSON.parse(
      await readFile(join(scratch.env.OP_CLI_CONFIG_DIR, "update-check.json"), "utf8"),
    ) as { latest: string };
    expect(cached.latest).toBe("0.0.1");
    mockAgent.assertNoPendingInterceptors();
  });

  test("--version stays offline: no lookup, no cache, no notice", async () => {
    const scratch = await scratchEnv("op-cli-notice-version-");
    const mockAgent = installMockAgent();
    registryReplies(mockAgent, "9.9.9");

    const result = await run(["--version"], scratch.env, { stderrIsTTY: true });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(await noticeCacheExists(scratch)).toBe(false);
    // The pending interceptor is itself the proof: no request was made.
  });
});

describe("op-cli update", () => {
  test("an unmanaged install runs npm install against the package", async () => {
    const scratch = await scratchEnv("op-cli-update-npm-");
    // The `which op-cli` probe is absent from the capture table, so it
    // resolves undefined and the npm path is taken.
    const seam = spawnSeam({ captures: { "prefix -g": "/usr\n" } });

    const result = await run(["update"], scratch.env, seam);

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(seam.calls).toEqual([
      { file: "npm", args: ["prefix", "-g"] },
      { file: "which", args: ["op-cli"] },
      { file: "npm", args: ["install", "-g", "@tuanhv/op-cli@latest"] },
    ]);
  });

  test("a Volta-owned install prints the volta command instead of running it", async () => {
    const scratch = await scratchEnv("op-cli-update-volta-");
    const seam = spawnSeam({
      captures: { "prefix -g": "/Users/ada/.volta/tools/image/packages/npm\n" },
    });

    const result = await run(["update"], scratch.env, seam);

    expect(result).toEqual({
      stdout: "Volta manages this install. Run instead:\n"
        + "  volta install @tuanhv/op-cli@latest\n",
      stderr: "",
      exitCode: 0,
    });
    expect(seam.calls).toEqual([{ file: "npm", args: ["prefix", "-g"] }]);
  });

  test("a Homebrew-owned install prints the brew command instead of running it", async () => {
    const scratch = await scratchEnv("op-cli-update-brew-");
    const seam = spawnSeam({ captures: { "prefix -g": "/opt/homebrew\n" } });

    const result = await run(["update"], scratch.env, seam);

    expect(result).toEqual({
      stdout: "Homebrew manages this install. Run instead:\n  brew upgrade op-cli\n",
      stderr: "",
      exitCode: 0,
    });
    expect(seam.calls).toEqual([{ file: "npm", args: ["prefix", "-g"] }]);
  });

  test("a Homebrew binary is detected through which when the prefix is plain", async () => {
    const scratch = await scratchEnv("op-cli-update-brew-bin-");
    const seam = spawnSeam({
      captures: {
        "prefix -g": "/usr/local\n",
        "op-cli": "/opt/homebrew/bin/op-cli\n",
      },
    });

    const result = await run(["update"], scratch.env, seam);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("brew upgrade op-cli");
    expect(seam.calls).toEqual([
      { file: "npm", args: ["prefix", "-g"] },
      { file: "which", args: ["op-cli"] },
    ]);
  });

  test("a failing installer forwards its exit code and says so on stderr", async () => {
    const scratch = await scratchEnv("op-cli-update-failure-");
    const seam = spawnSeam({
      captures: { "prefix -g": "/usr\n" },
      installExitCode: 3,
    });

    const result = await run(["update"], scratch.env, seam);

    expect(result).toMatchObject({
      exitCode: 3,
      stderr: "The installer exited with code 3.\n",
    });
    expect(seam.calls[seam.calls.length - 1]).toEqual({
      file: "npm",
      args: ["install", "-g", "@tuanhv/op-cli@latest"],
    });
  });
});
