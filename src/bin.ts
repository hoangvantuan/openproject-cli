#!/usr/bin/env node

import { createInterface } from "node:readline/promises";

import { run } from "./run.js";

const readline = createInterface({
  input: process.stdin,
  output: process.stdout,
});

try {
  const result = await run(process.argv.slice(2), process.env, {
    prompt: async (message) => readline.question(message),
    isTTY: process.stdout.isTTY,
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
} finally {
  readline.close();
}
