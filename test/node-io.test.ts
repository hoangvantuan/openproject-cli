import { describe, expect, test } from "vitest";
import { PassThrough } from "node:stream";

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
});
