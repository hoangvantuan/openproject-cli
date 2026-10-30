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
  // The write paths of #43-#49 all walk through in a dry run.
  for (const step of [
    "edit the comment on work package",
    "set, then clear, start and due dates",
    "set, then clear, estimate and remaining work",
    "set, then clear, percent complete",
    "set, then clear, story points",
    "set, then clear, the accountable",
    "set, then clear, version 'dry version' (targetVersions)",
    "set, then clear, observed-in 'dry version'",
    "place work package",
    "(clear, then set)",
    "clear the bucket of work package",
  ]) expect(result.stdout, step).toContain(step);
});

test.each(["", "0", "-1", "test", "12;echo bad"])("invalid smoke project %j fails before any command", (project) => {
  const result = spawnSync("bash", [script], {
    env: { ...process.env, OP_CLI_SMOKE_DRY: "1", OP_CLI_SMOKE_PROJECT: project }, encoding: "utf8",
  });
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("positive numeric project ID");
});

// A stateful stand-in for op-cli: writes land in a record that `wp get`
// reads back, so the smoke gate's read-back checks run for real. IGNORE
// names a flag whose write the fake accepts and drops; WRITABLE restricts
// the schema; NO_VOCAB makes the meta lookups fail as a 403 would.
const FAKE_CLI = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SMOKE_LOG, JSON.stringify(args)+'\\n');
const cmd = args.slice(0,2).join(' ');
if(cmd===process.env.FAIL_AT) process.exit(13);
if(cmd==='time delete' && process.env.FAIL_CLEANUP==='1') process.exit(9);
const value = flag => args[args.indexOf(flag)+1];
const stateFile = process.env.SMOKE_LOG + '.state';
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile,'utf8')) : { wp:{}, comments:[] };
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
const link = name => name === '' ? {id:null,name:null} : {id:7,name};
const scalar = {'--start':'startDate','--due':'dueDate','--story-points':'storyPoints','--done':'percentageDone'};
const duration = {'--estimate':'estimatedTime','--remaining':'remainingTime'};
const links = {'--accountable':'responsible','--sprint':'sprint','--bucket':'backlogBucket','--version':'version'};
const lists = {'--version':'targetVersions','--observed-in':'observedInVersions'};
const fields = ['startDate','dueDate','estimatedTime','remainingTime','percentageDone','storyPoints',
  'responsible','version','targetVersions','observedInVersions','sprint','backlogBucket'];
let data={};
if(cmd==='project get')data={id:12};
if(cmd==='wp create'){state.wp={id:501,description:{raw:value('--description')}};data=state.wp;}
if(cmd==='wp update'){
  state.wp.subject=value('--subject');
  state.wp.description={raw:value('--description')};
  args.forEach((flag,i)=>{
    const given=args[i+1];
    if(flag===process.env.IGNORE) return;
    if(scalar[flag]) state.wp[scalar[flag]]=given===''?null:given;
    if(duration[flag]) state.wp[duration[flag]]=given===''?null:'PT'+given.toUpperCase();
    if(links[flag]) state.wp[links[flag]]=link(given);
    if(lists[flag]) state.wp[lists[flag]]=given===''?[]:[link(given)];
  });
  data=state.wp;
}
if(cmd==='wp get')data=state.wp;
if(cmd==='wp schema'){
  const allowed=(process.env.WRITABLE||fields.join(',')).split(',');
  data=fields.map(field=>({field,writable:allowed.includes(field)}));
}
if(cmd==='wp comment')state.comments.push({id:9,comment:args[3]});
if(cmd==='wp comment-edit')state.comments.forEach(c=>{if(String(c.id)===args[2])c.comment=args[3];});
if(cmd==='wp comments')data=state.comments;
if(args[0]==='meta'&&['versions','sprints','buckets'].includes(args[1])){
  if(process.env.NO_VOCAB==='1')process.exit(1);
  data=[{id:1,name:'first '+args[1],status:'open'}];
}
if(cmd==='meta activities')data=[{id:1,name:'Development'}];
if(cmd==='time log')data={id:701};
save();
console.log(JSON.stringify(data));
`;

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
    await writeFile(bin, FAKE_CLI, { mode: 0o700 });
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

// Success and failure of the write-path steps against the stateful fake.
test.each([
  { name: "everything available", env: {}, log: ["--accountable", "--story-points", "--sprint", "--bucket", "--version", "--observed-in"] },
  { name: "optional fields missing", env: { WRITABLE: "startDate,dueDate", NO_VOCAB: "1" }, skipped: ["skip: estimatedTime/remainingTime", "skip: percentageDone", "skip: storyPoints", "skip: responsible", "no versions visible", "no usable sprints or buckets"] },
])("write-path steps run or skip cleanly: $name", async ({ env, log, skipped }) => {
  const dir = await mkdtemp(join(tmpdir(), "op-smoke-test-"));
  try {
    const bin = join(dir, "fake-cli.cjs");
    const commands = join(dir, "commands.jsonl");
    await writeFile(bin, FAKE_CLI, { mode: 0o700 });
    const result = spawnSync("bash", [script], {
      env: { ...process.env, OP_CLI_SMOKE_DRY: "0", OP_CLI_SMOKE_PROJECT: "12", OP_CLI_SMOKE_BIN: bin,
        OPENPROJECT_URL: "https://unused.invalid", OPENPROJECT_API_KEY: "fake", SMOKE_LOG: commands, ...env },
      encoding: "utf8", timeout: 30000,
    });
    // The final live-only HTTP oracle (wp count) cannot be served by the
    // fake; everything before it must have passed.
    expect(result.stderr).not.toContain("FAIL at step: set");
    expect(result.stderr).not.toContain("FAIL at step: edit");
    expect(result.stderr).not.toContain("FAIL at step: place");
    expect(result.stderr).not.toContain("FAIL at step: move");
    expect(result.stderr).not.toContain("FAIL at step: clear");
    const ran: string[][] = (await readFile(commands, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(ran).toContainEqual(["wp", "comment-edit", "9", "smoke comment **C2**"]);
    for (const flag of log ?? []) expect(ran.some((args) => args.includes(flag)), flag).toBe(true);
    for (const line of skipped ?? []) expect(result.stdout).toContain(line);
    if (log !== undefined) expect(ran).toContainEqual(["wp", "update", "501", "--sprint", "", "--json"]);
    expect(ran).toContainEqual(["wp", "delete", "501", "--yes"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test.each([
  { ignore: "--story-points", step: "story points" },
  { ignore: "--accountable", step: "the accountable" },
  { ignore: "--bucket", step: "bucket" },
  { ignore: "--observed-in", step: "observed-in" },
])("a dropped $ignore write fails the gate at its step", async ({ ignore, step }) => {
  const dir = await mkdtemp(join(tmpdir(), "op-smoke-test-"));
  try {
    const bin = join(dir, "fake-cli.cjs");
    await writeFile(bin, FAKE_CLI, { mode: 0o700 });
    const result = spawnSync("bash", [script], {
      env: { ...process.env, OP_CLI_SMOKE_DRY: "0", OP_CLI_SMOKE_PROJECT: "12", OP_CLI_SMOKE_BIN: bin,
        OPENPROJECT_URL: "https://unused.invalid", OPENPROJECT_API_KEY: "fake",
        SMOKE_LOG: join(dir, "commands.jsonl"), IGNORE: ignore },
      encoding: "utf8", timeout: 30000,
    });
    expect(result.status, result.stderr).toBe(3);
    expect(result.stderr).toContain("FAIL at step:");
    expect(result.stderr).toContain(step);
    expect(result.stderr).toContain("smoke: wp get reads");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
