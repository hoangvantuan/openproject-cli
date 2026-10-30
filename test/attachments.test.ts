import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { run } from "../src/run.js";

const INSTANCE_URL = "https://openproject.example";

let root: string;
let env: Record<string, string>;
let mockAgent: MockAgent;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "op-cli-attachments-"));
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

function attachment(id: number, fileName: string, fileSize: number): Record<string, unknown> {
  return {
    _type: "Attachment",
    id,
    fileName,
    fileSize,
    contentType: "text/plain",
    description: { format: "plain", raw: "a note", html: "<p>a note</p>" },
    createdAt: "2026-09-01T08:00:00Z",
    _links: {
      self: { href: `/api/v3/attachments/${String(id)}` },
      author: { href: "/api/v3/users/7", title: "Linh Nguyen" },
      downloadLocation: { href: `/api/v3/attachments/${String(id)}/content` },
    },
  };
}

function collection(elements: unknown[]): Record<string, unknown> {
  return { _type: "Collection", total: elements.length, count: elements.length, _embedded: { elements } };
}

const pool = (): ReturnType<MockAgent["get"]> => mockAgent.get(INSTANCE_URL);

describe("wp attachments", () => {
  test("lists id, file name, size, type, author and date", async () => {
    pool().intercept({ path: "/api/v3/work_packages/12/attachments?pageSize=100", method: "GET" })
      .reply(200, collection([attachment(5, "notes.txt", 1024)]));

    const result = await run(["wp", "attachments", "12"], env, {});

    expect(result.exitCode).toBe(0);
    for (const cell of ["ID", "FILE NAME", "SIZE", "CONTENT TYPE", "AUTHOR", "CREATED",
      "notes.txt", "1024", "text/plain", "Linh Nguyen"]) {
      expect(result.stdout).toContain(cell);
    }
  });

  test("--json emits flat rows", async () => {
    pool().intercept({ path: "/api/v3/work_packages/12/attachments?pageSize=100", method: "GET" })
      .reply(200, collection([attachment(5, "notes.txt", 1024)]));

    const result = await run(["wp", "attachments", "12", "--json"], env, {});

    expect(JSON.parse(result.stdout)).toMatchObject([{
      id: 5,
      fileName: "notes.txt",
      fileSize: 1024,
      contentType: "text/plain",
      author: { id: 7, name: "Linh Nguyen" },
      createdAt: "2026-09-01T08:00:00Z",
      description: "a note",
    }]);
  });

  // ADR-0003: without --fields the JSON carries the whole flattened
  // record, including what the CLI has never heard of (roundup review S7).
  test("--json carries every field the server sent, not a projection", async () => {
    pool().intercept({ path: "/api/v3/work_packages/12/attachments?pageSize=100", method: "GET" })
      .reply(200, collection([
        { ...attachment(5, "notes.txt", 1024), status: "uploaded", digest: { algorithm: "md5", hash: "ab" } },
      ]));

    const result = await run(["wp", "attachments", "12", "--json"], env, {});

    expect(JSON.parse(result.stdout)).toMatchObject([{
      status: "uploaded",
      digest: { algorithm: "md5", hash: "ab" },
    }]);
  });

  test("a 403 is PERMISSION_DENIED and a 404 is NOT_FOUND", async () => {
    pool().intercept({ path: "/api/v3/work_packages/12/attachments?pageSize=100", method: "GET" })
      .reply(403, { message: "no" });
    pool().intercept({ path: "/api/v3/work_packages/13/attachments?pageSize=100", method: "GET" })
      .reply(404, {});

    expect((await run(["wp", "attachments", "12"], env, {})).exitCode).toBe(8);
    expect((await run(["wp", "attachments", "13"], env, {})).exitCode).toBe(4);
  });
});

