import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, test } from "vitest";

import { run } from "../src/run.js";
import {
  baseMetadata,
  INSTANCE,
  projectVocabulary,
} from "./fixtures/metadata.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function room(): Promise<{ configDir: string; cacheDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "op-cli-wp-create-no-watch-"));
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
  const dir = join(cacheDir, "default");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "metadata.json"),
    JSON.stringify({
      ...baseMetadata(),
      projectScoped: { "13": projectVocabulary({ "2": [], "6": [] }) },
    }),
  );
  return { configDir, cacheDir };
}

function createdElement(id: number, subject: string): Record<string, unknown> {
  return {
    _type: "WorkPackage",
    id,
    lockVersion: 1,
    subject,
    createdAt: "2026-08-23T09:00:00Z",
    updatedAt: "2026-08-23T09:00:00Z",
    _links: {
      self: { href: `/api/v3/work_packages/${String(id)}` },
      project: { href: "/api/v3/projects/13", title: "Operations" },
      type: { href: "/api/v3/types/2", title: "Task" },
      status: { href: "/api/v3/statuses/1", title: "In progress" },
    },
  };
}

interface Reply {
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  readonly status?: number;
  readonly body?: unknown;
  /** Fail the connection instead of answering. */
  readonly networkError?: boolean;
}

interface Call {
  readonly method: string;
  readonly path: string;
}

const ME = { _type: "User", id: 5, name: "Tuan Ha", login: "tuan" };

/**
 * Exactly the listed requests, each consumed once. Any other request fails
 * the run (net connect disabled), so a green assertion proves the traffic
 * that did happen is all the traffic there was.
 */
function installApi(replies: ReadonlyArray<Reply>): { calls: Array<Call> } {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  cleanups.push(async () => {
    await mockAgent.close();
    setGlobalDispatcher(new Agent());
  });
  const calls: Array<Call> = [];
  const pool = mockAgent.get(INSTANCE);
  for (const reply of replies) {
    const scope = pool.intercept({ method: reply.method, path: reply.path });
    if (reply.networkError === true) {
      scope.replyWithError(new Error("socket hang up"));
      continue;
    }
    scope.reply(() => {
      calls.push({ method: reply.method, path: reply.path });
      return { statusCode: reply.status ?? 200, data: reply.body ?? {} };
    });
  }
  return { calls };
}

const POST_WP: Reply = { method: "POST", path: "/api/v3/work_packages", status: 201 };
const GET_ME: Reply = { method: "GET", path: "/api/v3/users/me", body: ME };
const unwatch = (id: number, status = 204): Reply => ({
  method: "DELETE",
  path: `/api/v3/work_packages/${String(id)}/watchers/5`,
  status,
});

