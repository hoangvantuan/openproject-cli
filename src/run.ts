import {
  listProfiles,
  removeProfile,
  requireStoredName,
  resolveProfile,
  parseOptionalId,
  saveDefaultProfile,
  setActiveProfile,
} from "./context/profile.js";
import { OpCliError, renderJsonError, renderTextError } from "./core/errors.js";
import { authenticate } from "./core/http.js";
import { renderProfilesTable, renderStatusTable } from "./output/table.js";
import { registerMetaCommands } from "./commands/meta.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerWpCommands } from "./commands/wp.js";
import { buildVersionOutput } from "./commands/version.js";

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
      const instanceUrl = parsedUrl.toString().replace(/\/+$/, "");
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
    .option("--profile <name>", "use this profile for this command only")
    .option("--project <id>", "override the profile default project")
    .action(async (options: { json?: boolean; profile?: string; project?: string }) => {
      jsonOutput = options.json === true;
      const profile = await resolveProfile(env, {
        profile: options.profile,
        project: parseOptionalId(options.project),
      });
      const user = await authenticate(profile.instanceUrl, profile.apiKey);
      if (options.json) {
        stdout += `${JSON.stringify({
          profile: profile.name,
          instance: profile.instanceUrl,
          project: profile.project ?? null,
          user,
        })}\n`;
        return;
      }

      stdout += renderStatusTable({
        profile: profile.name,
        instance: profile.instanceUrl,
        project: profile.project ?? null,
        user: user.name,
      });
    });

  auth
    .command("list")
    .description("List stored profiles and mark the active one")
    .option("--json", "emit a JSON object")
    .action(async (options: { json?: boolean }) => {
      jsonOutput = options.json === true;
      const list = await listProfiles(env);
      if (options.json) {
        stdout += `${JSON.stringify({
          active: list.activeName ?? null,
          profiles: list.profiles.map((profile) => ({
            name: profile.name,
            instance: profile.instanceUrl,
            project: profile.project ?? null,
          })),
        })}\n`;
        return;
      }

      stdout += renderProfilesTable(
        list.profiles.map((profile) => ({
          name: profile.name,
          instance: profile.instanceUrl,
          project: profile.project,
          active: profile.name === list.activeName,
        })),
      );
    });
  auth
    .command("use")
    .description("Set the active profile")
    .argument("<profile>")
    .action(async (profile: string) => {
      await setActiveProfile(env, profile);
      stdout += `Switched to profile ${profile}.\n`;
    });
  auth
    .command("logout")
    .description("Remove the stored credentials of a profile")
    .option("--profile <name>", "profile to log out of, defaults to the active one")
    .action(async (options: { profile?: string }) => {
      const target = options.profile ?? (await requireStoredName(env));
      await removeProfile(env, target);
      stdout += `Logged out of profile ${target}.\n`;
    });

  const meta = program
    .command("meta")
    .description("Inspect the stored metadata of the instance");
  registerMetaCommands(meta, {
    env,
    resolve: (overrides) => resolveProfile(env, overrides),
    write: (text) => {
      stdout += text;
    },
    setJsonMode: (on) => {
      jsonOutput = on;
    },
  });

  const wp = program
    .command("wp")
    .description("Inspect and manage work packages");
  registerWpCommands(wp, {
    env,
    resolve: (overrides) => resolveProfile(env, overrides),
    write: (text) => {
      stdout += text;
    },
    writeErr: (text) => {
      stderr += text;
    },
    setJsonMode: (on) => {
      jsonOutput = on;
    },
  });

  const doctor = program
    .command("doctor")
    .description("Diagnose connectivity, credentials, permissions, and versions");
  registerDoctorCommand(doctor, {
    resolve: (overrides) => resolveProfile(env, overrides),
    write: (text) => {
      stdout += text;
    },
    setJsonMode: (on) => {
      jsonOutput = on;
    },
  });

  // Registered lazily and only at the root so a subcommand can reuse
  // the "--version <value>" spelling as its own option (wp list).
  if (argv[0] === "--version") {
    program.version(await buildVersionOutput(env), "--version", "print version information");
  }

  try {
    await program.parseAsync([...argv], { from: "user" });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    if (
      error instanceof CommanderError
      && (error.code === "commander.helpDisplayed" || error.code === "commander.version")
    ) {
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
