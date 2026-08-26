import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "vitest";

import { run } from "../src/run.js";

const SKILL_PATH = join("skills", "op-cli", "SKILL.md");

/**
 * One problem found in the skill. The checker never throws: callers get
 * every problem at once so a drifted skill is fixed in one pass.
 */
interface Problem {
  readonly line: string;
  readonly detail: string;
}

/** Split fenced ```sh blocks into their command lines. */
function shellLines(content: string): Array<string> {
  const lines: Array<string> = [];
  let inside = false;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      inside = line.startsWith("```sh");
      continue;
    }
    if (inside && line !== "" && !line.startsWith("#")) {
      lines.push(line.replace(/^\$\s+/, ""));
    }
  }
  return lines;
}

/**
 * Whether `argv --help` shows THIS command's help: an unknown
 * subcommand also exits 0 but prints its parent's help instead. The
 * usage line names the real owner.
 */
async function helpOf(argv: ReadonlyArray<string>): Promise<{
  ok: boolean;
  stdout: string;
}> {
  const result = await run([...argv, "--help"], {}, {});
  const usage = result.stdout.split("\n").find((line) => line.startsWith("Usage:")) ?? "";
  const named = `op-cli ${argv.join(" ")}`;
  return {
    ok: result.exitCode === 0 && result.stderr === "" && usage.includes(named),
    stdout: result.stdout,
  };
}

/** Declared long flags of a help text mapped to whether they take a value. */
function declaredFlags(help: string): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  for (
    const match of help.matchAll(
      /^ {2}(?:-\w, )?(--[a-z][a-z-]*)( +<[^>]+>)?(?:\s|$)/gm,
    )
  ) {
    flags[match[1]] = match[2] !== undefined;
  }
  return flags;
}

/** Positional placeholders (`<id>`, `[subject]`) on the usage line. */
function positionalCount(help: string): number {
  const usage = help.split("\n").find((line) => line.startsWith("Usage:")) ?? "";
  return [...usage.matchAll(/[[<](?!options\b|command\b)[^\]>]+[\]>]/g)].length;
}

/** One op-cli invocation, pipeline stages already split off. */
async function checkCommand(line: string): Promise<Array<Problem>> {
  const tokens = line.split(/\s+/).slice(1);
  // The command path is the longest dash-free prefix that answers
  // --help: a flag would also exit 0 while meaning nothing as a path.
  let depth = 0;
  for (const token of tokens) {
    if (token.startsWith("-")) {
      break;
    }
    if ((await helpOf(tokens.slice(0, depth + 1))).ok) {
      depth += 1;
    } else {
      break;
    }
  }
  if (depth === 0) {
    return [{ line, detail: `unknown command: ${tokens[0]}` }];
  }

  const path = tokens.slice(0, depth);
  const { stdout: help } = await helpOf(path);
  const flags = declaredFlags(help);
  let positionalsLeft = positionalCount(help);
  const problems: Array<Problem> = [];
  let expectsValue = false;
  for (const token of tokens.slice(depth)) {
    if (expectsValue) {
      expectsValue = false;
      continue;
    }
    if (token.startsWith("--")) {
      const takesValue = flags[token];
      if (takesValue === undefined) {
        problems.push({
          line,
          detail: `unknown flag ${token} for ${path.join(" ")}`,
        });
      } else {
        expectsValue = takesValue;
      }
      continue;
    }
    if (positionalsLeft > 0) {
      positionalsLeft -= 1;
      continue;
    }
    problems.push({ line, detail: `unexpected argument ${token} for ${path.join(" ")}` });
  }
  return problems;
}

async function checkLine(line: string): Promise<Array<Problem>> {
  if (line.startsWith("export ")) {
    const knownExports = [
      "export OP_CLI_OUTPUT=json",
      "export OP_CLI_NO_UPDATE_CHECK=1",
    ];
    return knownExports.includes(line)
      ? []
      : [{ line, detail: `unknown export: ${line}` }];
  }
  // A pipeline is validated on its op-cli stages; other stages are shell.
  const commands = line
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("op-cli "));
  if (commands.length === 0) {
    return [{ line, detail: "not an op-cli command" }];
  }
  const problems: Array<Problem> = [];
  for (const command of commands) {
    problems.push(...(await checkCommand(command)));
  }
  return problems;
}

async function checkSkill(content: string): Promise<Array<Problem>> {
  const problems: Array<Problem> = [];
  for (const line of shellLines(content)) {
    problems.push(...(await checkLine(line)));
  }
  return problems;
}

test("every command and flag mentioned in SKILL.md exists", async () => {
  const content = await readFile(SKILL_PATH, "utf8");
  expect(content).toMatch(/^---\nname: op-cli\n/);
  const problems = await checkSkill(content);
  expect(problems).toEqual([]);
});

test("the checker catches a fabricated command and flag", async () => {
  const content = await readFile(SKILL_PATH, "utf8");
  const mutated =
    `${content}\n\`\`\`sh\n`
    + "op-cli wp lst\n"
    + "op-cli bogus list\n"
    + "op-cli wp list --nonexistent\n"
    + "```\n";
  const details = (await checkSkill(mutated)).map((problem) => problem.detail);
  expect(details).toContain("unexpected argument lst for wp");
  expect(details).toContain("unknown command: bogus");
  expect(details).toContain("unknown flag --nonexistent for wp list");
});
