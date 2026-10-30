import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { run } from "../src/run.js";

const INSTANCE = "https://op.example.dev";
const ROOT = "/api/v3/notifications";
const env = { OPENPROJECT_URL: INSTANCE, OPENPROJECT_API_KEY: "test-key", OP_CLI_NO_UPDATE_CHECK: "1" };
let mock: MockAgent;
let cleanup: string[] = [];
beforeEach(() => {
  mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
});
afterEach(async () => {
  await mock.close();
  setGlobalDispatcher(new Agent());
  for (const path of cleanup) await rm(path, { recursive: true, force: true });
  cleanup = [];
});
function item(id: number, readIAN = false) {
  return { _type: "Notification", id, readIAN, subject: "A mention", reason: "mentioned",
    createdAt: "2026-01-01T00:00:00Z", details: [],
    _links: { self: { href: `${ROOT}/${id}` },
      resource: { href: "/api/v3/work_packages/42", title: "Fix login" },
      activity: { href: "/api/v3/activities/9" },
      readIAN: { href: `${ROOT}/${id}/read_ian`, method: "post" } } };
}
function page(elements: unknown[], total = elements.length, offset = 1, pageSize = 20) {
  return { _type: "Collection", total, offset, pageSize, _embedded: { elements } };
}
function listReply(body: unknown, check?: (url: URL) => void) {
  mock.get(INSTANCE).intercept({ method: "GET", path: (path) =>
    new URL(path, INSTANCE).pathname === ROOT,
  }).reply((options) => {
    // Matchers may run speculatively for other registered pages. Assert
    // only after this interceptor has actually been selected.
    check?.(new URL(options.path, INSTANCE));
    return { statusCode: 200, data: body as object };
  });
}
function get(id: number, body: object = item(id), status = 200) {
  mock.get(INSTANCE).intercept({ method: "GET", path: `${ROOT}/${id}` }).reply(status, body);
}
function parsedFilters(url: URL) {
  return JSON.parse(url.searchParams.get("filters") ?? "[]");
}
function lines(raw: string) {
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("notification reads", () => {
  test("defaults to unread, 20 results, ID desc; ignores implicit project resolution", async () => {
    listReply(page([item(7)], 42), (url) => {
      expect(parsedFilters(url)).toEqual([{ readIAN: { operator: "=", values: ["f"] } }]);
      expect(url.searchParams.get("sortBy")).toBe('[["id","desc"]]');
      expect(url.searchParams.get("pageSize")).toBe("20");
      expect(url.searchParams.get("offset")).toBe("1");
    });
    const result = await run(["notification", "list"], { ...env, OP_CLI_OUTPUT: "json", OP_CLI_PROJECT: "Missing project" }, {});
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([expect.objectContaining({ id: 7, readIAN: false,
      resource: { id: 42, name: "Fix login" }, resourceType: "WorkPackage",
      resourceHref: "/api/v3/work_packages/42", activityHref: "/api/v3/activities/9" })]);
    expect(JSON.parse(result.stderr)).toEqual({ type: "pagination", offset: 1, count: 1,
      total: 42, pageSize: 20, hasMore: true, nextOffset: 2 });
    mock.assertNoPendingInterceptors();
  });

  test("combines explicit filters and resolves project names without a default", async () => {
    mock.get(INSTANCE).intercept({ method: "GET", path: "/api/v3/projects?pageSize=100" })
      .reply(200, { _embedded: { elements: [{ id: 13, identifier: "web", name: "Website" }] } });
    listReply(page([]), (url) => expect(parsedFilters(url)).toEqual([
      { readIAN: { operator: "=", values: ["t"] } },
      { project: { operator: "=", values: ["13"] } },
      { reason: { operator: "=", values: ["mentioned", "assigned"] } },
      { resourceId: { operator: "=", values: ["42", "43"] } },
      { resourceType: { operator: "=", values: ["WorkPackage"] } },
    ]));
    const result = await run(["notification", "list", "--json", "--status", "read", "--project", "web",
      "--reason", "mentioned,assigned", "--reason", "mentioned", "--wp", "42", "--wp", "43"], env, {});
    expect(result.exitCode).toBe(0);
    mock.assertNoPendingInterceptors();
  });

  test("all states is not all pages; numeric projects need no lookup", async () => {
    listReply(page([item(4)], 100), (url) => {
      expect(parsedFilters(url)).toEqual([{ project: { operator: "=", values: ["13"] } }]);
    });
    const result = await run(["notification", "list", "--json", "--status", "all", "--project", "13"], env, {});
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveLength(1);
  });

  test("all pages preserve filters and order even with hostile next links", async () => {
    const queries: string[] = [];
    listReply({ ...page([item(8)], 2, 1, 1), _links: { nextByOffset: {
      href: "https://evil.invalid/api/v3/users?offset=2&filters=[]",
    } } }, (url) => { queries.push(url.searchParams.get("filters") ?? ""); });
    listReply(page([item(7)], 2, 2, 1), (url) => {
      expect(url.searchParams.get("offset")).toBe("2");
      expect(url.searchParams.get("sortBy")).toBe('[["id","desc"]]');
      queries.push(url.searchParams.get("filters") ?? "");
    });
    const result = await run(["notification", "list", "--json", "--all", "--limit", "1", "--wp", "42"], env, {});
    expect(result.exitCode).toBe(0);
    expect(lines(result.stdout).map((row) => row.id)).toEqual([8, 7]);
    expect(queries[0]).toBe(queries[1]);
    expect(lines(result.stderr).map((row) => row.hasMore)).toEqual([true, false]);
    mock.assertNoPendingInterceptors();
  });

  test("walks collections with total but no nextByOffset, respecting server page size", async () => {
    listReply(page([item(8)], 2, 1, 1));
    listReply(page([item(7)], 2, 2, 1));
    const result = await run(["notification", "list", "--all", "--json"], env, {});
    expect(result.exitCode).toBe(0);
    expect(lines(result.stdout)).toHaveLength(2);
    mock.assertNoPendingInterceptors();
  });

  test("supports explicit page and fields without losing pagination metadata", async () => {
    listReply(page([item(5)], 3, 2, 1), (url) => expect(url.searchParams.get("offset")).toBe("2"));
    const result = await run(["notification", "list", "--json", "--page", "2", "--limit", "1", "--fields", "id,readIAN"], env, {});
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([{ id: 5, readIAN: false }]);
    expect(JSON.parse(result.stderr).nextOffset).toBe(3);
  });

  test("rejects looping pages and malformed collections instead of claiming completeness", async () => {
    listReply({ ...page([item(1)], 2), _links: { nextByOffset: { href: `${ROOT}?offset=1` } } });
    const result = await run(["notification", "list", "--json", "--all"], env, {});
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error.code).toBe("API_ERROR");
  });

  test("retains earlier NDJSON output if a later page fails", async () => {
    listReply(page([item(8)], 2, 1, 1));
    mock.get(INSTANCE).intercept({ method: "GET", path: (path) => path.startsWith(`${ROOT}?`) }).reply(403, {});
    const result = await run(["notification", "list", "--json", "--all", "--limit", "1"], env, {});
    expect(result.exitCode).toBe(8);
    expect(lines(result.stdout)[0].id).toBe(8);
    expect(lines(result.stderr).map((row) => row.type ?? row.error.code)).toEqual(["pagination", "PERMISSION_DENIED"]);
  });

  test("get preserves custom scalar fields and nullable or polymorphic relationships", async () => {
    get(7, { ...item(7), customField1: "custom", _links: {
      resource: { href: "/api/v3/news/2", title: "News" }, activity: { href: null },
    }, _embedded: { resource: { _type: "News", id: 2 } } });
    const result = await run(["notification", "get", "7", "--json"], env, {});
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ customField1: "custom", resourceType: "News",
      resource: { id: 2, name: "News" }, activity: { id: null, name: null }, activityHref: null });
    expect(result.stdout).not.toContain("_embedded");
    mock.assertNoPendingInterceptors();
  });

  test("retains notification-owned embedded details without fetching enrichment", async () => {
    const { details: _details, ...notification } = item(7);
    void _details;
    get(7, { ...notification, _embedded: {
      details: [{ _type: "Values::Property", property: "dueDate", value: "2026-01-01",
        _links: { self: { href: `${ROOT}/7/details/0` } } }],
      resource: { _type: "WorkPackage", id: 42, description: { raw: "Not notification context" } },
    } });
    const result = await run(["notification", "get", "7", "--json"], env, {});
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).details).toEqual([{ property: "dueDate", value: "2026-01-01" }]);
    expect(result.stdout).not.toContain("Not notification context");
    mock.assertNoPendingInterceptors();
  });

  test("missing nullable resource and activity are represented honestly", async () => {
    get(7, { ...item(7), _links: { resource: { href: null }, activity: { href: null } } });
    const result = await run(["notification", "get", "7", "--json"], env, {});
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ resource: { id: null, name: null },
      resourceType: null, resourceHref: null, activityHref: null });
  });

  test("rejects repeated page contents even if the API omits its offset", async () => {
    const body = { pageSize: 1, _embedded: { elements: [item(7)] } };
    listReply(body);
    listReply(body);
    const result = await run(["notification", "list", "--all", "--json", "--limit", "1"], env, {});
    expect(result.exitCode).toBe(2);
    expect(lines(result.stdout)).toHaveLength(1);
    expect(lines(result.stderr)[1].error.message).toContain("repeated a page");
    mock.assertNoPendingInterceptors();
  });

  test("missing totals probe one more page rather than hiding possible results", async () => {
    listReply({ pageSize: 1, _embedded: { elements: [item(7)] } });
    listReply({ pageSize: 1, _embedded: { elements: [] } });
    const result = await run(["notification", "list", "--all", "--json", "--limit", "1"], env, {});
    expect(result.exitCode).toBe(0);
    expect(lines(result.stdout)).toHaveLength(1);
    expect(lines(result.stderr).map((row) => [row.total, row.hasMore])).toEqual([[null, true], [null, false]]);
    mock.assertNoPendingInterceptors();
  });

  test("unknown projected field reports usage error without output", async () => {
    get(7);
    const result = await run(["notification", "get", "7", "--json", "--fields", "missing"], env, {});
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
  });

  test("malformed list responses do not masquerade as an empty inbox", async () => {
    listReply({ message: "not a collection" });
    const result = await run(["notification", "list", "--json"], env, {});
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
  });

  test("get can project fields and never posts", async () => {
    get(7);
    const result = await run(["notification", "get", "7", "--fields", "id,subject", "--json"], env, {});
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ id: 7, subject: "A mention" });
    mock.assertNoPendingInterceptors();
  });

  test("empty inbox and human tables", async () => {
    listReply(page([]));
    const result = await run(["notification", "list"], env, {});
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("subject");
    expect(result.stderr).toContain("no more pages");
  });

  test("explicit profile beats credentials in environment and ignores stored project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "op-notification-"));
    cleanup.push(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.json"), JSON.stringify({ profiles: { personal: { url: INSTANCE, project: 99 } } }));
    await writeFile(join(dir, "credentials.json"), JSON.stringify({ personal: { api_key: "stored-key" } }));
    listReply(page([]), (url) => expect(parsedFilters(url)).toEqual([{ readIAN: { operator: "=", values: ["f"] } }]));
    const result = await run(["notification", "list", "--profile", "personal", "--json"], {
      ...env, OPENPROJECT_URL: "https://wrong.invalid", OP_CLI_CONFIG_DIR: dir,
    }, {});
    expect(result.exitCode).toBe(0);
    mock.assertNoPendingInterceptors();
  });
});

