import type { Command } from "commander";

import { OpCliError } from "./errors.js";

/**
 * OpenProject 17 renamed projects to workspaces in API v3 (#57). "Project"
 * stays the canonical term; "workspace" is accepted wherever "project"
 * is, with the same resolution (ADR-0005).
 */
const PROJECT_FLAG = "--project";
const WORKSPACE_FLAG = "--workspace";

/**
 * Give every command that declares --project a --workspace twin and fold
 * the twin into --project before the action runs, so no command reads
 * `options.workspace`. Passing both is fine when they name the same
 * project: equal strings, or different spellings (an id and a name) that
 * `sameProject` resolves to one project. Only a resolved difference, or a
 * spelling that cannot be resolved, is refused.
 *
 * Walks the finished tree rather than each declaration so a new command
 * with --project gets the alias without remembering it.
 */
export function installWorkspaceAlias(
  program: Command,
  onJsonMode: (on: boolean) => void,
  sameProject: (profile: string | undefined, first: string, second: string) => Promise<boolean>,
): void {
  const declare = (command: Command): void => {
    for (const child of command.commands) {
      declare(child);
    }
    if (command.options.some((option) => option.long === PROJECT_FLAG)) {
      command.option(`${WORKSPACE_FLAG} <name-or-id>`, `alias of ${PROJECT_FLAG}`);
    }
  };
  declare(program);
  program.hook("preAction", async (_root, actionCommand) => {
    const options = actionCommand.opts<{
      project?: string;
      workspace?: string;
      json?: boolean;
      profile?: string;
    }>();
    if (options.workspace === undefined) {
      return;
    }
    if (
      options.project !== undefined
      && options.project !== options.workspace
      && !(await sameProject(options.profile, options.project, options.workspace).catch(() => false))
    ) {
      // The action has not run yet, so it could not tell the error
      // renderer whether the caller asked for JSON.
      onJsonMode(options.json === true);
      throw new OpCliError(
        "USAGE_ERROR",
        `${PROJECT_FLAG} and ${WORKSPACE_FLAG} are the same option and disagree: `
          + `"${options.project}" vs "${options.workspace}".`,
        `pass only one of ${PROJECT_FLAG} or ${WORKSPACE_FLAG}.`,
      );
    }
    actionCommand.setOptionValue("project", options.workspace);
  });
}
