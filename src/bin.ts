#!/usr/bin/env node

import { createNodeIo } from "./io/node-io.js";
import { run } from "./run.js";

const result = await run(process.argv.slice(2), process.env, createNodeIo());
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