describe("notification writes", () => {
  test("mixed outcomes continue, deduplicate IDs, and retain all results with nonzero exit", async () => {
    get(1);
    mock.get(INSTANCE).intercept({ method: "POST", path: `${ROOT}/1/read_ian` }).reply(204);
    get(2, item(2, true));
    get(3, {}, 404);
    get(4);
    mock.get(INSTANCE).intercept({ method: "POST", path: `${ROOT}/4/read_ian` }).reply(204);
    const result = await run(["notification", "read", "1", "2", "3", "4", "1", "--json"], env, {});
    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.stdout).map((row: { outcome: string }) => row.outcome))
      .toEqual(["changed", "already-target", "failed", "changed"]);
    expect(JSON.parse(result.stderr).error.code).toBe("NOT_FOUND");
    mock.assertNoPendingInterceptors();
  });

  test("unread posts to the individual endpoint; already-unread only needs a read", async () => {
    get(1, item(1, true));
    mock.get(INSTANCE).intercept({ method: "POST", path: `${ROOT}/1/unread_ian` }).reply(204);
    get(2);
    const result = await run(["notification", "unread", "1", "2", "--json"], env, {});
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { id: 1, readIAN: false, outcome: "changed" }, { id: 2, readIAN: false, outcome: "already-target" },
    ]);
    mock.assertNoPendingInterceptors();
  });

  test.each([400, 403, 404, 422, 429, 500, 502, 200])("HTTP %s has an honest outcome and is not retried", async (status) => {
    get(1);
    let writes = 0;
    mock.get(INSTANCE).intercept({ method: "POST", path: `${ROOT}/1/read_ian` }).reply(() => {
      writes += 1;
      return { statusCode: status, data: {} };
    }).persist();
    const result = await run(["notification", "read", "1", "--json"], env, {});
    expect(result.exitCode).not.toBe(0);
    expect(writes).toBe(1);
    expect(JSON.parse(result.stdout)[0].outcome).toBe(status >= 500 || status < 400 ? "unknown" : "failed");
  });

  test("POST timeout is unknown, no retry, later IDs are still processed", async () => {
    get(1);
    mock.get(INSTANCE).intercept({ method: "POST", path: `${ROOT}/1/read_ian` }).reply(204).delay(100);
    get(2, item(2, true));
    const result = await run(["notification", "read", "1", "2", "--json"], { ...env, OP_CLI_TIMEOUT_MS: "20" }, {});
    expect(result.exitCode).toBe(6);
    const outcomes = JSON.parse(result.stdout);
    expect(outcomes[0]).toMatchObject({ outcome: "unknown", error: { code: "NETWORK_ERROR", timedOut: true } });
    expect(outcomes[0].error.hint).toContain("not retried");
    expect(outcomes[1].outcome).toBe("already-target");
    mock.assertNoPendingInterceptors();
  });

  test("failed pre-read is not reported as an uncertain write", async () => {
    mock.get(INSTANCE).intercept({ method: "GET", path: `${ROOT}/1` }).replyWithError(new Error("offline"));
    const result = await run(["notification", "read", "1", "--json"], env, {});
    expect(result.exitCode).toBe(6);
    expect(JSON.parse(result.stdout)[0].outcome).toBe("failed");
  });

  test.each([undefined, null, "false", 0])("never infers read state from malformed value %s", async (readIAN) => {
    get(1, { ...item(1), readIAN });
    const result = await run(["notification", "unread", "1", "--json"], env, {});
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout)[0].outcome).toBe("failed");
  });

  test("missing operation links do not prove already-target", async () => {
    get(1, { ...item(1), _links: {} });
    mock.get(INSTANCE).intercept({ method: "POST", path: `${ROOT}/1/read_ian` }).reply(404, {});
    const result = await run(["notification", "read", "1", "--json"], env, {});
    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.stdout)[0].outcome).toBe("failed");
    mock.assertNoPendingInterceptors();
  });
});

