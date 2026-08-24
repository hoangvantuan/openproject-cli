import type { CommanderError } from "commander";

import { OpCliError } from "./errors.js";

/**
 * The single-quoted token Commander puts in its own prose: the offending
 * flag, option declaration, argument name, or command.
 */
function quoted(detail: string): string | undefined {
  return /'([^']*)'/.exec(detail)?.[1];
}

/** Commander's suggestion tail, "(Did you mean --field?)", if it made one. */
function suggestion(message: string): string {
  const match = /\(Did you mean (.+)\?\)/.exec(message);
  return match === null ? "" : ` Did you mean ${match[1]}?`;
}

/** Commander's first prose line without its "error: " prefix. */
function detailOf(message: string): string {
  return (message.split("\n")[0] ?? "").replace(/^error:\s*/, "");
}

/**
 * Commander's prose, ended as a sentence and requoted: the catalogue
 * spells names in double quotes, and a message that mixes both reads as
 * two voices.
 */
function sentence(detail: string): string {
  const requoted = detail.replace(/'([^']*)'/g, '"$1"');
  return requoted.endsWith(".") ? requoted : `${requoted}.`;
}

/**
 * The catalogue line for a parse failure. Commander knows which flag,
 * argument, or command was refused and by whom; the code stays the
 * stable `USAGE_ERROR` while the wording carries those facts instead of
 * discarding them.
 */
export function usageErrorFrom(
  error: CommanderError,
  commandPath: string,
): OpCliError {
  const detail = detailOf(error.message);
  const named = quoted(detail);
  const hint = `run ${commandPath} --help to see what it accepts.`;
  const message = ((): string => {
    if (named === undefined) {
      return sentence(detail === "" ? "Invalid command usage" : detail);
    }
    switch (error.code) {
      case "commander.unknownOption":
        return `unknown option "${named}".${suggestion(error.message)}`;
      case "commander.unknownCommand":
        return `unknown command "${named}".${suggestion(error.message)}`;
      case "commander.missingMandatoryOptionValue":
        return `required option "${named}" is missing.`;
      case "commander.optionMissingArgument":
        return `option "${named}" needs a value.`;
      case "commander.missingArgument":
        return `missing required argument "${named}".`;
      default:
        return sentence(detail);
    }
  })();
  return new OpCliError("USAGE_ERROR", message, hint);
}
