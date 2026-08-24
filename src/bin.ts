#!/usr/bin/env node

import { createNodeIo } from "./io/node-io.js";
import { run } from "./run.js";

/** 128 + 13: the exit status a shell reports for a process killed by SIGPIPE. */
const EXIT_SIGPIPE = 141;

/**
 * Node ignores SIGPIPE, so writing after a pipe consumer is gone (`op-cli
 * wp list | head`) surfaces as an EPIPE stream error. Without a listener
 * that error escalates to an uncaught exception with a stack trace; exit
 * quietly instead, and let every other write error keep crashing as before.
 */
function exitOnBrokenPipe(stream: NodeJS.WriteStream): void {
  stream.once("error", (error) => {
    if ((error as NodeJS.ErrnoException).code === "EPIPE") {
      process.exit(EXIT_SIGPIPE);
    }
    throw error;
  });
}

exitOnBrokenPipe(process.stdout);
exitOnBrokenPipe(process.stderr);

const result = await run(process.argv.slice(2), process.env, createNodeIo());
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
