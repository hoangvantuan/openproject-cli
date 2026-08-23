import { loadDefaultProfile, saveDefaultProfile } from "./context/profile.js";
import { OpCliError, renderJsonError, renderTextError } from "./core/errors.js";
import { authenticate } from "./core/http.js";
import { renderStatusTable } from "./output/table.js";

import { Command, CommanderError } from "commander";

export interface RunEnvironment {
  readonly [name: string]: string | undefined;
}

export interface RunIo {
  readonly prompt?: (message: string, secret: boolean) => Promise<string>;
  readonly isTTY?: boolean;
}

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export async function run(
  argv: readonly string[],
  env: RunEnvironment,
  io: RunIo,
): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  let jsonOutput = false;

  const program = new Command()
    .name("op-cli")
    .description("A resolving command-line client for OpenProject")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        stdout += text;
      },
      writeErr: (text) => {
        stderr += text;
      },
    });

  const auth = program
    .command("auth")
    .description("Authenticate with an OpenProject instance");
  auth
    .command("login")
    .description("Verify and store OpenProject credentials")
    .action(async () => {
      if (!io.prompt) {
        throw new OpCliError("USAGE_ERROR");
      }

      const enteredUrl = await io.prompt("Instance URL: ", false);
      const apiKey = await io.prompt("API key: ", true);
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(enteredUrl);
      } catch {
        throw new OpCliError("USAGE_ERROR");
      }
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new OpCliError("USAGE_ERROR");
      }
      const instanceUrl = parsedUrl.toString().replace(/\/$/, "");
      const user = await authenticate(instanceUrl, apiKey);
      await saveDefaultProfile(env, instanceUrl, apiKey);
      stdout +=
        `Authenticated ${user.name} at ${instanceUrl} ` +
        "using profile default.\n";
    });
  auth
    .command("status")
    .description("Show the active profile and authenticated user")
    .option("--json", "emit a JSON object")
    .action(async (options: { json?: boolean }) => {
      jsonOutput = options.json === true;
      const profile = await loadDefaultProfile(env);
      const user = await authenticate(profile.instanceUrl, profile.apiKey);
      if (options.json) {
        stdout += `${JSON.stringify({
          profile: profile.name,
          instance: profile.instanceUrl,
          user,
        })}\n`;
        return;
      }

      stdout += renderStatusTable({
        profile: profile.name,
        instance: profile.instanceUrl,
        user: user.name,
      });
    });

  try {
    await program.parseAsync([...argv], { from: "user" });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") {
      return { stdout, stderr, exitCode: 0 };
    }
    if (error instanceof CommanderError) {
      const usageError = new OpCliError("USAGE_ERROR");
      return {
        stdout,
        stderr: renderTextError(usageError),
        exitCode: usageError.exitCode,
      };
    }
    if (error instanceof OpCliError) {
      return {
        stdout,
        stderr: stderr + (jsonOutput ? renderJsonError(error) : renderTextError(error)),
        exitCode: error.exitCode,
      };
    }
    const internalError = new OpCliError("INTERNAL_ERROR");
    return {
      stdout,
      stderr:
        stderr +
        (jsonOutput
          ? renderJsonError(internalError)
          : renderTextError(internalError)),
      exitCode: internalError.exitCode,
    };
  }
}
