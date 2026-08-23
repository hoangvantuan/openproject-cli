#!/usr/bin/env node

import { createInterface, type Interface } from "node:readline/promises";

import { run } from "./run.js";

// Created lazily so a command reading stdin (--stdin) never competes with
// an interactive prompt over the same stream.
let readline: Interface | undefined;

try {
  const result = await run(process.argv.slice(2), process.env, {
    prompt: async (message) => {
      readline ??= createInterface({ input: process.stdin, output: process.stdout });
      return readline.question(message);
    },
    readStdin: async () => {
      const chunks: Array<Uint8Array> = [];
      for await (const chunk of process.stdin) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      return Buffer.concat(chunks).toString("utf8");
    },
    isTTY: process.stdout.isTTY,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
} finally {
  readline?.close();
}