async function runCreate(
  args: ReadonlyArray<string>,
  stdin?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { configDir, cacheDir } = await room();
  return run(
    ["wp", "create", ...args],
    { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
    stdin === undefined ? {} : { readStdin: async () => stdin },
  );
}

function ndjson(stdout: string): Array<Record<string, unknown>> {
  return stdout.split("\n").filter((line) => line !== "").map((line) =>
    JSON.parse(line) as Record<string, unknown>
  );
}

describe("wp create --no-watch", () => {
  test("sends exactly one DELETE after the POST for the authenticated user and reports watching false", async () => {
    const { calls } = installApi([
      { ...POST_WP, body: createdElement(900, "Quiet") },
      GET_ME,
      unwatch(900),
    ]);
    const result = await runCreate(["Quiet", "--no-watch", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ id: 900, watching: false });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/v3/work_packages",
      "GET /api/v3/users/me",
      "DELETE /api/v3/work_packages/900/watchers/5",
    ]);
  });

  test("the human table gains a watching row", async () => {
    installApi([{ ...POST_WP, body: createdElement(901, "Quiet") }, GET_ME, unwatch(901)]);
    const result = await runCreate(["Quiet", "--no-watch"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/watching\s+false/);
  });

  test("without the flag no DELETE is sent and the record has no watching key", async () => {
    const { calls } = installApi([{ ...POST_WP, body: createdElement(902, "Loud") }]);
    const result = await runCreate(["Loud", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).not.toHaveProperty("watching");
    expect(calls.map((call) => call.method)).toEqual(["POST"]);
  });

  test("a failed DELETE still prints the record, warns on stderr, reports watching null and exits 0", async () => {
    installApi([
      { ...POST_WP, body: createdElement(903, "Quiet") },
      GET_ME,
      unwatch(903, 403),
    ]);
    const result = await runCreate(["Quiet", "--no-watch", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ id: 903, watching: null });
    expect(result.stderr).toContain(
      "work package 903 was created, but removing you from its watchers failed:",
    );
  });

  test("a network error on the DELETE is a warning, not a failure", async () => {
    installApi([
      { ...POST_WP, body: createdElement(904, "Quiet") },
      GET_ME,
      { ...unwatch(904), networkError: true },
    ]);
    const result = await runCreate(["Quiet", "--no-watch", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ id: 904, watching: null });
    expect(result.stderr).toContain("work package 904 was created, but removing you");
    expect(result.stderr).toContain("op-cli wp watchers 904");
  });

  test("a failed identity lookup after the create is also a warning", async () => {
    installApi([
      { ...POST_WP, body: createdElement(905, "Quiet") },
      { ...GET_ME, status: 401 },
    ]);
    const result = await runCreate(["Quiet", "--no-watch", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ id: 905, watching: null });
    expect(result.stderr).toContain("work package 905 was created, but removing you");
  });

  test("a bad --fields name after a clean unwatch says the work package was created, not watching", async () => {
    installApi([{ ...POST_WP, body: createdElement(906, "Quiet") }, GET_ME, unwatch(906)]);
    const result = await runCreate(["Quiet", "--no-watch", "--fields", "nope"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("work package 906 was created, not watching;");
  });

  test("a bad --fields name after a failed unwatch still says the work package was created", async () => {
    installApi([
      { ...POST_WP, body: createdElement(907, "Quiet") },
      GET_ME,
      unwatch(907, 500),
    ]);
    const result = await runCreate(["Quiet", "--no-watch", "--fields", "nope"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("work package 907 was created;");
  });
});

describe("wp create --stdin watch handling", () => {
  test("--no-watch removes the watcher on every item and looks the user up once", async () => {
    const { calls } = installApi([
      { ...POST_WP, body: createdElement(101, "A") },
      GET_ME,
      unwatch(101),
      { ...POST_WP, body: createdElement(102, "B") },
      unwatch(102),
    ]);
    const result = await runCreate(
      ["--stdin", "--no-watch"],
      JSON.stringify([{ subject: "A" }, { subject: "B" }]),
    );
    expect(result.exitCode).toBe(0);
    expect(ndjson(result.stdout)).toEqual([
      { index: 0, ok: true, status: "created", id: 101, subject: "A", watching: false },
      { index: 1, ok: true, status: "created", id: 102, subject: "B", watching: false },
    ]);
    expect(calls.filter((call) => call.path === "/api/v3/users/me")).toHaveLength(1);
  });

  test("a per-item watch false removes the watcher without the flag; other items keep today's shape", async () => {
    const { calls } = installApi([
      { ...POST_WP, body: createdElement(101, "A") },
      GET_ME,
      unwatch(101),
      { ...POST_WP, body: createdElement(102, "B") },
    ]);
    const result = await runCreate(
      ["--stdin"],
      JSON.stringify([{ subject: "A", watch: false }, { subject: "B" }]),
    );
    expect(result.exitCode).toBe(0);
    expect(ndjson(result.stdout)).toEqual([
      { index: 0, ok: true, status: "created", id: 101, subject: "A", watching: false },
      { index: 1, ok: true, status: "created", id: 102, subject: "B" },
    ]);
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  });

  test("a per-item watch true overrides --no-watch", async () => {
    const { calls } = installApi([
      { ...POST_WP, body: createdElement(101, "A") },
      { ...POST_WP, body: createdElement(102, "B") },
      GET_ME,
      unwatch(102),
    ]);
    const result = await runCreate(
      ["--stdin", "--no-watch"],
      JSON.stringify([{ subject: "A", watch: true }, { subject: "B" }]),
    );
    expect(result.exitCode).toBe(0);
    expect(ndjson(result.stdout)).toEqual([
      { index: 0, ok: true, status: "created", id: 101, subject: "A" },
      { index: 1, ok: true, status: "created", id: 102, subject: "B", watching: false },
    ]);
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  });

  test("a failed removal reports watching null, warns, keeps status created and exits 0 without stopping --fail-fast", async () => {
    installApi([
      { ...POST_WP, body: createdElement(101, "A") },
      GET_ME,
      unwatch(101, 403),
      { ...POST_WP, body: createdElement(102, "B") },
      unwatch(102),
    ]);
    const result = await runCreate(
      ["--stdin", "--no-watch", "--fail-fast"],
      JSON.stringify([{ subject: "A" }, { subject: "B" }]),
    );
    expect(result.exitCode).toBe(0);
    expect(ndjson(result.stdout)).toEqual([
      { index: 0, ok: true, status: "created", id: 101, subject: "A", watching: null },
      { index: 1, ok: true, status: "created", id: 102, subject: "B", watching: false },
    ]);
    expect(result.stderr).toContain(
      "work package 101 was created, but removing you from its watchers failed:",
    );
  });

  test("a create response without a numeric id sends no DELETE, reports watching null and warns", async () => {
    const { calls } = installApi([
      { ...POST_WP, body: { ...createdElement(1, "A"), id: undefined } },
    ]);
    const result = await runCreate(["--stdin", "--no-watch"], JSON.stringify([{ subject: "A" }]));
    expect(result.exitCode).toBe(0);
    expect(ndjson(result.stdout)[0]).toMatchObject({ ok: true, status: "created", watching: null });
    expect(result.stderr).toContain(
      "warning: work package was created without a numeric id; cannot remove you from its watchers.",
    );
    expect(calls.map((call) => call.method)).toEqual(["POST"]);
  });

  test("--dry-run validates watch and sends no request at all", async () => {
    const { calls } = installApi([]);
    const result = await runCreate(
      ["--stdin", "--dry-run", "--no-watch"],
      JSON.stringify([{ subject: "A", watch: false }]),
    );
    expect(result.exitCode).toBe(0);
    expect(ndjson(result.stdout)).toEqual([
      { index: 0, ok: true, status: "would-create", subject: "A" },
    ]);
    expect(calls).toEqual([]);
  });

  test("a non-boolean watch is refused with USAGE_ERROR before any request", async () => {
    const { calls } = installApi([]);
    const result = await runCreate(
      ["--stdin"],
      JSON.stringify([{ subject: "A", watch: "no" }]),
    );
    expect(result.exitCode).toBe(1);
    expect(ndjson(result.stdout)[0]).toMatchObject({
      index: 0,
      ok: false,
      code: "USAGE_ERROR",
    });
    expect(calls).toEqual([]);
  });
});
