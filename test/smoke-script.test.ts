import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

const script = join(process.cwd(), "scripts/smoke.sh");

test.each([undefined, "12"])("smoke dry mode supports scope %s without live writes", (project) => {
  const env: NodeJS.ProcessEnv = { ...process.env, OP_CLI_SMOKE_DRY: "1" };
  delete env.OP_CLI_SMOKE_PROJECT;
  if (project !== undefined) env.OP_CLI_SMOKE_PROJECT = project;
  const result = spawnSync("bash", [script], { env, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("dry simulation coherent");
  if (project !== undefined) {
    expect(result.stdout).toContain("existing project 12");
    expect(result.stdout).not.toContain("create scratch project");
    expect(result.stdout).not.toContain("star and unstar");
  } else expect(result.stdout).toContain("create scratch project");
});

test.each(["", "0", "-1", "test", "12;echo bad"])("invalid smoke project %j fails before any command", (project) => {
  const result = spawnSync("bash", [script], {
    env: { ...process.env, OP_CLI_SMOKE_DRY: "1", OP_CLI_SMOKE_PROJECT: project }, encoding: "utf8",
  });
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("positive numeric project ID");
});

// Fail before the smoke script's HTTP oracle: every CLI command is recorded,
// proving cleanup touches only records created by this particular run.
test.each([
  { fail: "wp update", cleanupFail: false, timeCreated: false },
  { fail: "time update", cleanupFail: false, timeCreated: true },
  { fail: "time update", cleanupFail: true, timeCreated: true },
])("scoped failure cleans owned records: $fail cleanupFail=$cleanupFail", async ({ fail, cleanupFail, timeCreated }) => {
  const dir = await mkdtemp(join(tmpdir(), "op-smoke-test-"));
  try {
    const bin = join(dir, "fake-cli.cjs");
    const log = join(dir, "commands.jsonl");
    await writeFile(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SMOKE_LOG, JSON.stringify(args)+'\\n');
const cmd = args.slice(0,2).join(' ');
if(cmd===process.env.FAIL_AT) process.exit(13);
if(cmd==='time delete' && process.env.FAIL_CLEANUP==='1') process.exit(9);
const value = flag => args[args.indexOf(flag)+1];
let data={};
if(cmd==='project get')data={id:12};
if(cmd==='wp create')data={id:501,description:{raw:value('--description')}};
if(cmd==='wp update')data={id:501,subject:value('--subject'),description:{raw:value('--description')}};
if(cmd==='wp comments')data=[{comment:'smoke comment **C**'}];
if(cmd==='meta activities')data=[{id:1,name:'Development'}];
if(cmd==='time log')data={id:701};
console.log(JSON.stringify(data));
`, { mode: 0o700 });
    const result = spawnSync("bash", [script], {
      env: { ...process.env, OP_CLI_SMOKE_DRY: "0", OP_CLI_SMOKE_PROJECT: "12",
        OP_CLI_SMOKE_BIN: bin, OPENPROJECT_URL: "https://unused.invalid", OPENPROJECT_API_KEY: "fake",
        SMOKE_LOG: log, FAIL_AT: fail, FAIL_CLEANUP: cleanupFail ? "1" : "0" },
      encoding: "utf8", timeout: 20000,
    });
    expect(result.status, result.stderr).toBe(13);
    const commands: string[][] = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(commands.filter((args) => args[0] === "project")).toEqual([["project", "get", "12", "--json"]]);
    const creates = commands.filter((args) => args[0] === "wp" && args[1] === "create");
    expect(creates).toHaveLength(1);
    expect(creates[0]?.slice(creates[0].indexOf("--project"), creates[0].indexOf("--project") + 2)).toEqual(["--project", "12"]);
    expect(commands).toContainEqual(["wp", "delete", "501", "--yes"]);
    expect(commands.filter((args) => args[0] === "time" && args[1] === "delete"))
      .toEqual(timeCreated ? [["time", "delete", "701", "--yes"]] : []);
    if (cleanupFail) expect(result.stderr).toContain("cleanup failed for created time entry 701");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
