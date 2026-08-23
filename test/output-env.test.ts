import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MockAgent, setGlobalDispatcher } from "undici";
import { expect, test } from "vitest";

import { run } from "../src/run.js";

test("OP_CLI_OUTPUT=json makes JSON the output for the whole session", async () => {
  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  mockAgent
    .get("https://openproject.example")
    .intercept({ path: "/api/v3/users/me", method: "GET" })
    .reply(200, { id: 1, name: "Ada", login: "ada" })
    .times(2);

  const env = {
    OP_CLI_OUTPUT: "json",
    OPENPROJECT_URL: "https://openproject.example",
    OPENPROJECT_API_KEY: "key",
  };
  const result = await run(["auth", "status"], env, {});
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ user: { id: 1, name: "Ada" } });

  // The same command without the variable keeps the table shape.
  const table = await run(["auth", "status"], { ...env, OP_CLI_OUTPUT: undefined }, {});
  expect(table.stdout).toContain("PROFILE");
});

test("errors render as JSON under OP_CLI_OUTPUT=json without any flag", async () => {
  const configDir = await mkdtemp(join(tmpdir(), "op-cli-output-env-"));
  await writeFile(join(configDir, "config.json"), JSON.stringify({}));
  const env = { OP_CLI_OUTPUT: "json", OP_CLI_CONFIG_DIR: configDir };

  const result = await run(["wp", "list"], env, {});
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stderr).error.code).toBe("PROFILE_NOT_FOUND");

  // Without the variable the text form still carries the bracketed code.
  const text = await run(["wp", "list"], { ...env, OP_CLI_OUTPUT: undefined }, {});
  expect(text.stderr).toContain("[PROFILE_NOT_FOUND]");
});

test("the bulk stdin path keeps its own output contract under the variable", async () => {
  const env = {
    OP_CLI_OUTPUT: "json",
    OP_CLI_CONFIG_DIR: await mkdtemp(join(tmpdir(), "op-cli-output-env-")),
  };
  const result = await run(["wp", "create", "--stdin"], env, {
    readStdin: async () => "not-json",
  });
  // The forced --json would trip the explicit refusal; reaching the
  // stdin parse proves the bulk path was skipped by the environment.
  expect(result.stderr).toContain("stdin did not carry valid JSON");
});

test("a command-line parse error renders as JSON under the variable", async () => {
  const result = await run(["wp", "get"], { OP_CLI_OUTPUT: "json" }, {});
  expect(result.exitCode).toBe(1);
  // Text mode keeps replacing Commander's prose with the catalogue
  // line; JSON mode stays a single parseable object.
  expect(JSON.parse(result.stderr).error.code).toBe("USAGE_ERROR");

  // Without the variable the same mistake keeps the text form.
  const text = await run(["wp", "get"], {}, {});
  expect(text.stderr).toContain("[USAGE_ERROR]");
});
