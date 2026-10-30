import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, test } from "vitest";

import { run } from "../src/run.js";

const INSTANCE = "https://op.example";
const ACTIVITY = "/api/v3/activities/1480";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function makeRoom(): Promise<{ configDir: string; cacheDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "op-cli-wp-comment-edit-"));
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
      profiles: { default: { url: INSTANCE } },
    }),
  );
  await writeFile(
    join(configDir, "credentials.json"),
    JSON.stringify({ default: { api_key: "secret-key" } }),
    { mode: 0o600 },
  );
  return { configDir, cacheDir };
}

function activity(
  type: "Comment" | "Revision",
  raw: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    _type: `Activity::${type}`,
    id: 1480,
    comment: { format: "markdown", raw },
    details: [],
    createdAt: "2026-08-21T09:30:12Z",
    _links: {
      self: { href: ACTIVITY },
      user: { href: "/api/v3/users/9", title: "Linh Nguyen" },
    },
    ...extra,
  };
}

interface Reply {
  readonly method: "GET" | "PATCH";
  readonly status: number;
  readonly body?: unknown;
}

/** Exactly the listed requests; anything else fails (net connect disabled). */
function installApi(replies: ReadonlyArray<Reply>): { bodies: Array<string> } {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  cleanups.push(async () => {
    await mockAgent.close();
    setGlobalDispatcher(new Agent());
  });
  const bodies: Array<string> = [];
  const pool = mockAgent.get(INSTANCE);
  for (const reply of replies) {
    pool.intercept({ path: ACTIVITY, method: reply.method }).reply((call) => {
      if (reply.method === "PATCH") {
        bodies.push(String(call.body ?? ""));
      }
      return { statusCode: reply.status, data: reply.body ?? {} };
    });
  }
  return { bodies };
}

async function runEdit(args: ReadonlyArray<string>) {
  const { configDir, cacheDir } = await makeRoom();
  return run(
    ["wp", "comment-edit", ...args],
    { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
    {},
  );
}

describe("wp comment-edit", () => {
  test("patches {comment:{raw}} and prints the updated comment", async () => {
    const { bodies } = installApi([
      { method: "GET", status: 200, body: activity("Comment", "old") },
      { method: "PATCH", status: 200, body: activity("Comment", "new text") },
    ]);

    const result = await runEdit(["1480", "new text", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(bodies.map((body) => JSON.parse(body) as unknown)).toEqual([
      { comment: { raw: "new text" } },
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: 1480,
      kind: "Comment",
      user: { id: 9, name: "Linh Nguyen" },
      comment: "new text",
    });
  });

  test("--fields narrows the output", async () => {
    installApi([
      { method: "GET", status: 200, body: activity("Comment", "old") },
      { method: "PATCH", status: 200, body: activity("Comment", "new text") },
    ]);

    const result = await runEdit(["1480", "new text", "--json", "--fields", "id,comment"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ id: 1480, comment: "new text" });
  });

  test("a bad --fields is refused before any request", async () => {
    const { bodies } = installApi([]);

    const result = await runEdit(["1480", "new text", "--fields", "nope"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^\[USAGE_ERROR\]/);
    expect(bodies).toHaveLength(0);
  });

  test("empty or blank text is a usage error, nothing is requested", async () => {
    installApi([]);

    for (const text of ["", "   "]) {
      const result = await runEdit(["1480", text]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/^\[USAGE_ERROR\]/);
    }
  });

  test("a non-numeric activity id is a usage error", async () => {
    installApi([]);

    const result = await runEdit(["abc", "text"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^\[USAGE_ERROR\]/);
  });

  test("a pure change journal is refused without a PATCH", async () => {
    const { bodies } = installApi([
      { method: "GET", status: 200, body: activity("Revision", "") },
    ]);

    const result = await runEdit(["1480", "text"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^\[USAGE_ERROR\]/);
    expect(bodies).toHaveLength(0);
  });

  test("an unknown activity is NOT_FOUND", async () => {
    installApi([{ method: "GET", status: 404, body: { message: "gone" } }]);

    const result = await runEdit(["1480", "text"]);

    expect(result.exitCode).toBe(4);
    expect(result.stderr).toMatch(/^\[NOT_FOUND\]/);
  });

  test("a 403 on the PATCH names the edit-notes permission", async () => {
    installApi([
      { method: "GET", status: 200, body: activity("Comment", "old") },
      { method: "PATCH", status: 403, body: { message: "denied" } },
    ]);

    const result = await runEdit(["1480", "text"]);

    expect(result.exitCode).toBe(8);
    expect(result.stderr).toMatch(/^\[PERMISSION_DENIED\]/);
    expect(result.stderr).toMatch(/edit notes/i);
    expect(result.stderr).not.toMatch(/auth login/);
  });

  test("a 401 on the PATCH still blames the credentials", async () => {
    installApi([
      { method: "GET", status: 200, body: activity("Comment", "old") },
      { method: "PATCH", status: 401, body: {} },
    ]);

    const result = await runEdit(["1480", "text"]);

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toMatch(/^\[AUTH_FAILED\]/);
    expect(result.stderr).toContain("auth login");
  });
});

describe("wp comments help says there is no delete (#43)", () => {
  for (const command of ["comments", "comment-edit"]) {
    test(`wp ${command} --help states that API v3 has no comment delete`, async () => {
      const { configDir, cacheDir } = await makeRoom();
      const result = await run(
        ["wp", command, "--help"],
        { OP_CLI_CONFIG_DIR: configDir, OP_CLI_CACHE_DIR: cacheDir },
        {},
      );
      expect(result.exitCode).toBe(0);
      // Commander wraps long descriptions; compare the text, not the layout.
      expect(result.stdout.replace(/\s+/g, " ")).toContain("API v3 has no comment delete");
    });
  }
});
