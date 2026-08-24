import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "vitest";

test("the built op-cli binary runs directly through its shebang", async () => {
  const binary = resolve("dist/bin.js");
  expect((await stat(binary)).mode & 0o111).not.toBe(0);

  const result = await new Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
  }>((resolveResult, reject) => {
    const child = spawn(binary, ["--help"], {
      env: {
        ...process.env,
        OP_CLI_CONFIG_DIR: resolve(".tmp-smoke-config"),
        OP_CLI_CACHE_DIR: resolve(".tmp-smoke-cache"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolveResult({ stdout, stderr, exitCode });
    });
  });

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Usage: op-cli");
  expect(result.stdout).toContain("auth");
});

test("piping stdout into a closed consumer exits 141 without a stack trace", async () => {
  const binary = resolve("dist/bin.js");

  const result = await new Promise<{
    stderr: string;
    exitCode: number | null;
  }>((resolveResult, reject) => {
    const child = spawn(binary, ["--help"], {
      env: {
        ...process.env,
        OP_CLI_CONFIG_DIR: resolve(".tmp-smoke-config"),
        OP_CLI_CACHE_DIR: resolve(".tmp-smoke-cache"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Closing the read end immediately is what `op-cli ... | head -1` does
    // when head exits first: the child's buffered flush hits EPIPE.
    child.stdout.destroy();
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolveResult({ stderr, exitCode });
    });
  });

  expect(result.exitCode).toBe(141);
  expect(result.stderr).toBe("");
});