test.each([
  { command: [], phrases: ["Agent workflow", "untrusted data", "permission to mark", "work package IDs"] },
  { command: ["list"], phrases: ["Examples:", "OP_CLI_PROJECT", "Pagination is not an error", "partial stdout", "--status all"] },
  { command: ["get"], phrases: ["notification ID from list", "Viewing never marks read", "activity may be absent"] },
  { command: ["read"], phrases: ["already-target", "unknown", "before retrying", "first error's code", "not work package IDs"] },
  { command: ["unread"], phrases: ["already-target", "unknown", "before retrying", "not rolled back"] },
])("notification $command help explains safe agent usage without credentials", async ({ command, phrases }) => {
  const result = await run(["notification", ...command, "--help"], {}, {});
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  const text = result.stdout.replace(/\s+/g, " ");
  for (const phrase of phrases) expect(text).toContain(phrase);
});

test.each([
  ["list", "--status", "bogus"], ["list", "--limit", "0"], ["list", "--page", "-1"],
  ["list", "--limit", "9007199254740992"], ["list", "--wp", "x"],
  ["list", "--reason", "mentioned,"], ["list", "--project", "0"],
  ["list", "--project", ""], ["get", "0"], ["get", "1", "--fields", ""],
  ["read", "1", "bad"], ["unread", "-1"], ["read"], ["read", "1", "--all"],
])("rejects invalid input without needing credentials: %j", async (...args) => {
  const result = await run(["notification", ...args], {}, {});
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("USAGE_ERROR");
});