describe("wp attach", () => {
  const CONFIG_PATH = "/api/v3/configuration";

  async function sampleFile(name = "notes.txt", content = "hello world"): Promise<string> {
    const path = join(root, name);
    await writeFile(path, content);
    return path;
  }

  test("uploads metadata and file as multipart and prints the record", async () => {
    const path = await sampleFile();
    pool().intercept({ path: CONFIG_PATH, method: "GET" })
      .reply(200, { maximumAttachmentFileSize: 1_000_000 });
    let form: FormData | undefined;
    let contentType: string | undefined;
    pool().intercept({ path: "/api/v3/work_packages/12/attachments", method: "POST" })
      .reply((call) => {
        form = call.body as FormData;
        contentType = (call.headers as Record<string, string>)["content-type"];
        return { statusCode: 201, data: attachment(9, "notes.txt", 11) };
      });

    const result = await run(
      ["wp", "attach", "12", path, "--description", "a note", "--json"], env, {},
    );

    expect(result.exitCode).toBe(0);
    // fetch derives the multipart boundary itself; a JSON label would break it.
    expect(contentType === undefined || contentType.startsWith("multipart/form-data")).toBe(true);
    expect(form?.get("metadata")).toBe('{"fileName":"notes.txt","description":{"raw":"a note"}}');
    const file = form?.get("file") as File;
    expect(file.name).toBe("notes.txt");
    expect(await file.text()).toBe("hello world");
    expect(JSON.parse(result.stdout)).toMatchObject({ id: 9, fileName: "notes.txt", fileSize: 11 });
  });

  // ADR-0003: --fields exists wherever a record is returned, and a bad one
  // is refused before the upload so the repeat cannot attach twice
  // (roundup review S6).
  test("--fields picks the printed columns", async () => {
    const path = await sampleFile();
    pool().intercept({ path: CONFIG_PATH, method: "GET" }).reply(200, {});
    pool().intercept({ path: "/api/v3/work_packages/12/attachments", method: "POST" })
      .reply(201, attachment(9, "notes.txt", 11));

    const result = await run(
      ["wp", "attach", "12", path, "--fields", "id,fileName", "--json"], env, {},
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ id: 9, fileName: "notes.txt" });
  });

  test("an unknown --fields name is refused before any request", async () => {
    const path = await sampleFile();

    const result = await run(["wp", "attach", "12", path, "--fields", "nope"], env, {});

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("USAGE_ERROR");
    expect(result.stderr).toContain("nope");
  });

  test("--name overrides the uploaded file name", async () => {
    const path = await sampleFile();
    pool().intercept({ path: CONFIG_PATH, method: "GET" }).reply(200, {});
    let form: FormData | undefined;
    pool().intercept({ path: "/api/v3/work_packages/12/attachments", method: "POST" })
      .reply((call) => {
        form = call.body as FormData;
        return { statusCode: 201, data: attachment(9, "renamed.txt", 11) };
      });

    const result = await run(["wp", "attach", "12", path, "--name", "renamed.txt"], env, {});

    expect(result.exitCode).toBe(0);
    expect(form?.get("metadata")).toBe('{"fileName":"renamed.txt"}');
    expect((form?.get("file") as File).name).toBe("renamed.txt");
  });

  test("a missing file is refused before any request", async () => {
    const result = await run(["wp", "attach", "12", join(root, "nope.txt")], env, {});
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("USAGE_ERROR");
  });

  test("a directory is refused before any request", async () => {
    const result = await run(["wp", "attach", "12", root], env, {});
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("USAGE_ERROR");
  });

  test("a file above the instance maximum is refused before uploading", async () => {
    const path = await sampleFile("big.bin", "x".repeat(20));
    pool().intercept({ path: CONFIG_PATH, method: "GET" })
      .reply(200, { maximumAttachmentFileSize: 10 });

    const result = await run(["wp", "attach", "12", path], env, {});

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("USAGE_ERROR");
    expect(result.stderr).toContain("10");
  });

  test("a non-numeric work package is a usage error", async () => {
    const path = await sampleFile();
    const result = await run(["wp", "attach", "abc", path], env, {});
    expect(result.exitCode).toBe(1);
  });

  test("403 and 404 map to the catalogue", async () => {
    const path = await sampleFile();
    pool().intercept({ path: CONFIG_PATH, method: "GET" }).reply(200, {}).persist();
    pool().intercept({ path: "/api/v3/work_packages/12/attachments", method: "POST" })
      .reply(403, { message: "nope" });
    pool().intercept({ path: "/api/v3/work_packages/13/attachments", method: "POST" })
      .reply(404, {});

    expect((await run(["wp", "attach", "12", path], env, {})).exitCode).toBe(8);
    expect((await run(["wp", "attach", "13", path], env, {})).exitCode).toBe(4);
  });

  test("a 5xx is never retried and reports an unknown state", async () => {
    const path = await sampleFile();
    pool().intercept({ path: CONFIG_PATH, method: "GET" }).reply(200, {});
    pool().intercept({ path: "/api/v3/work_packages/12/attachments", method: "POST" })
      .reply(500, {});

    const result = await run(["wp", "attach", "12", path], env, {});

    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain("unknown");
  });
});

