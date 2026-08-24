import {
  listProfiles,
  removeProfile,
  requireStoredName,
  resolveProfile,
  parseProjectOverride,
  saveProfile,
  setActiveProfile,
  LOGIN_PROFILE,
} from "./context/profile.js";
import { resolveProjectOverride } from "./context/projectref.js";
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
import { registerUpdateCommand, startVersionNotice } from "./commands/update.js";

import { Command, CommanderError } from "commander";

export interface RunEnvironment {
  readonly [name: string]: string | undefined;
}

export interface RunIo {
  readonly prompt?: (message: string, secret: boolean) => Promise<string>;
  readonly stdinIsTTY?: boolean;
  /** Whole stdin as one string; only the --stdin paths touch it. */
  readonly readStdin?: () => Promise<string>;
  /** Whether stderr is a terminal: the update notice only speaks to humans. */
  readonly stderrIsTTY?: boolean;
  /** Runs a command with the CLI's own streams; resolves its exit code. */
  readonly runExternal?: (file: string, args: readonly string[]) => Promise<number>;
  /** Runs a command and captures stdout; undefined on any failure. */
  readonly captureExternal?: (
    file: string,
    args: readonly string[],
  ) => Promise<string | undefined>;
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
  // The update command forwards the installer's own exit code; every
  // other success path stays 0.
  let forcedExitCode: number | undefined;

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
    .option("--project <name-or-id>", "default project stored on the profile")
    .action(async (options: { profile?: string; project?: string }) => {
      if (!io.prompt || io.stdinIsTTY !== true) {
        throw new OpCliError(
          "USAGE_ERROR",
          "auth login requires an interactive terminal.",
          "set OPENPROJECT_URL and OPENPROJECT_API_KEY in the environment for non-interactive use.",
        );
      }
      // Flag misuse is refused before the interactive prompt starts.
      const projectRef = parseProjectOverride(options.project);

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
      const user = await authenticate(instanceUrl, apiKey);
      let project = projectRef;
      if (typeof project === "string") {
        project = await resolveProjectOverride(instanceUrl, apiKey, project);
      }
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
    .option("--project <name-or-id>", "override the profile default project")
    .action(async (options: { json?: boolean; profile?: string; project?: string }) => {
      jsonOutput = options.json === true;
      const profile = await resolveProfile(env, {
        profile: options.profile,
        project: parseProjectOverride(options.project),
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
    .option("--project <name-or-id>", "change the profile's default project")
    .action(async (profile: string, options: { project?: string }) => {
      // A named project resolves against the target profile's own
      // instance so what gets stored is a numeric id, like every other
      // surface; ids and an absent flag never touch the network.
      let project = parseProjectOverride(options.project);
      if (typeof project === "string") {
        const target = await resolveProfile(env, { profile });
        project = await resolveProjectOverride(target.instanceUrl, target.apiKey, project);
      }
      await setActiveProfile(env, profile, { project });
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

  const update = program
    .command("update")
    .description("Update the CLI to the latest published release");
  registerUpdateCommand(update, {
    env,
    write: (text) => {
      stdout += text;
    },
    writeErr: (text) => {
      stderr += text;
    },
    setExitCode: (code) => {
      forcedExitCode = code;
    },
    ...(io.runExternal === undefined ? {} : { runExternal: io.runExternal }),
    ...(io.captureExternal === undefined ? {} : { captureExternal: io.captureExternal }),
  });

  // Registered lazily and only at the root so a subcommand can reuse
  // the "--version <value>" spelling as its own option (wp list); a
  // root-level version flag hijacks that filter. Root help still
  // advertises the invocation.
  if (argv[0] === "--version") {
    program.version(await buildVersionOutput(env), "--version", "print version information");
  }
  program.addHelpText(
    "after",
    "\nRun op-cli --version for version information.",
  );

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
    // Started before the parse so the registry lookup overlaps the
    // command itself; a slow registry then costs nothing extra.
    const versionNotice = startVersionNotice(argv, env, io);
    await program.parseAsync([...argv], { from: "user" });
    const noticeLine = await versionNotice;
    // The notice never mixes with a stderr that already spoke (a
    // truncation warning, a JSON error object): it stays quiet then.
    if (noticeLine !== undefined && stderr === "") {
      stderr += noticeLine;
    }
    return { stdout, stderr, exitCode: forcedExitCode ?? 0 };
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
