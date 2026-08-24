import {
  listProfiles,
  removeProfile,
  requireStoredName,
  resolveProfile,
  parseOptionalId,
  saveProfile,
  setActiveProfile,
  LOGIN_PROFILE,
} from "./context/profile.js";
import { OpCliError, renderJsonError, renderTextError } from "./core/errors.js";
import { usageErrorFrom } from "./core/usage.js";
import { authenticate, bindRequestTimeout } from "./core/http.js";
import { renderProfilesTable, renderStatusTable } from "./output/table.js";
import { registerMetaCommands } from "./commands/meta.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerWpCommands } from "./commands/wp.js";
import { registerProjectCommands } from "./commands/project.js";
import { registerTimeCommands } from "./commands/time.js";
import { buildVersionOutput } from "./commands/version.js";

import { Command, CommanderError } from "commander";

export interface RunEnvironment {
  readonly [name: string]: string | undefined;
}

export interface RunIo {
  readonly prompt?: (message: string, secret: boolean) => Promise<string>;
  readonly stdinIsTTY?: boolean;
  /** Whole stdin as one string; only the --stdin paths touch it. */
  readonly readStdin?: () => Promise<string>;
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
  // Spec story 51: one environment variable makes JSON the output for
  // the whole session, errors included, instead of a flag per command.
  let jsonOutput = env.OP_CLI_OUTPUT === "json";

  // Keyed by the thrown error because Commander hands the failing command
  // to its own exit callback and to nobody else.
  const failedIn = new WeakMap<CommanderError, string>();

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
  if (env.OP_CLI_OUTPUT === "json") {
    program.hook("preAction", (_thisCommand, actionCommand) => {
      const options = actionCommand.opts();
      const declaresJson = actionCommand.options.some((option) => option.name() === "json");
      // The bulk stdin path is skipped: it already reports one NDJSON
      // line per item, and its explicit --json refusal must survive.
      if (declaresJson && options.json !== true && options.stdin !== true) {
        options.json = true;
      }
    });
  }
  const auth = program
    .command("auth")
    .description("Authenticate with an OpenProject instance");
  auth
    .command("login")
    .description("Verify and store OpenProject credentials")
    .option(
      "--profile <name>",
      'profile to create or update, defaults to "default"',
    )
    .option("--project <id>", "default project stored on the profile")
    .action(async (options: { profile?: string; project?: string }) => {
      if (!io.prompt || io.stdinIsTTY !== true) {
        throw new OpCliError(
          "USAGE_ERROR",
          "auth login requires an interactive terminal.",
          "set OPENPROJECT_URL and OPENPROJECT_API_KEY in the environment for non-interactive use.",
        );
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
      const profileName = options.profile ?? LOGIN_PROFILE;
      const project = parseOptionalId(options.project);
      const user = await authenticate(instanceUrl, apiKey);
      await saveProfile(env, instanceUrl, apiKey, profileName, project);
      stdout +=
        `Authenticated ${user.name} at ${instanceUrl} ` +
        `using profile ${profileName}.\n`;
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
    .option("--project <id>", "change the profile's default project")
    .action(async (profile: string, options: { project?: string }) => {
      await setActiveProfile(env, profile, {
        project: parseOptionalId(options.project),
      });
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
    ...(io.readStdin === undefined ? {} : { readStdin: io.readStdin }),
  });

  const project = program
    .command("project")
    .description("Inspect and manage projects");
  registerProjectCommands(project, {
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

  const time = program
    .command("time")
    .description("Track and inspect time entries");
  registerTimeCommands(time, {
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

  // Commands built declaratively start as standalone Command objects, so
  // they miss the root's exitOverride and output capture; without this
  // walk their --help would print to the real stdout and process.exit,
  // and the seam would never return.
  //
  // The walk also records which command refused the parse: Commander
  // throws from that command's own exitOverride, and nothing downstream
  // could name it afterwards.
  const captureHelp = (command: Command, path: string): void => {
    for (const child of command.commands) {
      const childPath = `${path} ${child.name()}`;
      child
        .exitOverride((error) => {
          failedIn.set(error, childPath);
          throw error;
        })
        .configureOutput({
          writeOut: (text) => {
            stdout += text;
          },
          writeErr: (text) => {
            stderr += text;
          },
        });
      captureHelp(child, childPath);
    }
  };
  captureHelp(program, program.name());

  try {
    // Environment misuse is refused before any command runs: a request
    // budget that silently fell back would hide the user's mistake.
    bindRequestTimeout(env);
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
      const usageError = usageErrorFrom(error, failedIn.get(error) ?? program.name());
      return {
        stdout,
        // Text mode replaces Commander's prose with the catalogue line,
        // as before; JSON mode must stay a single parseable object.
        stderr: jsonOutput
          ? renderJsonError(usageError)
          : renderTextError(usageError),
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