describe("wp attachment-download", () => {
  const META = "/api/v3/attachments/5";
  const CONTENT = "/api/v3/attachments/5/content";

  function serve(): void {
    pool().intercept({ path: META, method: "GET" }).reply(200, attachment(5, "notes.txt", 11));
    pool().intercept({ path: CONTENT, method: "GET" }).reply(200, "hello world");
  }

  test("writes the file under its own name inside an --output directory", async () => {
    serve();
    const result = await run(["wp", "attachment-download", "5", "--output", root], env, {});

    expect(result.exitCode).toBe(0);
    expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("hello world");
    expect(result.stdout).toContain(join(root, "notes.txt"));
  });

  test("writes to an explicit --output path", async () => {
    serve();
    const target = join(root, "copy.txt");
    const result = await run(["wp", "attachment-download", "5", "--output", target, "--json"], env, {});

    expect(result.exitCode).toBe(0);
    expect(await readFile(target, "utf8")).toBe("hello world");
    expect(JSON.parse(result.stdout)).toEqual({ id: 5, fileName: "notes.txt", path: target, size: 11 });
  });

  test("refuses to overwrite without --force and leaves the file alone", async () => {
    const target = join(root, "copy.txt");
    await writeFile(target, "old");
    pool().intercept({ path: META, method: "GET" }).reply(200, attachment(5, "notes.txt", 11));

    const result = await run(["wp", "attachment-download", "5", "--output", target], env, {});

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--force");
    expect(await readFile(target, "utf8")).toBe("old");
  });

  test("--force overwrites", async () => {
    const target = join(root, "copy.txt");
    await writeFile(target, "old");
    serve();

    const result = await run(["wp", "attachment-download", "5", "--output", target, "--force"], env, {});

    expect(result.exitCode).toBe(0);
    expect(await readFile(target, "utf8")).toBe("hello world");
  });

  test("--output - streams the bytes to stdout", async () => {
    pool().intercept({ path: CONTENT, method: "GET" }).reply(200, "hello world");

    const result = await run(["wp", "attachment-download", "5", "--output", "-"], env, {});

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(Buffer.from(result.stdoutBytes ?? new Uint8Array()).toString("utf8")).toBe("hello world");
  });

  // Bytes on stdout cannot carry a JSON record, and there is no file to
  // overwrite: say so instead of ignoring the flag (roundup review S5).
  test("--output - refuses --json and --force before any request", async () => {
    for (const flag of ["--json", "--force"]) {
      const result = await run(
        ["wp", "attachment-download", "5", "--output", "-", flag], env, {},
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("USAGE_ERROR");
      expect(result.stderr).toContain(flag);
      expect(result.stdoutBytes ?? new Uint8Array()).toHaveLength(0);
    }
  });

  test("403 and 404 map to the catalogue and write nothing", async () => {
    pool().intercept({ path: META, method: "GET" }).reply(404, {});
    pool().intercept({ path: "/api/v3/attachments/6", method: "GET" })
      .reply(200, attachment(6, "secret.txt", 3));
    pool().intercept({ path: "/api/v3/attachments/6/content", method: "GET" })
      .reply(403, { message: "no" });

    expect((await run(["wp", "attachment-download", "5", "--output", root], env, {})).exitCode).toBe(4);
    expect((await run(["wp", "attachment-download", "6", "--output", root], env, {})).exitCode).toBe(8);
    await expect(stat(join(root, "secret.txt"))).rejects.toThrow();
  });

  test("a non-numeric attachment id is a usage error", async () => {
    expect((await run(["wp", "attachment-download", "abc"], env, {})).exitCode).toBe(1);
  });
});
