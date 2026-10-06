import { describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";

import { createNodeIo } from "../src/io/node-io.js";

describe("node io contract", () => {
  test("a prompt settles with a catalogued error when stdin reaches EOF", async () => {
    const input = new PassThrough();
    const io = createNodeIo(input, new PassThrough());

    const pending = io.prompt("Instance URL: ", false);
    input.end();

    await expect(pending).rejects.toThrow("stdin closed while waiting for input");
  });

  test("a secret prompt never echoes the typed answer", async () => {
    const input = new PassThrough();
    const echoed: Array<string> = [];
    const output = new PassThrough();
    output.on("data", (chunk) => {
      echoed.push(chunk.toString());
    });
    const io = createNodeIo(input, output);

    const pending = io.prompt("API key: ", true);
    input.write("s3cret-key\r");
    const apiKey = await pending;

    expect(apiKey).toBe("s3cret-key");
    const transcript = echoed.join("");
    expect(transcript).toContain("API key: ");
    expect(transcript).not.toContain("s3cret-key");
  });

  test("a secret prompt settles when stdin reaches EOF mid-entry", async () => {
    const input = new PassThrough();
    const io = createNodeIo(input, new PassThrough());

    const pending = io.prompt("API key: ", true);
    input.write("half");
    input.end();

    await expect(pending).rejects.toThrow("stdin closed while waiting for input");
  });

  test("stdinIsTTY reports the TTY state of the input stream", () => {
    const ttyInput = Object.assign(new PassThrough(), { isTTY: true });

    expect(createNodeIo(ttyInput, new PassThrough()).stdinIsTTY).toBe(true);
    expect(createNodeIo(new PassThrough(), new PassThrough()).stdinIsTTY).toBe(false);
  });

  // A PassThrough has no libuv handle, so it cannot show this: readline's
  // close() pauses a real socket-backed stdin and stops its handle, and a
  // later async iterator never restarts it. The event loop then drains and
  // Node aborts the top-level await (exit 13) at the "API key: " prompt.
  test("a secret prompt after a line prompt still reads a real stdin", async () => {
    const nodeIo = pathToFileURL(resolve("dist/io/node-io.js")).href;
    const script = `
      import { createNodeIo } from ${JSON.stringify(nodeIo)};
      const io = createNodeIo();
      const url = await io.prompt("Instance URL: ", false);
      const key = await io.prompt("API key: ", true);
      process.stderr.write(JSON.stringify({ url, key }));
    `;

    const result = await new Promise<{ stderr: string; exitCode: number | null }>(
      (resolveResult, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let answered = 0;
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          if (answered === 0 && stdout.includes("Instance URL: ")) {
            answered = 1;
            child.stdin.write("https://op.example\n");
          }
          if (answered === 1 && stdout.includes("API key: ")) {
            answered = 2;
            // Answer late, so the process must stay alive while it waits.
            setTimeout(() => child.stdin.write("s3cret-key\n"), 100);
          }
        });
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (exitCode) => {
          resolveResult({ stderr, exitCode });
        });
      },
    );

    expect(result.stderr).not.toContain("unsettled top-level await");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stderr)).toEqual({
      url: "https://op.example",
      key: "s3cret-key",
    });
  });
});
